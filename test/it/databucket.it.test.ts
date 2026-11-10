/**
 * Runs against a real Databucket with the DEMO dataset (docker compose of databucket-server, project "Acme Shop").
 * Every row it creates carries `$.clientIt = <run id>` and is removed at the end.
 *
 * Settings (environment variables): DATABUCKET_URL (default http://databucket.localhost), DATABUCKET_PROJECT
 * (default "Acme Shop"), DATABUCKET_BUCKET (default dev-scheduler, a bucket with history).
 * Users demo-robot (ROBOT) and demo-member (MEMBER), password "test".
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Bucket,
  Change,
  Databucket,
  DatabucketError,
  Field,
  HistoryField,
  NewData,
  Rule,
  Rules,
  Sort,
} from '../../src/index.js';

const URL = process.env.DATABUCKET_URL || 'http://databucket.localhost';
const PROJECT = process.env.DATABUCKET_PROJECT || 'Acme Shop';
const BUCKET = process.env.DATABUCKET_BUCKET || 'dev-scheduler';
const RUN = randomUUID();

/** Properties of the test rows (undefined items are left out, so exists() / notExists() can be checked). */
interface Item {
  clientIt: string;
  name: string;
  status?: string | null;
  count?: number;
  labels?: string[] | null;
  tmp?: string;
}

const item = (name: string, status: string | null, count: number, labels: string[] | null = []): Item => {
  const i: Item = { clientIt: RUN, name, count };
  if (status !== null) i.status = status;
  if (labels !== null) i.labels = labels;
  return i;
};

const mine = (...more: Rule[]) => Rules.where(Rule.property('$.clientIt').eq(RUN), ...more);
const named = (name: string, ...more: Rule[]) => mine(Rule.property('$.name').eq(name), ...more);
const unique = (prefix: string) => `${prefix}-${randomUUID()}`;

const fails = async (call: () => Promise<unknown>): Promise<DatabucketError> => {
  try {
    await call();
  } catch (e) {
    expect(e).toBeInstanceOf(DatabucketError);
    return e as DatabucketError;
  }
  throw new Error('expected a DatabucketError');
};

let robot: Databucket;
let member: Databucket;
let items: Bucket<Item>;

const anyTagId = async (): Promise<number> => {
  // tags of the DEMO dataset are used by the rows of every bucket; take one from the data
  const row = await robot.bucket('dev-users').find(Rules.where(Rule.tagId().isNotNull())).first();
  return row!.tagId!;
};

beforeAll(() => {
  robot = new Databucket({ url: URL, username: 'demo-robot', password: 'test', project: PROJECT });
  member = new Databucket({ url: URL, username: 'demo-member', password: 'test', project: PROJECT });
  items = robot.bucket<Item>(BUCKET);
});

afterAll(async () => {
  if (items) await items.delete(mine());
});

describe('sign-in', () => {
  it('signs in to the project by name', async () => {
    expect((await robot.project())?.name).toBe(PROJECT);
  });

  it('signs in to the project by id', async () => {
    const id = (await robot.project())!.id;
    const byId = new Databucket({ url: URL, username: 'demo-robot', password: 'test', project: id });
    expect((await byId.project())?.name).toBe(PROJECT);
  });

  it('several projects without a choice fail', async () => {
    const noProject = new Databucket({ url: URL, username: 'demo-robot', password: 'test' });
    const e = await fails(() => noProject.token());
    expect(e.message).toContain('several projects');
  });

  it('a wrong password fails with 401', async () => {
    const wrong = new Databucket({ url: URL, username: 'demo-robot', password: 'wrong', project: PROJECT });
    expect((await fails(() => wrong.token())).status).toBe(401);
  });

  it('an unknown project fails', async () => {
    const wrong = new Databucket({ url: URL, username: 'demo-robot', password: 'test', project: 'No such project' });
    await fails(() => wrong.token());
  });

  it('an invalid token fails with 401', async () => {
    const wrong = new Databucket({ url: URL, token: 'not-a-token' });
    expect((await fails(() => wrong.bucket(BUCKET).count(Rules.ALL))).status).toBe(401);
  });

  it('an expired token is renewed', async () => {
    const client = new Databucket({ url: URL, username: 'demo-robot', password: 'test', project: PROJECT });
    await client.token();
    (client as any).currentToken = 'expired';
    expect(await client.bucket(BUCKET).count(Rules.ALL)).toBeGreaterThanOrEqual(0);
    expect(await client.token()).not.toBe('expired');
  });

  it('an unknown bucket is 404', async () => {
    expect((await fails(() => robot.bucket('no-such-bucket').count(Rules.ALL))).status).toBe(404);
  });
});

describe('insert and read', () => {
  it('insert, get and find', async () => {
    const row = await items.insert(item('insert-get', 'new', 1, ['a']));
    expect(row.id).toBeGreaterThan(0);
    expect(row.properties.name).toBe('insert-get');
    expect(row.reserved).toBe(false);
    expect(row.createdBy).toBe('demo-robot');
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(Number.isNaN(row.createdAt!.getTime())).toBe(false);

    const read = await items.get(row.id);
    expect(read?.properties.clientIt).toBe(RUN);
    expect(read?.properties.labels).toEqual(['a']);

    expect(await items.get(999_999_999)).toBeUndefined();
    expect(await items.get([row.id, 999_999_999])).toHaveLength(1);

    const found = await items.find(mine(Rule.property('$.name').eq('insert-get'))).first();
    expect(found?.id).toBe(row.id);
  });

  it('insert reserved with a tag', async () => {
    const tagId = await anyTagId();
    const row = await items.insert(NewData.of(item('reserved-insert', 'new', 1)).tagId(tagId).reserved(true));
    expect(row.reserved).toBe(true);
    expect(row.owner).toBe('demo-robot');
    expect(row.tagId).toBe(tagId);
  });

  it('insertAll and paging', async () => {
    const batch = unique('batch');
    await items.insertAll(Array.from({ length: 7 }, (_, i) => item(batch, 'paged', i + 1)));

    const rules = named(batch);
    expect(await items.count(rules)).toBe(7);
    expect(await items.find(rules).count()).toBe(7);

    const page2 = await items.find(rules).sort(Sort.desc('$.count')).limit(3).page(2).fetch();
    expect(page2.total).toBe(7);
    expect(page2.totalPages).toBe(3);
    expect(page2.rows.map((r) => r.properties.count)).toEqual([4, 3, 2]);

    const page3 = await items.find(rules).sort(Sort.desc('$.count')).limit(3).page(3).fetch();
    expect(page3.rows).toHaveLength(1);

    const beyond = await items.find(rules).limit(3).page(9).fetch();
    expect(beyond.rows).toHaveLength(0);
  });
});

describe('rules (API v2)', () => {
  it('rules', async () => {
    const group = unique('rules');
    await items.insert(item(group, 'active', 10, ['a', 'b', 'c']));
    await items.insert(item(group, 'active', 20));
    await items.insert({ ...item(group, null, 30, null), tmp: 'x' });
    const g = (...more: Rule[]) => named(group, ...more);

    expect(await items.count(g(Rule.property('$.status').eq('active')))).toBe(2);
    expect(await items.count(g(Rule.property('$.count').gt(15), Rule.property('$.count').lt(25)))).toBe(1);
    expect(await items.count(g(Rule.property('$.count').between(10, 20)))).toBe(2);
    expect(await items.count(g(Rule.property('$.count').in(10, 30)))).toBe(2);
    expect(await items.count(g(Rule.property('$.count').notIn([10, 30])))).toBe(1);
    expect(await items.count(g(Rule.property('$.name').like('rules-%')))).toBe(3);
    expect(await items.count(g(Rule.property('$.name').matchesIgnoreCase('^RULES-')))).toBe(3);
    expect(await items.count(g(Rule.property('$.status').isNull()))).toBe(1);
    expect(await items.count(g(Rule.property('$.status').isEmpty()))).toBe(1);
    expect(await items.count(g(Rule.property('$.status').isNotEmpty()))).toBe(2);
    expect(await items.count(g(Rule.property('$.tmp').exists()))).toBe(1);
    expect(await items.count(g(Rule.property('$.tmp').notExists()))).toBe(2);
    expect(await items.count(g(Rule.property('$.labels').length().gt(2)))).toBe(1);
    expect(await items.count(g(Rule.or(Rule.property('$.count').eq(10), Rule.property('$.count').eq(30))))).toBe(2);
    expect(await items.count(g(Rule.not(Rule.property('$.count').le(20))))).toBe(1);
    expect(await items.count(g(Rule.field(Field.CREATED_BY).eq(Rule.CURRENT_USER)))).toBe(3);
    expect(await items.count(g(Rule.owner().isNull()))).toBe(3);
    expect(await items.count(g(Rule.field(Field.CREATED_AT).gt(new Date(Date.now() - 3_600_000))))).toBe(3);
  });

  it('rules in the API format', async () => {
    const group = unique('format');
    await items.insert(item(group, 'active', 1));
    await items.insert(item(group, 'done', 2));
    const rules = Rules.fromRules([
      ['$.clientIt', '==', RUN],
      ['$.name', '==', group],
      { or: [['$.status', '==', 'done'], ['$.count', '>', 5]] },
    ]);
    expect(await items.count(rules)).toBe(1);
  });

  it('SQL text rules are refused in version 2', async () => {
    expect((await fails(() => items.count(Rules.fromRules(['$.count > 1'])))).status).toBe(400);
  });

  it('an unknown field is 400', async () => {
    expect((await fails(() => items.count(Rules.fromRules([['noSuchField', '==', 1]])))).status).toBe(400);
  });
});

describe('reserve', () => {
  it('reserve and release', async () => {
    const group = unique('reserve');
    for (let i = 0; i < 5; i++) await items.insert(item(group, 'free', i));
    const free = named(group);

    expect(await items.reserve(free).available()).toBe(5);

    const one = await items.reserve(free).one();
    expect(one?.reserved).toBe(true);
    expect(one?.owner).toBe('demo-robot');

    const two = await items.reserve(free).limit(2).sort(Sort.RANDOM).fetch();
    expect(two.rows).toHaveLength(2);
    expect(two.available).toBe(2);

    const rest = await items.reserve(free).limit(10).fetch();
    expect(rest.rows).toHaveLength(2);
    expect(rest.available).toBe(0);
    expect(await items.reserve(free).one()).toBeUndefined();

    expect(await items.release(one!.id)).toBe(1);
    const released = await items.get(one!.id);
    expect(released?.reserved).toBe(false);
    expect(released?.owner).toBeNull();
    expect(await items.reserve(free).available()).toBe(1);
  });

  it('parallel reservations never share a row', async () => {
    const group = unique('parallel');
    await items.insertAll(Array.from({ length: 20 }, (_, i) => item(group, 'free', i)));
    const free = named(group);

    // separate clients, as parallel test workers would have
    const clients = Array.from({ length: 8 }, () =>
      new Databucket({ url: URL, username: 'demo-robot', password: 'test', project: PROJECT }).bucket<Item>(BUCKET),
    );
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => clients[i % 8]!.reserve(free).one()));
    const ids = results.filter((r) => r !== undefined).map((r) => r!.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(20);
    expect(results.filter((r) => r === undefined)).toHaveLength(4);
  });
});

describe('modify and remove', () => {
  it('update by ids and rules', async () => {
    const row = await items.insert(item('update', 'new', 1));
    const row2 = await items.insert({ ...item('update', 'new', 1), tmp: 'remove me' });

    expect(await items.update(Change.create().set('$.status', 'used').remove('$.tmp'), row.id, row2.id)).toBe(2);
    const changed = await items.get(row2.id);
    expect(changed?.properties.status).toBe('used');
    expect(changed?.properties.tmp).toBeUndefined();

    const tagId = await anyTagId();
    expect(await items.update(named('update'), Change.create().tagId(tagId).set('$.count', 9))).toBe(2);
    const updated = await items.get(row.id);
    expect(updated?.tagId).toBe(tagId);
    expect(updated?.properties.count).toBe(9);

    await items.update(Change.create().properties(item('update-replaced', 'x', 0)), row.id);
    expect((await items.get(row.id))?.properties.name).toBe('update-replaced');
  });

  it('update and delete need rules', async () => {
    await expect(items.update(Rules.ALL, Change.create().set('$.a', 1))).rejects.toThrow(TypeError);
    await expect(items.delete(Rules.ALL)).rejects.toThrow(TypeError);
  });

  it('delete by ids and rules', async () => {
    const a = await items.insert(item('delete', 'x', 1));
    const b = await items.insert(item('delete', 'x', 2));
    await items.insert(item('delete', 'x', 3));
    expect(await items.delete(a.id)).toBe(1);
    expect(await items.get(a.id)).toBeUndefined();
    expect(await items.delete(a.id)).toBe(0);
    expect(await items.delete(named('delete'))).toBe(2);
    expect(await items.get(b.id)).toBeUndefined();
  });
});

describe('history', () => {
  it('history for a member', async () => {
    const row = await items.insert(item('history', 'new', 1));
    await items.update(Change.create().set('$.status', 'used'), row.id);
    expect(await items.reserve(mine(Rule.id().eq(row.id))).one()).toBeDefined();

    const asMember = member.bucket<Item>(BUCKET);
    const history = await asMember.history(row.id);
    expect(history).toHaveLength(3);
    expect(history[0]!.propertiesChanged).toBe(true);
    expect(history[1]!.propertiesChanged).toBe(true);
    expect(history[2]!.reserved).toBe(true);
    expect(history[2]!.modifiedBy).toBe('demo-robot');

    const versions = await asMember.historyProperties(row.id, history[0]!.id, history[1]!.id);
    expect(versions.get(history[0]!.id)?.status).toBe('new');
    expect(versions.get(history[1]!.id)?.status).toBe('used');

    expect(await asMember.clearHistory(row.id)).toBeGreaterThanOrEqual(2);
    expect((await asMember.history(row.id)).length).toBeLessThanOrEqual(1);
  });

  it('history for a robot', async () => {
    const row = await items.insert(item('history-robot', 'new', 1));
    await items.update(Change.create().set('$.status', 'used'), row.id);
    const history = await items.history(row.id);
    expect(history).toHaveLength(2);
    expect(history[0]!.dataId).toBe(row.id);
    expect(history[0]!.modifiedAt).toBeInstanceOf(Date);
    expect(await items.clearHistory(row.id)).toBe(2);
    expect(await items.history(row.id)).toHaveLength(0);

    expect((await fails(() => items.clearHistory(999_999_999))).status).toBe(404);
  });

  it('search history', async () => {
    const group = unique('search');
    const a = await items.insert(item(group, 'new', 1));
    const b = await items.insert(item(group, 'new', 2));
    await items.update(Change.create().set('$.status', 'used'), a.id);
    expect(await items.reserve(mine(Rule.id().eq(b.id))).one()).toBeDefined();
    const rows = named(group);

    // 2 inserts + 1 change + 1 reservation
    expect(await items.searchHistory(rows).count()).toBe(4);
    expect(await items.searchHistory(rows).where(Rule.field(HistoryField.RESERVED).eq(true)).count()).toBe(1);
    // "a": the insert and the change, both by the robot
    expect(
      await items
        .searchHistory(rows)
        .where(Rule.field(HistoryField.DATA_ID).eq(a.id), Rule.field(HistoryField.MODIFIED_BY).eq(Rule.CURRENT_USER))
        .count(),
    ).toBe(2);
    expect(await items.searchHistory(rows).where(Rule.field(HistoryField.MODIFIED_BY).eq('nobody')).count()).toBe(0);

    // rows by their current state: only "a" is used now
    expect(await items.searchHistory(named(group, Rule.property('$.status').eq('used'))).count()).toBe(2);

    const page = await items.searchHistory(rows).sort(Sort.desc(HistoryField.ID)).limit(3).withProperties().fetch();
    expect(page.total).toBe(4);
    expect(page.totalPages).toBe(2);
    expect(page.entries).toHaveLength(3);
    const newest = page.entries[0]!;
    expect(newest.dataId).toBe(b.id);
    expect(newest.reserved).toBe(true);
    const changed = page.entries.find((e) => e.dataId === a.id && e.propertiesChanged);
    expect(changed?.properties).not.toBeNull();

    const second = await items.searchHistory(rows).sort(Sort.desc(HistoryField.ID)).limit(3).page(2).list();
    expect(second).toHaveLength(1);
    expect(second[0]!.properties).toBeNull();

    expect((await fails(() => items.searchHistory(rows).where(Rule.property('$.status').eq('used')).count())).status).toBe(400);
  });
});

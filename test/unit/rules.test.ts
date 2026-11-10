import { describe, expect, it, vi } from 'vitest';
import { Change, Databucket, DatabucketError, Field, NewData, Rule, Rules, Sort } from '../../src/index.js';

const json = (rules: Rules) => JSON.stringify(rules.toBody());

describe('rules', () => {
  it('one rule is sent as logic without and', () => {
    expect(json(Rules.where(Rule.property('$.city').eq('Paris')))).toBe('{"logic":{"==":[{"var":"$.city"},"Paris"]}}');
  });

  it('a property without the prefix gets it', () => {
    expect(json(Rules.where(Rule.property('address.city').eq('Paris')))).toBe(
      '{"logic":{"==":[{"var":"$.address.city"},"Paris"]}}',
    );
  });

  it('several rules are combined with and', () => {
    expect(json(Rules.where(Rule.property('$.age').gt(30), Rule.tagId().in(1, 2)))).toBe(
      '{"logic":{"and":[{">":[{"var":"$.age"},30]},{"in":[{"var":"tagId"},[1,2]]}]}}',
    );
    expect(json(Rules.where([Rule.property('$.age').gt(30), Rule.tagId().in([1, 2])]))).toBe(
      '{"logic":{"and":[{">":[{"var":"$.age"},30]},{"in":[{"var":"tagId"},[1,2]]}]}}',
    );
  });

  it('groups, negation and null', () => {
    const rules = Rules.where(
      Rule.or(Rule.owner().isNull(), Rule.owner().eq(Rule.CURRENT_USER)),
      Rule.not(Rule.property('$.status').like('del%')),
    );
    expect(json(rules)).toBe(
      '{"logic":{"and":[{"or":[{"is":[{"var":"owner"},null]},{"==":[{"var":"owner"},"@currentUser"]}]},' +
        '{"!":{"like":[{"var":"$.status"},"del%"]}}]}}',
    );
  });

  it('between, empty and functions', () => {
    expect(json(Rules.where(Rule.property('$.n').between(1, 5)))).toBe('{"logic":{"<=":[1,{"var":"$.n"},5]}}');
    expect(json(Rules.where(Rule.property('$.email').isEmpty()))).toBe('{"logic":{"!":{"var":"$.email"}}}');
    expect(json(Rules.where(Rule.owner().isNotEmpty()))).toBe('{"logic":{"!!":{"var":"owner"}}}');
    expect(json(Rules.where(Rule.property('$.orders').length().gt(2)))).toBe(
      '{"logic":{">":[{"var":"$.orders.length()"},2]}}',
    );
    expect(json(Rules.where(Rule.property('$.tmp').exists()))).toBe('{"logic":{"==":[{"var":"$.tmp.exists()"},true]}}');
  });

  it('a Date is sent as ISO text', () => {
    expect(json(Rules.where(Rule.field(Field.CREATED_AT).gt(new Date('2026-01-02T03:04:05Z'))))).toBe(
      '{"logic":{">":[{"var":"createdAt"},"2026-01-02T03:04:05.000Z"]}}',
    );
  });

  it('functions only on properties', () => {
    expect(() => Rule.owner().exists()).toThrow(/only on a property/);
  });

  it('raw rules and logic pass through', () => {
    expect(json(Rules.fromRules([['$.city', '==', 'Paris']]))).toBe('{"rules":[["$.city","==","Paris"]]}');
    expect(json(Rules.fromLogic({ '==': [{ var: 'id' }, 1] }))).toBe('{"logic":{"==":[{"var":"id"},1]}}');
  });

  it('ALL is empty', () => {
    expect(Rules.ALL.isEmpty()).toBe(true);
    expect(Rules.where().isEmpty()).toBe(true);
    expect(json(Rules.ALL)).toBe('{}');
  });

  it('change body', () => {
    expect(JSON.stringify(Change.create().tagId(4).reserved(false).set('a.b', 1).remove('$.tmp').toBody())).toBe(
      '{"tagId":4,"reserved":false,"propertiesToSet":{"$.a.b":1},"propertiesToRemove":["$.tmp"]}',
    );
  });

  it('new data body', () => {
    expect(JSON.stringify(NewData.of({ a: 1 }).tagId(3).reserved(true).toBody())).toBe(
      '{"tagId":3,"reserved":true,"properties":{"a":1}}',
    );
  });

  it('sort', () => {
    expect(Sort.desc(Field.ID)).toBe('desc(id)');
    expect(Sort.asc('$.name')).toBe('asc($.name)');
  });
});

describe('client without a server', () => {
  const response = (status: number, body: unknown) =>
    new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('needs credentials and a url', () => {
    expect(() => new Databucket({ url: '' , token: 'x'})).toThrow(/url/);
    expect(() => new Databucket({ url: 'http://x' })).toThrow(/credentials/);
    expect(() => new Databucket({ url: 'http://x', username: 'a' })).toThrow(/both/);
  });

  it('signs in once for parallel calls, sends API version 2 and renews an expired token', async () => {
    let signIns = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/public/signin')) {
        signIns++;
        return response(200, { token: `t${signIns}`, project: { id: 7, name: 'P' } });
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers['Databucket-Api-Version']).toBe('2');
      if (headers.Authorization === 'Bearer t1' && u.includes('limit=0&renew')) return response(401, { message: 'expired' });
      return response(200, { total: 5 });
    });
    const db = new Databucket({ url: 'http://x/', username: 'u', password: 'p', fetch: fetchMock as typeof fetch });
    const bucket = db.bucket('b');
    const counts = await Promise.all([bucket.count(Rules.ALL), bucket.count(Rules.ALL), bucket.count(Rules.ALL)]);
    expect(counts).toEqual([5, 5, 5]);
    expect(signIns).toBe(1);
    expect(await db.project()).toEqual({ id: 7, name: 'P' });
    expect(fetchMock.mock.calls[1]![0]).toBe('http://x/api/bucket/b/get?limit=0');

    // an expired token: signs in again once
    const renewed = await (db as any).call('POST', '/api/bucket/b/get?limit=0&renew', {});
    expect(renewed.total).toBe(5);
    expect(signIns).toBe(2);
    expect(await db.token()).toBe('t2');
  });

  it('errors carry the status and the server message', async () => {
    const db = new Databucket({
      url: 'http://x',
      token: 't',
      fetch: (async () => response(404, { message: 'Bucket not found' })) as typeof fetch,
    });
    const error = await db.bucket('nope').count(Rules.ALL).catch((e) => e);
    expect(error).toBeInstanceOf(DatabucketError);
    expect(error.status).toBe(404);
    expect(error.message).toBe('404: Bucket not found (POST /api/bucket/nope/get)');
  });

  it('a connection failure is status 0', async () => {
    const db = new Databucket({
      url: 'http://x',
      token: 't',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const error = await db.bucket('b').count(Rules.ALL).catch((e) => e);
    expect(error).toBeInstanceOf(DatabucketError);
    expect(error.status).toBe(0);
    expect(error.message).toContain('fetch failed');
  });

  it('several projects without a choice fail with their names', async () => {
    const db = new Databucket({
      url: 'http://x',
      username: 'u',
      password: 'p',
      fetch: (async () => response(200, { projects: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] })) as typeof fetch,
    });
    await expect(db.token()).rejects.toThrow(/several projects.*A, B/);
  });

  it('update and delete need rules', async () => {
    const db = new Databucket({ url: 'http://x', token: 't' });
    await expect(db.bucket('b').update(Rules.ALL, Change.create().set('$.a', 1))).rejects.toThrow(TypeError);
    await expect(db.bucket('b').delete(Rules.ALL)).rejects.toThrow(TypeError);
  });
});

import { Change, NewData } from './change.js';
import type { Databucket } from './databucket.js';
import type { DataRow, HistoryEntry, HistoryPage, Page, Reservation } from './model.js';
import { DatabucketError } from './model.js';
import { Rules } from './rules.js';
import { HistorySearch, Query, Reserve } from './search.js';

/**
 * The data of one bucket. Get it with {@link Databucket.bucket}.
 * `T` is the type of the properties.
 */
export class Bucket<T> {
  private readonly path: string;

  /** @internal */
  constructor(
    private readonly databucket: Databucket,
    readonly name: string,
  ) {
    if (!name || !name.trim()) throw new TypeError('The bucket name is empty');
    this.path = `/api/bucket/${encodeURIComponent(name)}`;
  }

  // ---------------------------------------------------------------- insert

  /** Inserts a row (properties, or {@link NewData} with a tag or reserved) and returns it with its id. */
  async insert(data: T | NewData<T>): Promise<DataRow<T>> {
    return this.row(await this.databucket.call('POST', this.path, newData(data).toBody()));
  }

  /** Inserts many rows in one call (the rows are not returned; find them by rules). */
  async insertAll(data: Array<T | NewData<T>>): Promise<void> {
    if (data.length === 0) return;
    await this.databucket.call('POST', `${this.path}/multi`, data.map((d) => newData(d).toBody()));
  }

  // ---------------------------------------------------------------- read

  /** The row with the given id; undefined when it doesn't exist (or is not visible to the user). */
  get(id: number): Promise<DataRow<T> | undefined>;
  /** The rows with the given ids; missing ids are skipped. */
  get(ids: number[]): Promise<DataRow<T>[]>;
  async get(idOrIds: number | number[]): Promise<DataRow<T> | undefined | DataRow<T>[]> {
    if (!Array.isArray(idOrIds)) return (await this.get([idOrIds]))[0];
    if (idOrIds.length === 0) return [];
    // one existing row comes as an object, otherwise a list
    const json = await this.databucket.call('GET', `${this.path}/${idOrIds.join(',')}`);
    if (Array.isArray(json)) return this.rows(json);
    return json && typeof json === 'object' ? [this.row(json)] : [];
  }

  /** A search for rows matching the rules; see {@link Query}. */
  find(rules: Rules): Query<T> {
    return new Query(this, rules);
  }

  /** Number of rows matching the rules. */
  async count(rules: Rules): Promise<number> {
    const json = await this.databucket.call('POST', `${this.path}/get?limit=0`, rules.toBody());
    return Number(json?.total ?? 0);
  }

  /** @internal */
  async fetchPage(rules: Rules, page: number, limit: number, sort: string): Promise<Page<T>> {
    const json = await this.databucket.call(
      'POST',
      `${this.path}/get?page=${page}&limit=${limit}&sort=${encodeURIComponent(sort)}`,
      rules.toBody(),
    );
    return {
      rows: this.rows(json?.data),
      page: json?.page ?? page,
      limit: json?.limit ?? limit,
      total: Number(json?.total ?? 0),
      totalPages: json?.totalPages ?? 0,
    };
  }

  // ---------------------------------------------------------------- reserve

  /** A reservation of free rows matching the rules; see {@link Reserve}. */
  reserve(rules: Rules): Reserve<T> {
    return new Reserve(this, rules);
  }

  /** @internal */
  async reserveRows(rules: Rules, limit: number, sort: string, forUser: string | undefined): Promise<Reservation<T>> {
    const body: Record<string, unknown> = { ...rules.toBody() };
    if (forUser !== undefined) body.targetOwnerUsername = forUser;
    const json = await this.databucket.call(
      'POST',
      `${this.path}/reserve?limit=${limit}&sort=${encodeURIComponent(sort)}`,
      body,
    );
    return { rows: this.rows(json?.data), available: Number(json?.available ?? 0) };
  }

  /** Releases the rows (reserved = false); returns the number of changed rows. */
  release(...ids: number[]): Promise<number> {
    return this.update(Change.create().reserved(false), ...ids);
  }

  // ---------------------------------------------------------------- modify and remove

  /** Applies the change to the rows with the given ids; returns the number of changed rows. */
  update(change: Change, ...ids: number[]): Promise<number>;
  /** Applies the change to all rows matching the rules (at least one rule); returns the number of changed rows. */
  update(rules: Rules, change: Change): Promise<number>;
  async update(first: Change | Rules, ...rest: Array<number | Change>): Promise<number> {
    if (first instanceof Rules) {
      this.requireRules(first, 'modify');
      const change = rest[0];
      if (!(change instanceof Change)) throw new TypeError('update(rules, change): the change is missing');
      return count(await this.databucket.call('PUT', this.path, { ...change.toBody(), ...first.toBody() }));
    }
    const ids = rest as number[];
    if (ids.length === 0) return 0;
    return count(await this.databucket.call('PUT', `${this.path}/${ids.join(',')}`, first.toBody()));
  }

  /** Removes the rows with the given ids together with their history; returns the number of removed rows. */
  delete(...ids: number[]): Promise<number>;
  /** Removes all rows matching the rules (at least one rule) together with their history. */
  delete(rules: Rules): Promise<number>;
  async delete(...args: Array<number | Rules>): Promise<number> {
    const first = args[0];
    if (first instanceof Rules) {
      this.requireRules(first, 'remove');
      return count(await this.databucket.call('DELETE', this.path, first.toBody()));
    }
    if (args.length === 0) return 0;
    return count(await this.databucket.call('DELETE', `${this.path}/${args.join(',')}`));
  }

  // ---------------------------------------------------------------- history (buckets with history enabled)

  /** The changes of a row, oldest first. */
  async history(id: number): Promise<HistoryEntry<T>[]> {
    const json = await this.databucket.call('GET', `${this.path}/${id}/history`);
    return (Array.isArray(json) ? json : []).map((e: any) => ({
      id: Number(e.id),
      dataId: id,
      tagId: numberOrNull(e.tag_id),
      reserved: e.reserved ?? null,
      propertiesChanged: e.properties === true,
      properties: null,
      modifiedAt: date(e.modified_at),
      modifiedBy: e.modified_by ?? null,
    }));
  }

  /**
   * A search of the history of the rows matching the rules (by their current state; {@link Rules.ALL} for all
   * rows); see {@link HistorySearch}. Databucket 3.14.0+.
   */
  searchHistory(rows: Rules): HistorySearch<T> {
    return new HistorySearch(this, rows);
  }

  /** @internal */
  async searchHistoryPage(
    rows: Rules,
    entries: Rules,
    page: number,
    limit: number,
    sort: string,
    withProperties: boolean,
  ): Promise<HistoryPage<T>> {
    const body: Record<string, unknown> = { ...rows.toBody() };
    const e = entries.toBody();
    if (e.logic !== undefined) body.historyLogic = e.logic;
    if (e.rules !== undefined) body.historyRules = e.rules;
    const json = await this.databucket.call(
      'POST',
      `${this.path}/history/get?page=${page}&limit=${limit}&sort=${encodeURIComponent(sort)}` +
        (withProperties ? '&properties=true' : ''),
      body,
    );
    const list: any[] = Array.isArray(json?.history) ? json.history : [];
    return {
      entries: list.map((h) => ({
        id: Number(h.id),
        dataId: Number(h.dataId),
        tagId: numberOrNull(h.tagId),
        reserved: h.reserved ?? null,
        propertiesChanged: h.propertiesChanged === true,
        properties: this.properties(h.properties),
        modifiedAt: date(h.modifiedAt),
        modifiedBy: h.modifiedBy ?? null,
      })),
      page: json?.page ?? page,
      limit: json?.limit ?? limit,
      total: Number(json?.total ?? 0),
      totalPages: json?.totalPages ?? 0,
    };
  }

  /** The properties of a row as they were in the given history entries (by history entry id). */
  async historyProperties(id: number, ...historyIds: number[]): Promise<Map<number, T>> {
    const result = new Map<number, T>();
    if (historyIds.length === 0) return result;
    const json = await this.databucket.call('GET', `${this.path}/${id}/history/${historyIds.join(',')}`);
    for (const e of Array.isArray(json) ? json : []) result.set(Number(e.id), this.properties(e.properties) as T);
    return result;
  }

  /** Removes the history of a row (the row itself stays); returns the number of removed history entries. */
  clearHistory(id: number): Promise<number>;
  /** Removes the history of all rows matching the rules (at least one rule); returns the number of rows. */
  clearHistory(rules: Rules): Promise<number>;
  async clearHistory(idOrRules: number | Rules): Promise<number> {
    if (idOrRules instanceof Rules) {
      this.requireRules(idOrRules, 'clear the history of');
      return count(await this.databucket.call('DELETE', `${this.path}/history/clear`, idOrRules.toBody()));
    }
    return count(await this.databucket.call('DELETE', `${this.path}/${idOrRules}/history/clear`));
  }

  // ---------------------------------------------------------------- mapping

  private rows(array: unknown): DataRow<T>[] {
    return Array.isArray(array) ? array.map((item) => this.row(item)) : [];
  }

  private row(json: any): DataRow<T> {
    return {
      id: Number(json.id),
      tagId: numberOrNull(json.tagId),
      reserved: json.reserved === true,
      owner: json.owner ?? null,
      properties: this.properties(json.properties) as T,
      createdBy: json.createdBy ?? null,
      createdAt: date(json.createdAt),
      modifiedBy: json.modifiedBy ?? null,
      modifiedAt: date(json.modifiedAt),
    };
  }

  private properties(value: unknown): T | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      // stored as text by some endpoints
      try {
        return JSON.parse(value) as T;
      } catch (e) {
        throw new DatabucketError(0, `Can not read the properties: ${(e as Error).message}`, value);
      }
    }
    return value as T;
  }

  private requireRules(rules: Rules, action: string) {
    if (!rules || rules.isEmpty()) throw new TypeError(`Can not ${action} data without rules (bucket ${this.name})`);
  }

  toString(): string {
    return `Bucket{${this.name}}`;
  }
}

function newData<T>(data: T | NewData<T>): NewData<T> {
  return data instanceof NewData ? data : NewData.of(data);
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return new Date(value as string | number);
}

/** The number in a message such as "Modified 3 data row(s)". */
function count(json: any): number {
  const match = /\d+/.exec(String(json?.message ?? ''));
  return match ? Number(match[0]) : 0;
}

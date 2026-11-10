import type { Bucket } from './bucket.js';
import type { DataRow, HistoryEntry, HistoryPage, Page, Reservation } from './model.js';
import type { Rule } from './rule.js';
import { Rules } from './rules.js';

/**
 * A search for data rows; create it with {@link Bucket.find}.
 * ```ts
 * const page = await users.find(rules).sort(Sort.desc(Field.ID)).limit(20).page(2).fetch();
 * const rows = await users.find(rules).limit(100).list();
 * const row = await users.find(rules).first();
 * const count = await users.find(rules).count();
 * ```
 */
export class Query<T> {
  private _page = 1;
  private _limit = 1;
  private _sort = 'id';

  /** @internal */
  constructor(
    private readonly bucket: Bucket<T>,
    private readonly rules: Rules,
  ) {}

  /** Page number, starting from 1 (default 1). */
  page(page: number): this {
    if (!Number.isInteger(page) || page < 1) throw new RangeError('The page starts from 1');
    this._page = page;
    return this;
  }

  /** Rows per page (default 1). */
  limit(limit: number): this {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError('The limit must be at least 1; use count() to only count rows');
    this._limit = limit;
    return this;
  }

  /** Sort order, see {@link Sort} (default: by id). */
  sort(sort: string): this {
    this._sort = sort;
    return this;
  }

  fetch(): Promise<Page<T>> {
    return this.bucket.fetchPage(this.rules, this._page, this._limit, this._sort);
  }

  /** The rows of the page. */
  async list(): Promise<DataRow<T>[]> {
    return (await this.fetch()).rows;
  }

  /** The first matching row; undefined when none matches. */
  async first(): Promise<DataRow<T> | undefined> {
    return (await this.bucket.fetchPage(this.rules, 1, 1, this._sort)).rows[0];
  }

  /** Number of matching rows (no rows are transferred). */
  count(): Promise<number> {
    return this.bucket.count(this.rules);
  }
}

/**
 * A reservation of free data rows; create it with {@link Bucket.reserve}. Rows taken at the same moment by
 * another client are skipped, so parallel tests never get the same row.
 * ```ts
 * const user = await users.reserve(rules).one();
 * const r = await users.reserve(rules).limit(3).sort(Sort.RANDOM).fetch();
 * const free = await users.reserve(rules).available();
 * ```
 */
export class Reserve<T> {
  private _limit = 1;
  private _sort = 'id';
  private _forUser: string | undefined;

  /** @internal */
  constructor(
    private readonly bucket: Bucket<T>,
    private readonly rules: Rules,
  ) {}

  /** Number of rows to reserve (default 1). */
  limit(limit: number): this {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError('The limit must be at least 1; use available() to only count free rows');
    this._limit = limit;
    return this;
  }

  /** Which free rows are taken first, see {@link Sort} (default: by id). */
  sort(sort: string): this {
    this._sort = sort;
    return this;
  }

  /** Reserve for another user (ADMIN only; ignored for other roles). */
  forUser(username: string): this {
    this._forUser = username;
    return this;
  }

  fetch(): Promise<Reservation<T>> {
    return this.bucket.reserveRows(this.rules, this._limit, this._sort, this._forUser);
  }

  /** Reserves one row; undefined when no free row matches. */
  async one(): Promise<DataRow<T> | undefined> {
    return (await this.bucket.reserveRows(this.rules, 1, this._sort, this._forUser)).rows[0];
  }

  /** Number of free rows matching the rules; nothing is reserved. */
  async available(): Promise<number> {
    return (await this.bucket.reserveRows(this.rules, 0, this._sort, this._forUser)).available;
  }
}

/**
 * A search of the history of a bucket; create it with {@link Bucket.searchHistory} (Databucket 3.14.0+).
 * ```ts
 * // changes made by the nightly robot since yesterday, on the rows that are now in GB, newest first
 * const page = await users.searchHistory(Rules.where(Rule.property('$.address.country').eq('GB')))
 *   .where(Rule.field(HistoryField.MODIFIED_BY).eq('nightly-robot'),
 *          Rule.field(HistoryField.MODIFIED_AT).ge(new Date(Date.now() - 86_400_000)))
 *   .sort(Sort.desc(HistoryField.MODIFIED_AT))
 *   .limit(50)
 *   .fetch();
 * ```
 */
export class HistorySearch<T> {
  private readonly entries: Rule[] = [];
  private _page = 1;
  private _limit = 20;
  private _sort = 'id';
  private _properties = false;

  /** @internal */
  constructor(
    private readonly bucket: Bucket<T>,
    private readonly rows: Rules,
  ) {}

  /**
   * Which history entries (all must match): rules on {@link HistoryField}s, e.g.
   * `Rule.field(HistoryField.MODIFIED_BY).eq('john')`. The properties of the versions can't be searched.
   */
  where(...rules: Array<Rule | Rule[]>): this {
    this.entries.push(...rules.flat());
    return this;
  }

  /** Page number, starting from 1 (default 1). */
  page(page: number): this {
    if (!Number.isInteger(page) || page < 1) throw new RangeError('The page starts from 1');
    this._page = page;
    return this;
  }

  /** Entries per page, 1..1000 (default 20). */
  limit(limit: number): this {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new RangeError('The limit is 1..1000; use count() to only count entries');
    this._limit = limit;
    return this;
  }

  /** Sort order by a history field, e.g. `Sort.desc(HistoryField.MODIFIED_AT)` (default: by id). */
  sort(sort: string): this {
    this._sort = sort;
    return this;
  }

  /** Also the properties of each version (when they changed). */
  withProperties(): this {
    this._properties = true;
    return this;
  }

  fetch(): Promise<HistoryPage<T>> {
    return this.bucket.searchHistoryPage(this.rows, Rules.where(this.entries), this._page, this._limit, this._sort, this._properties);
  }

  /** The entries of the page. */
  async list(): Promise<HistoryEntry<T>[]> {
    return (await this.fetch()).entries;
  }

  /** Number of matching history entries. */
  async count(): Promise<number> {
    return (await this.bucket.searchHistoryPage(this.rows, Rules.where(this.entries), 1, 0, this._sort, false)).total;
  }
}

/** A data row. `T` is the type of the properties. */
export interface DataRow<T> {
  id: number;
  tagId: number | null;
  reserved: boolean;
  /** The user who reserved the row. */
  owner: string | null;
  properties: T;
  createdBy: string | null;
  createdAt: Date | null;
  modifiedBy: string | null;
  modifiedAt: Date | null;
}

/** A page of rows found by {@link Query.fetch}. */
export interface Page<T> {
  rows: DataRow<T>[];
  /** Page number, starting from 1. */
  page: number;
  limit: number;
  /** Number of all matching rows. */
  total: number;
  totalPages: number;
}

/** The result of {@link Reserve.fetch}. */
export interface Reservation<T> {
  /** The reserved rows (fewer than the limit when not enough free rows match). */
  rows: DataRow<T>[];
  /** Number of free rows matching the rules left after this reservation. */
  available: number;
}

/** One change of a data row. */
export interface HistoryEntry<T> {
  /** Id of the history entry. */
  id: number;
  /** Id of the data row. */
  dataId: number;
  /** The new tag, when it changed. */
  tagId: number | null;
  /** The new reserved state, when it changed. */
  reserved: boolean | null;
  propertiesChanged: boolean;
  /** The properties of this version (only {@link HistorySearch.withProperties}, when they changed). */
  properties: T | null;
  modifiedAt: Date | null;
  modifiedBy: string | null;
}

/** A page of history entries found by {@link HistorySearch.fetch}. */
export interface HistoryPage<T> {
  entries: HistoryEntry<T>[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** The project the client is signed in to. */
export interface Project {
  id: number;
  name: string;
}

/** An error returned by Databucket (HTTP status 4xx/5xx) or a failure to reach it. */
export class DatabucketError extends Error {
  /** HTTP status code, or 0 when there was no response (connection error, timeout) or the sign-in gave no token. */
  readonly status: number;
  /** Raw response body, if any. */
  readonly body: string | undefined;

  constructor(status: number, message: string, body?: string, options?: { cause?: unknown }) {
    super(status > 0 ? `${status}: ${message}` : message, options);
    this.name = 'DatabucketError';
    this.status = status;
    this.body = body;
  }
}

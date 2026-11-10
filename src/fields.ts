/** Fields of a data row that can be used in rules and sorting (besides properties such as `$.address.city`). */
export const Field = {
  ID: 'id',
  TAG_ID: 'tagId',
  OWNER: 'owner',
  RESERVED: 'reserved',
  CREATED_BY: 'createdBy',
  CREATED_AT: 'createdAt',
  MODIFIED_BY: 'modifiedBy',
  MODIFIED_AT: 'modifiedAt',
} as const;
export type Field = (typeof Field)[keyof typeof Field];

/** Fields of a history entry, for {@link HistorySearch.where} and sorting the history. */
export const HistoryField = {
  /** Id of the history entry. */
  ID: 'id',
  /** Id of the data row. */
  DATA_ID: 'dataId',
  TAG_ID: 'tagId',
  RESERVED: 'reserved',
  MODIFIED_BY: 'modifiedBy',
  MODIFIED_AT: 'modifiedAt',
} as const;
export type HistoryField = (typeof HistoryField)[keyof typeof HistoryField];

/**
 * Sort orders for {@link Query.sort}, {@link Reserve.sort} and {@link HistorySearch.sort}: a field or a property.
 * ```ts
 * Sort.asc('$.name'), Sort.desc(Field.ID), Sort.RANDOM
 * ```
 */
export const Sort = {
  /** Random order, e.g. to reserve a random row. */
  RANDOM: 'random',
  asc(fieldOrProperty: string): string {
    return `asc(${fieldOrProperty})`;
  },
  desc(fieldOrProperty: string): string {
    return `desc(${fieldOrProperty})`;
  },
} as const;

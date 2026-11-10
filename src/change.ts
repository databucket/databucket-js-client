/**
 * Changes to apply to data rows; items left out stay unchanged.
 * ```ts
 * Change.create().set('$.status', 'used').remove('$.tmp').tagId(4)
 * Change.create().reserved(false)       // release
 * Change.create().properties(newUser)   // replace all properties
 * ```
 */
export class Change {
  private _tagId?: number;
  private _reserved?: boolean;
  private _properties?: unknown;
  private readonly toSet: Record<string, unknown> = {};
  private readonly toRemove: string[] = [];

  private constructor() {}

  static create(): Change {
    return new Change();
  }

  tagId(tagId: number): this {
    this._tagId = tagId;
    return this;
  }

  /** true reserves the rows for the signed-in user (only rows that are not reserved yet are changed), false releases them. */
  reserved(reserved: boolean): this {
    this._reserved = reserved;
    return this;
  }

  /** Replaces all properties. */
  properties(properties: unknown): this {
    this._properties = properties;
    return this;
  }

  /** Sets one property, e.g. `set('$.address.city', 'Paris')` (the `$.` prefix may be left out). */
  set(path: string, value: unknown): this {
    this.toSet[propertyPath(path)] = value;
    return this;
  }

  /** Removes one property, e.g. `remove('$.tmp')`. */
  remove(path: string): this {
    this.toRemove.push(propertyPath(path));
    return this;
  }

  /** The request body. */
  toBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (this._tagId !== undefined) body.tagId = this._tagId;
    if (this._reserved !== undefined) body.reserved = this._reserved;
    if (this._properties !== undefined) body.properties = this._properties;
    if (Object.keys(this.toSet).length > 0) body.propertiesToSet = this.toSet;
    if (this.toRemove.length > 0) body.propertiesToRemove = this.toRemove;
    return body;
  }
}

/**
 * A new row with a tag or reserved, for {@link Bucket.insert} and {@link Bucket.insertAll}.
 * ```ts
 * NewData.of(user).tagId(3).reserved(true)
 * ```
 */
export class NewData<T> {
  private _tagId?: number;
  private _reserved?: boolean;

  private constructor(readonly properties: T) {}

  static of<T>(properties: T): NewData<T> {
    return new NewData(properties);
  }

  tagId(tagId: number): this {
    this._tagId = tagId;
    return this;
  }

  /** true: the row is reserved for the signed-in user. */
  reserved(reserved: boolean): this {
    this._reserved = reserved;
    return this;
  }

  /** The request body. */
  toBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (this._tagId !== undefined) body.tagId = this._tagId;
    if (this._reserved !== undefined) body.reserved = this._reserved;
    body.properties = this.properties;
    return body;
  }
}

function propertyPath(path: string): string {
  if (!path || !path.trim()) throw new TypeError('The property path is empty');
  return path.startsWith('$') ? path : `$.${path}`;
}

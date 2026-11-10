import type { Field, HistoryField } from './fields.js';

/** A JsonLogic expression, e.g. `{"==": [{"var": "$.city"}, "Paris"]}`. */
export type JsonLogic = Record<string, unknown>;

/**
 * A condition on data rows, built in code and sent to Databucket as JsonLogic (API version 2).
 * ```ts
 * Rule.property('$.address.city').eq('Paris')
 * Rule.tagId().in(1, 2)
 * Rule.or(Rule.owner().isNull(), Rule.owner().eq(Rule.CURRENT_USER))
 * Rule.property('$.orders').length().gt(2)
 * ```
 */
export class Rule {
  /** As a value: the signed-in user, e.g. `Rule.owner().eq(Rule.CURRENT_USER)`. */
  static readonly CURRENT_USER = '@currentUser';

  private constructor(private readonly logic: unknown) {}

  /** The JsonLogic expression of this rule. */
  toLogic(): unknown {
    return this.logic;
  }

  /** A property of the data, e.g. `$.address.city` (the `$.` prefix may be left out). */
  static property(path: string): Operand {
    if (!path || !path.trim()) throw new TypeError('The property path is empty');
    return new Operand(path.startsWith('$') ? path : `$.${path}`, true);
  }

  /** A field of a data row ({@link Field}) or of a history entry ({@link HistoryField}). */
  static field(field: Field | HistoryField): Operand {
    return new Operand(field, false);
  }

  static id(): Operand {
    return Rule.field('id');
  }

  static tagId(): Operand {
    return Rule.field('tagId');
  }

  static owner(): Operand {
    return Rule.field('owner');
  }

  static reserved(): Operand {
    return Rule.field('reserved');
  }

  static and(...rules: Array<Rule | Rule[]>): Rule {
    return Rule.group('and', rules.flat());
  }

  static or(...rules: Array<Rule | Rule[]>): Rule {
    return Rule.group('or', rules.flat());
  }

  static not(rule: Rule): Rule {
    return new Rule({ '!': rule.logic });
  }

  /** Any JsonLogic expression, e.g. copied from the rich filter. */
  static logic(jsonLogic: JsonLogic): Rule {
    return new Rule(jsonLogic);
  }

  /** @internal */
  static of(logic: unknown): Rule {
    return new Rule(logic);
  }

  private static group(operator: string, rules: Rule[]): Rule {
    return new Rule({ [operator]: rules.map((r) => r.logic) });
  }

  toString(): string {
    return JSON.stringify(this.logic);
  }
}

/** The left side of a rule: a field, a property or a property function. */
export class Operand {
  /** @internal */
  constructor(
    private readonly name: string,
    private readonly isProperty: boolean,
  ) {}

  private variable() {
    return { var: this.name };
  }

  private op(operator: string, ...args: unknown[]): Rule {
    return Rule.of({ [operator]: [this.variable(), ...args] });
  }

  eq(value: unknown): Rule {
    return this.op('==', value);
  }

  ne(value: unknown): Rule {
    return this.op('!=', value);
  }

  gt(value: unknown): Rule {
    return this.op('>', value);
  }

  ge(value: unknown): Rule {
    return this.op('>=', value);
  }

  lt(value: unknown): Rule {
    return this.op('<', value);
  }

  le(value: unknown): Rule {
    return this.op('<=', value);
  }

  /** from <= value <= to */
  between(from: unknown, to: unknown): Rule {
    return Rule.of({ '<=': [from, this.variable(), to] });
  }

  /** One of the values: `in(1, 2)` or `in([1, 2])`. */
  in(...values: unknown[]): Rule {
    return this.op('in', flatValues(values));
  }

  notIn(...values: unknown[]): Rule {
    return this.op('!in', flatValues(values));
  }

  /** SQL LIKE pattern: `%` any text, `_` one character. */
  like(pattern: string): Rule {
    return this.op('like', pattern);
  }

  notLike(pattern: string): Rule {
    return this.op('!like', pattern);
  }

  /** POSIX regular expression, case sensitive. */
  matches(regex: string): Rule {
    return this.op('~', regex);
  }

  /** POSIX regular expression, case insensitive. */
  matchesIgnoreCase(regex: string): Rule {
    return this.op('~*', regex);
  }

  notMatches(regex: string): Rule {
    return this.op('!~', regex);
  }

  isNull(): Rule {
    return this.op('is', null);
  }

  isNotNull(): Rule {
    return this.op('is not', null);
  }

  /** No value: null, missing or (for a property) an empty text. */
  isEmpty(): Rule {
    return Rule.of({ '!': this.variable() });
  }

  isNotEmpty(): Rule {
    return Rule.of({ '!!': this.variable() });
  }

  /** The property is present in the data (also when its value is null). */
  exists(): Rule {
    return this.fn('exists()').eq(true);
  }

  notExists(): Rule {
    return this.fn('notExists()').eq(true);
  }

  /** Number of items of an array property (0 when it is not an array). */
  length(): Operand {
    return this.fn('length()');
  }

  private fn(fn: string): Operand {
    if (!this.isProperty) throw new Error(`${fn} works only on a property, not on the field ${this.name}`);
    return new Operand(`${this.name}.${fn}`, false);
  }
}

function flatValues(values: unknown[]): unknown[] {
  return values.length === 1 && Array.isArray(values[0]) ? [...values[0]] : values;
}

import { Rule, type JsonLogic } from './rule.js';

/** The request body items for the rows: `logic` or `rules`. */
export interface RulesBody {
  logic?: unknown;
  rules?: unknown[];
}

/**
 * Which data rows a call works on.
 * ```ts
 * Rules.where(Rule.property('$.status').eq('active'), Rule.reserved().eq(false))  // all must match
 * Rules.ALL                                                                      // every row
 * Rules.fromRules([['$.status', '==', 'active']])                                // the API "rules" format
 * Rules.fromLogic(jsonLogic)                                                     // JsonLogic, e.g. from the rich filter
 * ```
 */
export class Rules {
  /** No conditions: every row (not accepted when modifying or removing data). */
  static readonly ALL = new Rules(undefined, undefined);

  private constructor(
    private readonly logic: unknown,
    private readonly rules: unknown[] | undefined,
  ) {}

  /** Rows matching all the rules: `where(r1, r2)` or `where([r1, r2])`. */
  static where(...rules: Array<Rule | Rule[]>): Rules {
    const list = rules.flat();
    if (list.length === 0) return Rules.ALL;
    if (list.length === 1) return new Rules(list[0]!.toLogic(), undefined);
    return new Rules(Rule.and(list).toLogic(), undefined);
  }

  /**
   * Rules in the API "rules" format, e.g. copied from the "API request" tab of the rich filter:
   * `[["$.city", "==", "Paris"], {"or": [["tagId", "in", [1, 2]], ["$.age", ">", 30]]}]`.
   *
   * Note: in this format a value that starts with `$` or equals a field name (e.g. "owner") is read as
   * a property or field, not as text. {@link Rules.where} has no such ambiguity.
   */
  static fromRules(rules: unknown[]): Rules {
    return new Rules(undefined, [...rules]);
  }

  /** A JsonLogic expression, e.g. `{"==": [{"var": "$.city"}, "Paris"]}`. */
  static fromLogic(logic: JsonLogic): Rules {
    return new Rules(logic, undefined);
  }

  /** True when there are no conditions (every row). */
  isEmpty(): boolean {
    return this.logic === undefined && (this.rules === undefined || this.rules.length === 0);
  }

  /** The request body items: `logic` or `rules`. */
  toBody(): RulesBody {
    if (this.logic !== undefined) return { logic: this.logic };
    if (this.rules !== undefined) return { rules: this.rules };
    return {};
  }

  toString(): string {
    return this.isEmpty() ? 'ALL' : JSON.stringify(this.toBody());
  }
}

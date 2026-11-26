import { describe, expect, it } from 'vitest';
import { Change, Databucket, DatabucketError, Rule, Rules } from '../../src/index.js';

/** A server that knows PATCH or not (Databucket before 3.26.0 answers 405), recording the calls. */
const server = (patch: 'known' | 'unknown' | number) => {
  const calls: string[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push(`${method} ${new URL(url).pathname}`);
    const status = method === 'PATCH' ? (patch === 'known' ? 200 : patch === 'unknown' ? 405 : patch) : 200;
    const message = status === 200 ? 'Modified 2 data row(s)' : `Request method '${method}' is not supported`;
    return new Response(JSON.stringify({ message }), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  const orders = new Databucket({ url: 'http://databucket.test', token: 't', fetch }).bucket('orders');
  return { calls, orders };
};

describe('changing data rows', () => {
  it('uses PATCH', async () => {
    const { calls, orders } = server('known');

    expect(await orders.update(Change.create().set('$.status', 'PAID'), 1, 2)).toBe(2);
    expect(await orders.update(Rules.where(Rule.id().gt(0)), Change.create().set('$.status', 'PAID'))).toBe(2);

    expect(calls).toEqual(['PATCH /api/bucket/orders/1,2', 'PATCH /api/bucket/orders']);
  });

  it('falls back to PUT on an older server and stays with it', async () => {
    const { calls, orders } = server('unknown');

    expect(await orders.update(Change.create().set('$.status', 'PAID'), 1, 2)).toBe(2);
    expect(await orders.update(Change.create().set('$.status', 'SHIPPED'), 1, 2)).toBe(2);

    expect(calls).toEqual(['PATCH /api/bucket/orders/1,2', 'PUT /api/bucket/orders/1,2', 'PUT /api/bucket/orders/1,2']);
  });

  it('does not retry other errors of PATCH', async () => {
    const { calls, orders } = server(406);

    const error = await orders.update(Change.create().set('$.status', 'PAID'), 1).catch((e) => e);

    expect(error).toBeInstanceOf(DatabucketError);
    expect((error as DatabucketError).status).toBe(406);
    expect(calls).toEqual(['PATCH /api/bucket/orders/1']);
  });
});

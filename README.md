# databucket-js-client

[![npm](https://img.shields.io/npm/v/@databucket/client)](https://www.npmjs.com/package/@databucket/client)

JavaScript / TypeScript client for [Databucket](https://github.com/databucket/databucket-server): find, reserve, change
and remove test data from your automated tests (Playwright, Cypress tasks, Jest, Vitest, scripts).

- Node.js 20.19+, no dependencies (the built-in `fetch`), TypeScript types included
- API version 2 of Databucket (3.13.0 or newer; history search and history for ROBOT accounts: 3.14.0)
- Sign-in with a password or with a token of your identity provider (SSO robot accounts, Databucket 3.10.0+);
  the token is renewed when it expires
- Parallel tests never reserve the same row

```
npm install --save-dev @databucket/client
```

The same features and version numbers as the [Java client](https://github.com/databucket/databucket-java-client).

## Quick start

```ts
import { Databucket, Rule, Rules, Change } from '@databucket/client';

const databucket = new Databucket({
  url: 'https://databucket.example.com',
  username: 'tests-robot',
  password: process.env.DATABUCKET_PASSWORD,
  project: 'Acme Shop', // by name or id; needed when the user has several projects
});

interface User {
  email: string;
  account: { status: string };
  address: { country: string };
}

const users = databucket.bucket<User>('dev-users');

// reserve one free active user for this test
const user = await users
  .reserve(Rules.where(
    Rule.property('$.account.status').eq('active'),
    Rule.property('$.address.country').in('GB', 'PL')))
  .one();
if (!user) throw new Error('No free active user');

// ... the test ...

await users.update(Change.create().set('$.account.status', 'suspended'), user.id);
await users.release(user.id);
```

## Playwright

A fixture that gives each test its own user and releases it afterwards, also when the test fails:

```ts
// fixtures.ts
import { test as base } from '@playwright/test';
import { Databucket, Rule, Rules, type DataRow } from '@databucket/client';

const databucket = new Databucket({
  url: process.env.DATABUCKET_URL!,
  username: 'tests-robot',
  password: process.env.DATABUCKET_PASSWORD,
  project: 'Acme Shop',
});
const users = databucket.bucket<User>('dev-users');

export const test = base.extend<{ user: DataRow<User> }>({
  user: async ({}, use) => {
    const user = await users.reserve(Rules.where(Rule.property('$.account.status').eq('active'))).one();
    if (!user) throw new Error('No free active user in dev-users');
    try {
      await use(user);
    } finally {
      await users.release(user.id);
    }
  },
});

// login.spec.ts
test('signs in', async ({ page, user }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.properties.email);
  // ...
});
```

## Rules

Rules are written in code and sent as JsonLogic, so values are never mistaken for fields or properties.

```ts
Rule.property('$.address.city').eq('Paris')         // also: ne, gt, ge, lt, le
Rule.property('$.age').between(18, 65)
Rule.tagId().in(1, 2)                                // or in([1, 2]); also: notIn
Rule.property('$.email').like('%@example.com')       // also: notLike, matches, matchesIgnoreCase, notMatches
Rule.owner().isNull()                                // also: isNotNull
Rule.property('$.phone').isEmpty()                   // null, missing or ""; also: isNotEmpty
Rule.property('$.tmp').exists()                      // also: notExists
Rule.property('$.orders').length().gt(2)             // items of an array
Rule.field(Field.CREATED_BY).eq(Rule.CURRENT_USER)   // the signed-in user
Rule.or(rule1, rule2), Rule.and(...), Rule.not(rule)

Rules.where(rule1, rule2)   // all must match; also Rules.where([rule1, rule2])
Rules.ALL                   // every row (not accepted for update / delete)
Rules.fromRules(list)       // the API "rules" format, e.g. copied from the "API request" tab of the rich filter
Rules.fromLogic(object)     // JsonLogic
```

Fields: `id`, `tagId`, `owner`, `reserved`, `createdBy`, `createdAt`, `modifiedBy`, `modifiedAt` (`Field`).
Dates can be given as `Date`; they are sent as ISO text, e.g. `new Date('2026-01-01T00:00:00Z')`.

## Operations

All operations return promises.

| Call | API |
|---|---|
| `insert(properties)`, `insert(NewData.of(p).tagId(3).reserved(true))` | `POST /api/bucket/{bucket}` |
| `insertAll([p1, p2, NewData.of(p3).tagId(3)])` | `POST /api/bucket/{bucket}/multi` |
| `get(id)` (`undefined` when missing), `get([id1, id2])` | `GET /api/bucket/{bucket}/{ids}` |
| `find(rules).sort(Sort.desc('$.name')).limit(20).page(2).fetch()` / `.list()` / `.first()` / `.count()`, `count(rules)` | `POST /api/bucket/{bucket}/get` |
| `reserve(rules).one()`, `.limit(3).sort(Sort.RANDOM).fetch()`, `.available()`, `.forUser('john')` (ADMIN) | `POST /api/bucket/{bucket}/reserve` |
| `update(change, ...ids)`, `update(rules, change)`, `release(...ids)` | `PUT /api/bucket/{bucket}[/{ids}]` |
| `delete(...ids)`, `delete(rules)` | `DELETE /api/bucket/{bucket}[/{ids}]` |
| `history(id)`, `historyProperties(id, ...historyIds)`, `clearHistory(id)`, `clearHistory(rules)` | `/api/bucket/{bucket}/{id}/history...` |
| `searchHistory(rows).where(...).sort(...).limit(50).withProperties().fetch()` / `.list()` / `.count()` | `POST /api/bucket/{bucket}/history/get` |

`update`, `release`, `delete` and `clearHistory` return the number of changed rows (or removed history entries).

## History

```ts
// changes made by the nightly robot since yesterday, on the rows that are now in GB, newest first
const page = await users
  .searchHistory(Rules.where(Rule.property('$.address.country').eq('GB')))
  .where(
    Rule.field(HistoryField.MODIFIED_BY).eq('nightly-robot'),
    Rule.field(HistoryField.MODIFIED_AT).ge(new Date(Date.now() - 24 * 3600 * 1000)))
  .sort(Sort.desc(HistoryField.MODIFIED_AT))
  .limit(50)
  .withProperties() // the properties of each version
  .fetch();
```

The rows are chosen by their current state (`Rules`), the entries by the fields of the history (`HistoryField`:
`ID`, `DATA_ID`, `TAG_ID`, `RESERVED`, `MODIFIED_BY`, `MODIFIED_AT`); the properties of past versions can't be searched.

Errors are thrown as `DatabucketError` with `status` (the HTTP status, 0 when there was no response) and the server's
message; `body` holds the raw response.

## Options

```ts
new Databucket({
  url: 'https://databucket.example.com',
  username: 'tests-robot', password,           // POST /api/public/signin
  // or: ssoToken: () => fetchTokenFromIdp(),  // POST /api/public/sso/token-exchange (client credentials of a ROBOT)
  // or: token: databucketToken,               // a token you already have (not renewed)
  project: 15,                                 // or 'Acme Shop'
  timeout: 10_000,                             // per request, ms (default 30 000)
  fetch: myFetch,                              // e.g. with a proxy (undici ProxyAgent)
  logger: console.debug,                       // a line per request
});
```

## Build

```
npm install
npm test           # unit tests
npm run test:it    # integration tests
npm run build
```

The integration tests need Databucket with the DEMO dataset, e.g. the docker compose of databucket-server
(http://databucket.localhost, project "Acme Shop", users `demo-robot` and `demo-member`); the history tests need
Databucket 3.14.0+. Change it with `DATABUCKET_URL`, `DATABUCKET_PROJECT`, `DATABUCKET_BUCKET`. They work only on rows
they create and remove them at the end.

Release to npm: `npm publish --access public` (runs the type check, unit tests and build first).

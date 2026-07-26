# Agent notes — math-mini

## Before pushing server changes that affect Docker / 云托管

Cloud pipeline runs **exactly**:

```bash
npm run build   # workspace server → tsc -p tsconfig.json
```

**Must pass locally before push:**

```bash
npm run predeploy   # test + tsc build
```

If `tsc` fails, the WeChat Cloud image build fails. Vitest passing alone is not enough.

## TypeScript rules that broke deploys before

- Every `async` method return type must be `Promise<T>`, not bare `T`.
- No `await` inside non-async `.map()` / `.forEach()` — use `for` or `Promise.all`.
- Do not reintroduce **deasync** with mysql2 (blocks event loop → query timeouts).
- Prefer fixing types cleanly; do not set `noEmitOnError: false` to hide errors.

## Architecture reminders

- DB: local SQLite for tests; cloud uses MySQL via `MYSQL_ADDRESS` / `MYSQL_USERNAME` / `MYSQL_PASSWORD` / `MYSQL_DATABASE`.
- Boot: listen on `PORT` (80) first, then open DB (`server/src/main/index.ts`).
- Mini program: `callContainer` with HTTPS fallback (`miniprogram/utils/request.js`).

See `docs/deploy.md` for full deploy checklist.

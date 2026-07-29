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
- Media: prefer 云托管对象存储 (`wx.cloud.uploadFile` → `cloud://` fileID); legacy `/uploads` + content API is fallback only.

## Logging is mandatory (排查优先)

**Every new feature, integration, or non-trivial change MUST include structured logs** so failures can be diagnosed without guessing. Silent swallow / silent fallback without logs is not allowed.

### Principles

1. **Fail loud in logs**: on error, log full diagnostic context (code, errMsg, status, path, env, ids). User-facing copy can stay short; console/server logs stay complete.
2. **No silent fallback**: if a preferred path fails (e.g. COS upload) and you keep a legacy path for later, either:
   - surface the failure to the user and log it, **or**
   - if fallback is intentional, log **both** the primary failure and that fallback was used (tag + reason).
3. **Key steps log success too** (at least `info`): start / ok / fail for network, upload, auth, pay-like flows — not only `catch`.
4. **Stable tags**: use dotted tags for grepping, e.g. `media.cloudUpload`, `http.401`, `auth.wechat`.

### Mini program (`miniprogram/`)

- Errors: always `logError(tag, err, extra)` from `utils/errors.js` (prints `[suanben]`).
- Flow traces: `console.info("[tag] …", payload)` / `console.error` for cloud APIs (`uploadFile`, `callContainer`, login).
- `extra` should include what you would ask in a bug report: `cloudEnv`, `path`, `method`, `statusCode`, `errCode`, `errMsg`, resource ids — **never** tokens/secrets/passwords.
- UI: `showError` for users; do not replace logging with toast alone.

### Server (`server/`)

- Boot / env probes: keep `console.log` / `console.warn` with clear prefixes (`[math-mini]`, `[AppError]`).
- Request handlers: log `AppError` / unexpected errors with `method`, `path`, `code`, `status` (already via `handleError` — do not remove).
- New integrations (COS, WeChat, external HTTP): log request outcome (ok / status / message), not only throw.
- Prefer structured one-line objects over multi-line stacks in happy path; stacks OK for unexpected 500s.

### What not to log

- Session tokens, `Authorization`, AppSecret, MySQL password, full base64 image bodies.
- PII beyond what is needed (openid only if essential for support; prefer userId).

### Review checklist (agents)

Before finishing a task, ask:

- [ ] Can I diagnose a production failure of this path from Console / 云托管日志 alone?
- [ ] Is every external call (HTTP, cloud, DB critical path) logged on failure?
- [ ] Is there a start/ok/fail breadcrumb for multi-step flows?

See `docs/deploy.md` for full deploy checklist.

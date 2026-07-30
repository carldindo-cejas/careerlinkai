# Deployment — CareerLinkAI

One Cloudflare Worker serves the entire application: the React SPA, its static assets, and the Hono
API. There is no Cloudflare Pages project, no second deployment, and no cross-origin hop between the
frontend and its backend.

```
careerlinkai.online          →  Worker script `careerlinkai-production`  (env.production)
├── /api/v1/*                →  Hono          — run_worker_first, always the Worker
├── /assets/*                →  static assets — immutable, 1 year (content-hashed names)
├── /logo.png, /favicon…     →  static assets — revalidated
└── everything else          →  index.html, HTTP 200 — React Router owns the path
```

---

## 1. How the routing works

Three lines in `backend/wrangler.toml` do all of it:

```toml
[assets]
directory = "../frontend/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*"]
```

**`not_found_handling`** — a request matching no asset gets `/index.html` with a **200**, so a hard
refresh on `/student/assessments` boots the app instead of 404ing. This replaced the Pages
`_redirects` rule `/*  /index.html  200`, which was deleted: Workers static assets implement only
true redirect statuses in `_redirects`, so a 200-status rewrite there does nothing at all.

**`run_worker_first`** — the line the whole design turns on. The asset router runs **before** the
Worker, so SPA fallback alone would answer `GET /api/v1/health` with the HTML shell. The API would
be unreachable from the address bar, from `curl`, and from any uptime check — while a loaded page's
client-side `fetch()` kept working perfectly. That combination is why this is enforced by a platform
gate (`npm run gate:platform`) in every profile that declares assets, rather than left to a comment.

The whole API lives under the §17 `/api/v1` mount, so this one pattern covers `/auth`, `/ai`,
`/admin`, `/counselor`, `/student` and the rest — they are `/api/v1/auth`, `/api/v1/ai`, … not
top-level paths.

Everything not matched by `run_worker_first` keeps the default asset-first path: a hashed JS chunk is
served from the edge without invoking — or billing — the Worker.

---

## 2. Environments

Staging and production are two Wrangler environments of the same Worker script, each with its **own**
D1, R2, Vectorize index, KV namespace and queue pair. Staging cannot write production data; that is
the entire point of having it.

| | local | staging | production |
|---|---|---|---|
| Script | `wrangler.local.toml` / `.dev.toml` | `careerlinkai-staging` | `careerlinkai-production` |
| Origin | `localhost:5173` (Vite) / `:8787` | `careerlinkai-staging.cejascarldindo.workers.dev` | `careerlinkai.online` |
| D1 | local (Miniflare) | `CareerLinkAI_Staging` | `CareerLinkAI_Main` |
| R2 | local | `careerlinkai-docs-staging` | `careerlinkai-docs` |
| Vectorize | absent / staging index | `careerlinkai_staging_knowledge` | `careerlinkai_main_knowledge` |
| Workers AI | absent / real | real | real |

Wrangler environments **inherit no bindings** — a binding omitted from an `[env.*]` block is not a
deploy error, it is `undefined` at runtime. Every binding, including `[assets]`, is therefore declared
explicitly per environment, and `npm run gate:platform` asserts the full set is present in all three
scopes. There are no hardcoded values and no secrets in committed config: every Cloudflare service is
reached through a binding, and anything else goes through `wrangler secret put NAME`.

`FRONTEND_URL` still exists per environment but no longer drives the frontend — the app calls the
relative `/api/v1` and cannot be pointed at the wrong backend. It now feeds only §41's CORS
allow-list, which describes a case that no longer arises in normal operation.

---

## 3. Local development

```bash
# Terminal 1 — the API
cd backend && npm run dev          # Worker on :8787, fully offline

# Terminal 2 — the app
cd frontend && npm run dev         # Vite on :5173 with HMR, proxying /api → :8787
```

Vite's proxy makes the browser see one origin, so the dev loop exercises the same request shape
production does: relative URL, no `Origin` header, no preflight, no CORS on either side.

For the **deployed** shape locally — real SPA fallback, real `run_worker_first`, real cache headers,
one port:

```bash
cd backend && npm run preview      # builds the frontend, serves everything on :8787
```

Use `npm run dev:remote` (backend) when you need real Workers AI and Vectorize; it points Vectorize at
the *staging* index, never production.

---

## 4. Deploying

### Staging

```bash
cd backend
npm run db:migrate:staging     # migrations FIRST, always — a Worker may not outrun its schema
npm run deploy:staging
```

Then run the fidelity gate. Miniflare enforces neither the PBKDF2 iteration ceiling nor the Worker
CPU limit and has no AI emulation, so a green suite proves the contract while only staging proves the
platform:

```bash
node scripts/bootstrap-staff.mjs --database CareerLinkAI_Staging --env staging \
  --verify-url https://careerlinkai-staging.cejascarldindo.workers.dev/api/v1

node scripts/walkthrough.mjs \
  --app https://careerlinkai-staging.cejascarldindo.workers.dev \
  --api https://careerlinkai-staging.cejascarldindo.workers.dev/api/v1 \
  --password '<temp password printed above>'
```

### Production

```bash
cd backend
npm run db:migrate:production
npm run deploy:production
```

`wrangler deploy` is the whole contract — `[build]` in `wrangler.toml` runs
`scripts/build-frontend.mjs` first, so the `dist/` that ships is always built from the commit being
deployed and never a stale local artifact. It requires `frontend/node_modules`; run `npm ci` in
`frontend/` on a fresh machine and the script will say so if you forget.

### Attaching the domain

`careerlinkai.online` and `www.careerlinkai.online` are attached to **`careerlinkai-production`**, and
the attachment is **declared in `wrangler.toml`** (`[[env.production.routes]]`, `custom_domain = true`)
rather than living only in the dashboard — so which script answers the live domain is a reviewable
fact that `wrangler deploy` re-asserts on every release.

**This was wrong in this file until the P3-1 cutover, and the correction is worth reading before the
next deploy.** Wrangler derives an environment's script name as `<name>-<env>`, so `--env production`
publishes `careerlinkai-production` — not `careerlinkai`. The domains had been attached to the bare
`careerlinkai` script back when production was a plain `wrangler deploy` with no environments, and
this file, `PRODUCTION_REQUIREMENTS.md` and `wrangler.toml` all recorded the two as one script.
Nothing caught it because `--env production` had never been run; the first run published a Worker no
domain pointed at while `careerlinkai.online` kept serving the April build. Step 8's health check is
what found it.

Overwriting the legacy script in place was tried and **refused by Cloudflare** — it holds live
`NotificationDO` Durable Objects, a class in no committed config and absent from the current
codebase, so its migration-tag state cannot be derived from this repository. The domains were moved
instead.

**The legacy `careerlinkai` script is still deployed, domain-less, as a rollback target.** It routes
nowhere. A `wrangler deploy` with **no** `--env` still targets it, using the top-level `[vars]` block
that declares `APP_ENV = "local"` against production's D1, R2, KV and queues — so that mistake now
publishes an unreachable script instead of putting a Worker that believes it is local onto the live
domain. Always deploy production through `npm run deploy:production`.

---

## 5. Rollback

Deployments are versioned, and the frontend ships inside the same version as the Worker, so a
rollback restores both halves atomically — there is no way to end up with a new SPA talking to an old
API.

```bash
cd backend
npx wrangler deployments list --env production          # find the last-good version id
npx wrangler rollback <version-id> --env production
```

Or re-deploy the previous commit: `git checkout <sha> && npm run deploy:production`.

**Database migrations do not roll back with the code.** D1 migrations are forward-only here, so treat
every migration as needing to be backward-compatible with the previously deployed Worker for at least
one release — add columns, do not rename or drop them in the same deploy that starts using the new
shape. If a rollback is needed *across* a destructive migration, the honest answer is restore from a
D1 point-in-time backup, not `wrangler rollback`.

That restore is now a procedure rather than a sentence — see **[`BACKUP-AND-RECOVERY.md`](BACKUP-AND-RECOVERY.md)**.
The short version, in the order you should try them:

```bash
cd backend
npx wrangler d1 time-travel restore CareerLinkAI_Main --env production --timestamp <ISO-8601>
#   ↑ in place, no dump, no downtime window, anything inside 30 days — try this first

npm run db:backup:production   # take one BEFORE every migration; the RPO is 24 h otherwise
```

**If a deploy fails mid-way:** Wrangler uploads assets and script together and switches atomically, so
a failed deploy leaves the previous version serving. Nothing is half-live.

---

## 6. Migration from the two-deployment setup

What changed, and what to do once:

| | Before | After |
|---|---|---|
| Frontend host | Pages: `careerlinkai-staging.pages.dev` | the Worker |
| API host | `*.workers.dev` / `careerlinkai.online` | the same Worker |
| Frontend deploy | `wrangler pages deploy dist` | none — part of `wrangler deploy` |
| API base URL | `VITE_API_BASE_URL`, absolute, per build mode | relative `/api/v1`, no config |
| Frontend builds | `build` + `build:staging` | one `build`, correct everywhere |
| SPA fallback | `public/_redirects` | `[assets] not_found_handling` |
| CORS | load-bearing on every request | not consulted (same-origin) |

Files: `frontend/.env`, `frontend/.env.staging` and `frontend/public/_redirects` were **deleted**;
`frontend/public/_headers` and `backend/scripts/build-frontend.mjs` were **added**.

**One-time cleanup, after production is verified green:**

1. Confirm `https://careerlinkai.online/api/v1/health` returns JSON with `"environment":"production"`
   — not HTML. This is the single check that proves `run_worker_first` took effect.
2. Delete the `careerlinkai-staging` **Pages** project in the Cloudflare dashboard (Workers & Pages →
   careerlinkai-staging → Settings → Delete). Leaving it costs nothing but keeps a second, stale copy
   of the app publicly reachable at `*.pages.dev`.
3. Remove any custom domain still pointed at the Pages project.

Nothing in the application code changed: no route, component, service, schema, migration, policy or
serializer was touched. `httpClient.ts` (one constant) and `app.ts` (CORS scoped to `/api/*`) are the
only source edits.

---

## 7. Post-deploy validation

Routing and caching — the things the consolidation could plausibly have broken:

```bash
BASE=https://careerlinkai.online

curl -s $BASE/api/v1/health                     # JSON, "environment":"production"
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' $BASE/student/assessments
                                                # 200 text/html  ← SPA fallback
curl -sI $BASE/assets/<hashed>.js | grep -i cache-control
                                                # public, max-age=31536000, immutable
curl -sI $BASE/ | grep -i cache-control         # public, max-age=0, must-revalidate
curl -s -H 'Accept-Encoding: br' -I $BASE/assets/<hashed>.js | grep -i content-encoding
                                                # br
```

Then the functional surface, in a browser, via `scripts/walkthrough.mjs`: staff login and forced
password change, student passwordless join, the assessment player, AI generation, the Workers AI
chatbot, file upload to R2, recommendations, and the admin/counselor/student dashboards. Hard-refresh
a nested route (`/admin/colleges/…`) to confirm the SPA fallback, and check DevTools → Network shows
**no CORS preflight** on any `/api/v1` call.

`wrangler tail --env production` streams live logs with the §52 correlation ids if anything needs
chasing.

---

## 8. Operational settings that live in the dashboard, not in this repository

Two things the code deliberately does not — and cannot — do for itself. Both are one-time setup on a
deployed environment, and neither shows a symptom when it is missing, which is why they are written
down rather than left as folklore.

### 8.1 A WAF rate-limiting rule for unauthenticated traffic (audit S2)

P3-4 put a coarse per-user budget (`API_RATE_LIMIT_PER_MINUTE`, 300/min, see
`src/middleware/rate-limit.ts`) on every **authenticated** request. That is the half a Worker can
enforce, because it needs a token to know whose budget to charge. It leaves anonymous traffic
uncovered by anything except the two credential-specific counters (`/auth/login`'s lockout,
`/student-access/join`'s throttle) — and an anonymous flood costs a Worker invocation each even when
it is refused.

The other half belongs at the edge, where a request is rejected before the Worker is invoked at all
and therefore costs no CPU and no invocation:

> **Cloudflare dashboard → Security → WAF → Rate limiting rules**
>
> * Expression: `(http.request.uri.path contains "/api/v1/")`
> * Characteristics: IP
> * Rate: ~600 requests / 1 minute · Action: Block · Duration: 10 minutes
>
> 600/min per IP, not 300: a whole computer lab shares one public IP, so this ceiling has to clear
> forty students answering an assessment together with room to spare. It is a flood stop, not a
> budget — the budget is the per-user one, which a shared IP cannot confuse.

Verify by looking at the rule's own request counter in the dashboard after a day of real traffic; if
it is blocking anything at all during a class, the number is too low.

### 8.2 A Workers Logs alert on dead-lettered jobs (plan P3-7)

A dead-lettered job now raises an in-app notification to every active administrator (see
`src/jobs/dlq-alert.ts`), which reaches whoever is signed in. The log line beside it is for whoever
is not:

```json
{ "level": "error", "alert": "dead_letter_queue", "queue": "careerlinkai-ai-dlq", … }
```

`alert` is a stable field written for **every** dead-lettered message, unthrottled — unlike the
notification, which is capped at one per queue per 15 minutes so a broken pipeline cannot bury the
bell. Filter on `alert = "dead_letter_queue"` in **Workers → Logs → Alerts** to get it out of the
app entirely (email, or a webhook).

Neither alert path can tell you *why* a job failed. That is the `Queue job failed.` line from the
source-queue consumer, three attempts earlier, which carries the error message and the correlation
id.

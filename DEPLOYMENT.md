# Deployment — CareerLinkAI

One Cloudflare Worker serves the entire application: the React SPA, its static assets, and the Hono
API. There is no Cloudflare Pages project, no second deployment, and no cross-origin hop between the
frontend and its backend.

```
careerlinkai.online          →  Worker script `careerlinkai`  (env.production)
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
| Script | `wrangler.local.toml` / `.dev.toml` | `careerlinkai-staging` | `careerlinkai` |
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

`careerlinkai.online` and `www.careerlinkai.online` are already attached to the `careerlinkai` script
as Cloudflare Workers Custom Domains (dashboard-managed). Nothing about the consolidation changes
that record — the same script name now answers HTML as well as JSON. **The one action item is
retiring the old Pages project** once production is verified (see §6).

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

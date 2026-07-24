# CareerLinkAI — Product & UI Audit

> **Purpose of this document.** A complete, pre-redesign inventory and evaluation of the
> CareerLinkAI **frontend** (`frontend/`, React 19 + Vite). It documents what exists — every
> page, flow, component, and interaction — and evaluates it. It does **not** propose a redesign;
> the only forward-looking section is §11 (*Prioritized redesign opportunities*), and even that
> is scoped to observations, not solutions.
>
> Scope note: this is a UI audit, so it covers the frontend surface. The Cloudflare Worker
> backend is referenced only where it shapes the UI (auth model, role gates, AI pipeline). For
> backend detail see `BACKENDAUDIT.md` and `FULLPLAN.md`.
>
> Audit date: 2026-07-23 · Frontend version `0.1.0`.

---

## Table of contents

1. [Overall architecture](#1-overall-architecture)
2. [Complete page inventory](#2-complete-page-inventory)
3. [User flows](#3-user-flows)
4. [UI component inventory](#4-ui-component-inventory)
5. [UX evaluation](#5-ux-evaluation)
6. [Functionality audit](#6-functionality-audit)
7. [Design-consistency report](#7-design-consistency-report)
8. [Page relationships & navigation map](#8-page-relationships--navigation-map)
9. [Accessibility report](#9-accessibility-report)
10. [Feature inventory](#10-feature-inventory)
11. [Prioritized redesign opportunities](#11-prioritized-redesign-opportunities)

---

## 1. Overall architecture

### 1.1 Application purpose

CareerLinkAI is a **career-guidance platform for Senior High School students** (built around the
Philippine DepEd context — *strands*, *general weighted average / GWA*, Grade 11–12). It:

- administers two validated career-interest instruments — **RIASEC** (Holland codes) and **SCCT**
  (Social Cognitive Career Theory);
- **scores them deterministically** (a published formula, never a model);
- produces **explainable program / career recommendations** grounded in a school's own academic
  catalog;
- uses **AI only to *draft* assessment questions and to *explain* recommendations — never to score
  or to rank.** This "humans keep the keys" principle is visible throughout the UI (per-mapping
  confirmation, "no AI decided any of it" copy, the AI-policy editor).

### 1.2 Target users & roles

| Role | How they sign in | What they do | Shell |
|---|---|---|---|
| **Student** | Passwordless — **class code + username** (`/join`) | Complete profile, take assessments, view results & recommendations, ask AI to "explain more" | `StudentLayout` |
| **Counselor** | Email + password (`/login`) | Create classes, provision rosters, assign assessments, view class results, reset attempts, build custom assessments | `CounselorLayout` |
| **Admin** | Email + password (`/admin-login`, **deliberately unlinked**) | Everything a counselor can do **plus** manage the academic catalog (colleges, programs, careers), AI knowledge base, AI policy, counselor accounts, and the audit log | `AdminLayout` (+ counselor shell) |

**Deliberate design stance — three separate sign-in doors.** `/login` is counselor-only,
`/admin-login` is admin-only and is linked from *nowhere* (admins type the URL), and `/join` is
student-only with no password field at all. Valid credentials presented at the wrong door are
refused and the freshly issued token is revoked client-side (`useLogin`). This is a
visibility/anti-confusion measure layered on top of real server-side authorization.

### 1.3 Tech stack (frontend)

| Concern | Choice |
|---|---|
| Framework | React 19 + TypeScript |
| Build | Vite 8 |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`), shadcn/ui-style hand-rolled primitives |
| Server state | TanStack Query v5 |
| Client state | Zustand v5 (with `persist`) |
| Forms | React Hook Form + Zod (`@hookform/resolvers`) |
| HTTP | Axios (single `httpClient` instance with interceptors) |
| Routing | React Router v7 (`<Routes>`/`<Route>` element API) |
| Icons | `lucide-react` |
| Animation | `framer-motion` (one `FadeIn` primitive only) |
| Document parsing | `pdfjs-dist` + `mammoth` (in-browser PDF/DOCX text extraction) |
| Font | Inter Variable (`@fontsource-variable/inter`) |
| Hosting | Cloudflare Pages |

### 1.4 Application structure

```
frontend/src/
├── app/            App.tsx · providers.tsx (QueryClient + BrowserRouter) · queryClient.ts
├── components/
│   ├── ui/         Design-system primitives (button, input, select, card, badge, alert, sheet,
│   │               label, textarea, skeleton, cn)
│   ├── charts/     BarList · ColumnChart · DonutChart · Meter · colors.ts (hand-rolled SVG/div)
│   ├── dashboard/  StatCard (shared KPI tile)
│   ├── brand/      Logo
│   └── motion/     FadeIn
├── features/       Feature-sliced: admin · assessment-builder · auth · counselor · landing ·
│                   notifications · student   (each has pages/ · components/ · hooks/)
├── layouts/        AppShell · AdminLayout · CounselorLayout · StudentLayout · StaffAuthLayout ·
│                   StudentAccessLayout
├── routes/         router.tsx · paths.ts · ProtectedRoute.tsx · RoleHome.tsx
├── services/       One typed API module per domain (authApi, classApi, rosterApi, catalogApi,
│                   assessmentApi, recommendationApi, aiApi, builderApi, platformApi,
│                   counselorManagementApi, studentAccessApi, notificationApi) + httpClient
├── stores/         authStore (token persisted, user not) · studentClassStore (joined class)
└── types/          Per-domain TypeScript types
```

**Architectural notes**

- **Feature-sliced**: each feature owns its pages, components, and hooks. Cross-cutting UI lives in
  `components/`. No component talks to the API directly — components → hooks → `services/*Api` →
  `httpClient`.
- **Auth model**: only the bearer **token** is persisted (localStorage `careerlinkai.auth`); the
  **user object is never persisted** — every cold load re-verifies against `GET /auth/me`
  (`useCurrentUser`). A 401 on any request clears the session globally (response interceptor).
- **Student class context** (`studentClassStore`, key `careerlinkai.student-class`) *is* persisted
  because Phase 1 has no "which class am I in?" endpoint. It is cleared on sign-out so a shared lab
  machine never leaks the previous student's class.
- **Query defaults**: `staleTime` 60 s, no refetch-on-focus, 4xx never retried (a rejected login
  won't fix itself and retrying burns the rate limit).

### 1.5 Design system (at a glance)

A **shadcn/ui-on-Tailwind-v4** convention: semantic tokens as CSS variables in `index.css`, mapped
to Tailwind color names via `@theme inline`. **Light theme only** for v1 (dark is a ratified
deferral).

- **Palette** (from the brand logo): `--primary` violet-700 `#6d28d9`, `--accent` teal-600
  `#0d9488`, `--sidebar` deep navy `#171338`, slate neutrals, `--destructive` red-600, `--ring`
  violet-500.
- **Radius**: `--radius` 0.75rem (lg), with md/sm derived.
- **Type**: Inter Variable, `text-rendering: optimizeLegibility`, antialiased.
- **Chart palette** (`charts/colors.ts`): a fixed, CVD-validated three-slot categorical set —
  violet / teal / amber — with the rule "never generate a fourth; fold into Other or a table."

> ⚠️ **The tokens exist but are inconsistently used.** See §7. Roughly every page mixes semantic
> tokens (`text-foreground`, `bg-primary`) with raw Tailwind slate scales (`text-slate-900`,
> `text-slate-500`). This is the single largest consistency debt in the codebase.

---

## 2. Complete page inventory

27 route-level page components across 5 groups. Legend for the compact tables:
**I/O** = inputs/outputs · **States** = which of loading / empty / error / success are handled.

### 2.1 Public & authentication

#### Landing — `LandingPage`
- **Route**: `/` · **User**: everyone (public) · **Layout**: self-contained (own nav/hero/footer)
- **Purpose**: The two-doors marketing page — students *join*, staff *sign in* — with live proof.
- **Sections**: sticky nav (Logo, "How it works", "Programs" anchors, Counselor Login, "Join your
  class"); hero (gradient headline, dual CTAs, art); "Three steps" (StepCards); "thesis-grade
  claims" (ValueCards — deterministic, cites-or-quiet, humans-keep-keys); **live Program browser**
  (`GET /programs/public` — real catalog, collapses if empty/failed); footer.
- **Notable**: if already signed in, the header swaps both CTAs for a single "Go to my dashboard"
  (role-aware via `homePathForRole`). Nothing here is mock copy — the program count is computed
  from the fetched catalog.
- **Charts/tables/forms**: none · **Buttons**: 2 hero CTAs + nav links · **States**: program
  browser silently hides on empty/error (by design).

#### Counselor Login — `LoginPage` → `CredentialsLoginForm`
- **Route**: `/login` · **User**: counselors · **Layout**: `StaffAuthLayout`
- **Inputs**: email, password (Zod-validated) · **Output**: token + user → role home.
- **Form**: RHF+Zod; inline field errors + a single general Alert for bad-credentials/locked/inactive/wrong-role.
- **Buttons**: "Sign in" (loading state), "Forgot your password?" link.
- **States**: error (Alert + field), loading (button). Redirects away if already authenticated.

#### Administrator Login — `AdminLoginPage` → `CredentialsLoginForm`
- **Route**: `/admin-login` (**unlinked** — reached only by typing the URL) · **User**: admins
- Same shared form as counselor login; `allow={['admin']}`, hides the forgot-password link
  (`showForgotPassword=false`), custom refusal message.

#### Forgot Password — `ForgotPasswordPage`
- **Route**: `/forgot-password` · **User**: staff · **Layout**: `StaffAuthLayout`
- **Purpose**: The honest, no-email-channel reset (deviation D7). Server acknowledges identically
  regardless of whether the email exists.
- **Two states**: (1) email form; (2) confirmation card. In **local dev** the confirmation surfaces
  the actual `reset_token` with a "Continue to reset" deep link; in staging/prod it instructs the
  user to contact an administrator.
- **Uses `httpClient` directly** (not a hook) with local `useState` for pending/problem — an
  exception to the hooks-only pattern.

#### Reset Password — `ResetPasswordPage`
- **Route**: `/reset-password` · reads `?email=&token=` query params · **User**: staff
- **Inputs**: email, reset code, new password (+confirm), Zod password policy (≥10, upper/lower/digit).
- **States**: success card ("every previous session signed out") / error Alert / field errors.
- Internal `Field` sub-component (label + input + error) — one of several **per-page bespoke field
  wrappers** (see §7.6).

#### Change Password (forced) — `ChangePasswordPage`
- **Route**: `/change-password` · **User**: any authenticated user with `must_change_password`
- **Purpose**: Temp-password rotation gate (§38). `ProtectedRoute` funnels such users here and
  blocks every other route until it's done.
- **Inputs**: current + new + confirm, mirrored server password policy. On success: local sign-out
  and re-auth required.

### 2.2 Student

#### Join your class — `StudentAccessPage`
- **Route**: `/join` · **Layout**: `StudentAccessLayout` (mirror of staff layout, form on the light
  panel, "Counselor? Log in here" footer link)
- **Inputs**: `class_code` (mono, uppercase, tracked), `username` (mono). **No password, no
  "forgot" link** — a student account has none, permanently.
- **Validation is deliberately thin**: the server answers every failed join with one identical 401
  (wrong code / expired / archived / unknown user / removed) so the endpoint can't be used to
  enumerate codes or rosters; client rules that pre-reject would leak the same information.
- **States**: general Alert (generic 401 / 429 throttle), field errors.

#### Student Dashboard — `StudentDashboardPage`
- **Route**: `/student` · **Purpose**: "what should I do next?" analytics landing.
- **Data**: `useAssignments`, `useResults`, `useProfile`, `useStudentDashboard`, `useMyRecommendations`.
- **Contains**:
  - Profile-completion **warning Alert** (names the consequence: "we need strand + GWA")
  - **KPI row** (4 `StatCard`s): Assessments, Completed, Results, Recommendations (Ready / —)
  - **"You have work to do"** action card + conditional "recommendations ready" callout
  - **Assessment progress** card: `DonutChart` (Completed/In progress/Not started) + `Meter`
  - **RIASEC profile** card: `BarList` (Holland dimensions, 0–100) or placeholder
  - **Match confidence** card: `ColumnChart` (score buckets) or placeholder
  - **Recent activity** list (last 5 scored)
- **States** (exemplary): explicit `assignmentsFailed` branch that is *visually distinct* from the
  empty state — this is the origin of **deviation D11** ("a failed load is not an empty one"),
  which recurs across the app. Charts show honest "No data yet" placeholders, never fake zeros.

#### My Profile — `StudentProfilePage`
- **Route**: `/student/profile` · **Purpose**: *an input form for the recommendation engine*, not a
  settings screen — and the copy says so.
- **Inputs**: Strand (**exactly 2 options** — Academic / Technical-Professional; the "STEM/HUMSS"
  tracks are deliberately *not* offered), Grade level (11/12), GWA + Math/Science/English grades
  (60–100 number fields).
- **Validation**: server-authoritative (field-level 422s rendered per field). Client uses
  `type=number min/max` only — **no Zod schema here** (inconsistent with other forms).
- **States**: loading text, hard **error refusal** (won't render an empty form on failed load — a
  form that discards unread data is "a data-loss bug wearing a UI"), success Alert ("Profile saved").

#### My Assessments — `AssessmentListPage`
- **Route**: `/student/assessments` · One unified list (RIASEC + SCCT + custom) — "a student thinks
  'what do I have to do', not in instrument categories."
- **Per card** (`AssignmentCard`): title, Done/In-progress `Badge`, description, question count ·
  duration · deadline, and a context button (**See my result** / **Continue** / **Start**).
- **States**: loading, D11 error Alert, gated empty state (`assignments &&` guards against undefined).
- **Also**: profile-nudge warning Alert that names the *specific* missing field(s).

#### Assessment Player — `AssessmentPlayerPage`
- **Route**: `/student/attempts/:attemptId` · The question-by-question runner.
- **Two deliberate silences**: never shows what a question *measures* or what an answer is *worth*
  (would let a student game the instrument). Section labels *are* shown as headings.
- **Interaction**: single-select option buttons (`aria-pressed`), **auto-advance** after 150 ms
  (a 60-item Likert with tap-then-Next would be 120 taps), Back / Skip, a live progress bar, an
  "answered / remaining" counter, and a submit gate shown from the start.
- **Resilience**: answers held in local `useState`, each answer fire-and-forgets a `POST`; resumes
  at the first unanswered question on reload; submit re-checks server-side.
- **States**: loading, load error Alert, "already submitted" info Alert (→ result), submit-error
  Alert, empty-questions info Alert.
- ⚠️ **Off-brand styling**: selected option is `bg-slate-900`, progress fill `bg-slate-900` — the
  core student flow is monochrome, not the brand violet/teal. (See §7.2.)

#### My Results (list) — `ResultListPage`
- **Route**: `/student/results` · Only **SCORED** attempts (one per assessment).
- **Per card**: title, Holland Code *or* SCCT summary sentence, **See breakdown** button.
- **States**: loading, D11 error Alert, empty card.

#### My Result (detail) — `ResultPage`
- **Route**: `/student/results/:attemptId` · "The breakdown *is* the result; the code is the headline."
- **Headline card**: RIASEC → big mono Holland code + top-3 interest names; SCCT → confidence
  sentence (rendered as-is, never parsed for a number).
- **Breakdown card**: `DimensionBar` per dimension (code, name, score/100, interpretation,
  description). Contains **no AI whatsoever** (a separate table from recommendations, by design).
- ⚠️ Bars are `bg-slate-800` — again off-brand and a *fourth* bespoke bar implementation (§7.5).

#### My Recommendations — `RecommendationPage`
- **Route**: `/student/recommendations` · Phase 4 + the one place AI speaks (Phase 5a).
- **Two separate ranked lists** — Careers and Programs — never interleaved (different formulas;
  comparing a 69.1 career to a 76.1 program would invent a comparison the engine never made).
- **Career card**: title + Holland `Badge`, description, computed `reason`, salary/outlook,
  **Explain more**. **Program card**: name + code `Badge`, college (a real join), reason,
  recommended strand, **Explain more**. `MatchScore` = big % + rank badge ("Best match" / #n).
- **"Explain more"** (`ExplainMore`): calls the model on demand; renders the explanation in a tinted
  block with an "AI-generated… the scores above are computed, not AI" caption; a null/failed
  response is **not an error state** — it keeps the deterministic reason and says so.
- **States**: loading, D11 error, three-way empty ("finish both assessments").

### 2.3 Counselor

#### Counselor Dashboard — `CounselorDashboardPage`
- **Route**: `/counselor` · "Caseload at a glance," live from domain tables.
- **Header**: greeting + **quick actions** (New class → classes page; Assessments → templates).
- **KPI row**: Classes, Students, Active assignments, With recommendations.
- **Charts**: Completion `DonutChart` + `Meter`; Scored-attempts-by-class `BarList`; Recommendation
  coverage `Meter`.
- **Your classes table** (Class / Students / Active assignments / Scored attempts, rows link to
  detail) *or* a "No classes yet" card.
- **Recent activity**: reuses the notification feed (so bell and dashboard never disagree).
- **States**: loading text, error Alert, per-widget placeholders.

#### Classes (list) — `ClassListPage`
- **Route**: `/counselor/classes` · Grid of `ClassCard`s.
- **Inline create**: "New class" toggles `CreateClassForm` in place; on success navigates straight
  to the new class detail (where the code lives).
- **`ClassCard`**: name (link), status `Badge` (active=success/draft=warning/archived=neutral),
  academic year · grade, **class code** (mono), Roster link.
- **States**: `Loader2` spinner (role=status), error Alert, empty card.

#### Class Detail — `ClassDetailPage`
- **Route**: `/counselor/classes/:classId` · The counselor's whole workflow, top-to-bottom.
- **Composes 5 panels** in workflow order: `JoinCodeCard` → `RosterBuilder` → `RosterTable` →
  `AssignmentPanel` → `ClassResultsPanel`. Plus a back-link, title + status badge, and a transient
  "Enrolled N students" success banner.
- **States**: spinner, error Alert (with back-link preserved).

### 2.4 Admin

#### Admin Dashboard — `AdminDashboardPage`
- **Route**: `/admin` · The §54 minimum metric set, live.
- **KPI row**: Students, Counselors (→ mgmt), Colleges·Programs (→ catalog), Careers (→ careers).
- **Three metric cards**: Assessments (published versions, in-progress/scored/completion-rate);
  **Student access · 7 days** (successful joins / failed / throttled — the passwordless model's
  health signal); **AI · 7 days** (requests / failed / tokens / avg latency).
- **Recent activity**: newest audit rows (action `Badge`, actor, time) → link to full audit log.
- **States**: loading text, error Alert, empty activity line.
- **Note**: uses `MetricRow` label/value pairs, *not* charts — an intentional "KPI not chart" call,
  though it means the admin dashboard is visually plainer than the counselor/student ones.

#### Colleges (list) — `CollegeListPage`
- **Route**: `/admin/colleges` · Grid of `CollegeCard`s; inline "Add college" (`CollegeForm`);
  on create → college detail. Status `Badge`, program count link. Spinner/error/empty handled.

#### College Detail — `CollegeDetailPage`
- **Route**: `/admin/colleges/:collegeId` · Manage one college + its programs + career mappings.
- **Header actions**: Archive/Restore (the intended retire path — preserves references) and
  **Delete** (harsher; uses **`window.confirm`**).
- **Programs**: inline add/edit (`ProgramForm`), per-program `ProgramCard` with status badge,
  edit/delete (**`window.confirm`**), and an embedded **`CareerMapping`** (link/unlink careers).
- **States**: spinner, error Alert, empty card.
- ⚠️ Uses **native `window.confirm`** for both destructive actions — inconsistent with the inline
  two-step confirmations used everywhere else (§7.4).

#### Careers (list) — `CareerListPage`
- **Route**: `/admin/careers` · Global careers (not nested under colleges). Inline add/edit
  (`CareerForm`), per-row Archive/Restore, edit, **delete via `window.confirm`**.
- **`CareerRow`**: title, RIASEC code chip (with Holland-code tooltip via `title`) *or* an explicit
  "No RIASEC code — cannot be matched" note, status badge, outlook/salary line.

#### Knowledge documents — `KnowledgeListPage`
- **Route**: `/admin/knowledge` · The RAG knowledge base (Phase 5a).
- **Upload card**: native file input (`.pdf,.docx`, ≤10 MB); **text is extracted in-browser**
  (`extractText`, pdfjs/mammoth) *before* upload — the Free-plan Worker has nowhere to run a parser.
- **`DocumentRow`**: file name, type badge, status badge (Queued/Processing/**Ready**/Failed or
  Archived), upload time · chunk count; **Reprocess** (only when FAILED) and **Archive** buttons.
- **States**: extracting / uploading text, problem Alert, list loading/error, empty card.

#### AI Policy — `AiPolicyPage`
- **Route**: `/admin/ai-policy` · Edits the single seeded GLOBAL policy row (no create/delete).
- **`PolicyEditor`**: two textareas (**Instructions**, **Restrictions**) injected verbatim into
  every prompt; Active/Inactive toggle; Save. Inline "Saved" confirmation + error Alert.
- **Edge state**: if no policy row exists, an Alert instructs running the seeder (never created over
  HTTP).

#### Counselors — `CounselorManagementPage`
- **Route**: `/admin/counselors` · Manage counselor accounts.
- **Create** (`CreateCounselorCard`): first/last name, email, optional specialization — **no
  password field**; the server generates a temp password shown **exactly once** in a warning banner
  with a Copy button ("shared securely now — cannot be retrieved").
- **Search** (name/email, submit-to-apply + Clear), **`CounselorRow`** (name, status badge,
  "awaiting first sign-in" badge, email, class/student counts, Suspend/Reactivate, two-step Remove),
  and **Prev/Next pagination**.
- **States**: loading, error, empty (search-aware copy).

#### Audit Log — `AuditLogPage`
- **Route**: `/admin/audit-log` · Append-only critical-action record; the *only* place failed
  student joins reveal their real reason.
- **Filter** (action prefix, submit-to-apply + Clear), a **table** (When / Action / Actor / Module /
  Details), expandable **Before/After JSON** rows + IP, tone-coded action badges
  (FAILED/THROTTLED/DELETED→warning, SUCCESS/PUBLISHED→success), **Prev/Next pagination**.
- **States**: loading, error, filter-aware empty card.

### 2.5 Assessment builder (shared: admin + counselor)

Same two pages mount under both `/admin/assessment-templates*` and
`/counselor/assessment-templates*`; base path is derived from `location.pathname`.

#### Template list — `TemplateListPage`
- **Purpose**: list instruments + create CUSTOM templates.
- **Create card**: title input → creates a template → navigates to builder.
- **Per template `Card`**: title, category badge, Private badge (if counselor-owned),
  published/"no published version" badge, and **Open builder** — *except* RIASEC/SCCT, which are
  curated (`ai_generatable:false`) and show "Curated instrument" instead.
- **States**: create loading/error, list loading/error (with Retry).

#### Template builder — `TemplateBuilderPage`
- **Purpose**: the whole §31 authoring flow on one page.
- **`DimensionsCard`**: add code+name dimensions; **freeze permanently** once any version publishes.
- **`VersionsCard`**: version pills (`v1 · DRAFT`), New version. Selecting one mounts a workspace.
- **`VersionWorkspace`** (DRAFT only shows editors):
  - **`GeneratePanel`** — two AI entry modes: *from a description* (≥20 chars) and *from a
    document* (in-browser extraction → queue); polls generation status
    (Generating / Drafted N questions + suggested dimensions / Failed).
  - **`ReviewCard`** / **`QuestionRow`** — every question with its options+scores; source badge (AI
    draft / Manual); inline edit; **per-mapping Confirm** (one button per dimension mapping — **no
    "approve all," by design**: the §25 gate's whole point is a human looked at each).
  - **`ManualQuestionCard`** — hand-typed 5-point Likert item (confirmed at insert), free-text
    dimension code.
  - **`PublishCard`** — blocked until every mapping confirmed and ≥1 question; shows readiness
    ("N of M mappings still need confirmation"); success note.
- **States**: template loading/error, version loading/error, per-action error Alerts, publish
  success.

---

## 3. User flows

Notation: **▶ start** · → step · **✔ end**. Each flow lists where the user starts, the actions, and
where they land.

### 3.1 Student — passwordless access → recommendation (the primary journey)

```
▶ Landing (/) or direct /join
   → "Join with a class code" → /join
   → enter class code + username → POST /student/access/join
     ├─ fail → generic 401 Alert (same message for every cause) ↺ retry
     └─ success → token stored + class cached → /student
   → Dashboard shows profile-completion WARNING (strand + GWA needed)
   → "Complete your profile" → /student/profile → save strand/GWA/grades ✔ saved
   → /student/assessments → "Start" RIASEC → /student/attempts/:id
   → answer 60 items (auto-advance, resume-safe) → "Submit assessment"
   → /student/results/:id  (Holland code + dimension breakdown)  ✔
   → repeat for SCCT
   → once BOTH scored + profile complete → Dashboard "recommendations ready"
   → /student/recommendations → ranked Careers + Programs
   → "Explain more" on any card → AI explanation (or graceful fallback)  ✔
```

### 3.2 Counselor — class creation → roster → assignment → results

```
▶ /login (email + password) → /counselor
   → "New class" → /counselor/classes → CreateClassForm → /counselor/classes/:id
   → JoinCodeCard: read out / Copy the code (regenerate = two-step revocation warning)
   → RosterBuilder: paste names → "Generate usernames" (preview, nothing persisted)
        → review/edit each row → "Confirm N students" (creates accounts; all-or-nothing)
        → success banner "Enrolled N students"
   → RosterTable: per-student two-step Remove (signs them out immediately)
   → AssignmentPanel: pick a published version → "Assign"
        → later "Close" (two-step; WARNS it expires in-progress attempts)
   → ClassResultsPanel: watch scored attempts arrive; "Reset attempt" (two-step; voids result) ✔
```

### 3.3 Counselor/Admin — build a custom assessment (with AI)

```
▶ /counselor/assessment-templates (or /admin/…)
   → create CUSTOM template (title) → builder
   → add Dimensions (code + name)
   → New version (DRAFT)
   → EITHER "Draft with AI" (description ≥20 chars OR upload PDF/DOCX → in-browser extract → queue)
        → poll status → questions land as unconfirmed AI drafts
     OR "Add a question by hand" (Likert; confirmed on insert)
   → Review: edit text, CONFIRM each dimension mapping individually (no bulk approve)
   → Publish (blocked until all mappings confirmed + ≥1 question) → version frozen, assignable ✔
```

### 3.4 Admin — build the academic catalog

```
▶ /admin-login → /admin
   → Colleges → "Add college" → college detail
        → "Add program" (code, name, dept, recommended strand, status)
        → CareerMapping: link careers this program leads to (drives §27 RIASEC scoring)
   → Careers → "Add career" (title, RIASEC code w/ live legend + meaning, salary, outlook)
   → Knowledge → upload PDF/DOCX (in-browser extraction) → chunked/embedded → "Ready"
   → AI Policy → edit Instructions/Restrictions → Save (Activate/Deactivate)  ✔
```

### 3.5 Auth utility flows

- **Forced password change** (temp password): any post-login route → `ProtectedRoute` detects
  `must_change_password` → **locked to** `/change-password` → set new → signed out → re-login. ✔
- **Forgot / reset password** (no email channel, D7): `/login` → "Forgot?" → `/forgot-password` →
  submit email → *(local dev shows the token + deep link; prod says "contact an administrator")* →
  `/reset-password` (email+token+new) → success → `/login`. ✔
- **Sign out**: sidebar "Sign out" → `authApi.logout()` → local clear + query cache clear (+ student
  class cleared) → redirected to the role's sign-in door. ✔
- **Session expiry**: any 401 → interceptor clears token → next guard redirect to sign-in. ✔

### 3.6 Notifications (all roles)

```
Top bar Bell (polls GET /notifications every 60s) → badge shows unread count
   → open dropdown → click a notification (marks read) OR "Mark all read"
   (v1 notifications are self-contained sentences — nothing deep-links)
```

---

## 4. UI component inventory

### 4.1 Design-system primitives (`components/ui/`)

| Component | Variants / API | Notes |
|---|---|---|
| **Button** | `variant`: primary · secondary · ghost · outline · danger; `size`: sm/md/lg; `loading` | CVA. `active:scale-[0.98]`, focus ring, spinner on loading. `danger` reserved for the *carrying-out* step of irreversible actions. |
| **Input** | native `<input>` styled | `aria-invalid` → destructive border/ring. |
| **Select** | native `<select>` styled to match Input | Native by choice (short closed enums; keyboard/SR-correct free). |
| **Textarea** | native styled | Matches Input. |
| **Label** | styled `<label>` | — |
| **Card** family | Card · CardHeader · CardTitle(`<h2>`) · CardDescription · CardContent | `rounded-xl`, `shadow-sm`. The dominant layout container app-wide. |
| **Badge** | `tone`: neutral · success · warning · brand · accent | **`capitalize` by default** — several call sites override with `normal-case` (smell). |
| **Alert** | `tone`: danger · warning · success · info | Inline message w/ icon; `role=alert` for danger, `role=status` otherwise. The app's **primary feedback channel** (no toasts). |
| **Sheet** | Radix Dialog wrapper (left/right) | Used **only** for the mobile nav drawer. Carries focus trap / esc / scroll-lock. |
| **Skeleton** | `animate-pulse` box | **Defined but barely used** — pages prefer text/`Loader2` instead. |
| **cn** | clsx + tailwind-merge | shadcn helper (lives here, not `lib/`). |

### 4.2 Charts (`components/charts/`) — all hand-rolled

| Component | Form | Where used |
|---|---|---|
| **BarList** | horizontal labeled bars, single-hue default | Student RIASEC profile, counselor scored-by-class |
| **ColumnChart** | small vertical distribution columns | Student match-confidence buckets |
| **DonutChart** | SVG part-to-whole + legend, `role=img` | Student & counselor completion |
| **Meter** | single ratio bar, `role=meter`, both ends named | Student/counselor completion & coverage |
| **StatCard** (`dashboard/`) | KPI tile (icon, label, value, hint, optional link) | All three dashboards |

### 4.3 Brand / motion

- **Logo** — single source-of-truth mark (image + "CareerLink**AI**" wordmark), `wordmarkClassName`
  for on-navy variants.
- **FadeIn** — the *only* animation primitive; short fade-and-rise on mount, respects
  `prefers-reduced-motion`.

### 4.4 Feature-local recurring components

- **CredentialsLoginForm** (shared by both staff logins)
- **Counselor**: CreateClassForm, JoinCodeCard, RosterBuilder (+RosterRow/Field), RosterTable,
  AssignmentPanel, ClassResultsPanel
- **Admin**: CollegeForm, ProgramForm, CareerForm (+RiasecLegend), CareerMapping
- **Notifications**: NotificationBell (+NotificationRow)

### 4.5 Inventory of interaction types actually present

| Element | Present? | Implementation |
|---|---|---|
| Buttons | ✅ | `Button` (5 variants) + many raw `<button>`/`<Link>` styled ad hoc |
| Text inputs / textarea / select | ✅ | Native, styled primitives |
| Checkboxes / radio buttons | ⚠️ **None as form controls** | The player's single-select uses `<button aria-pressed>`, not radios |
| Tables | ✅ | Hand-built `<table>` (audit log, counselor dashboard, roster) — no shared Table component |
| Cards | ✅ | `Card` family everywhere |
| Modals / dialogs | ⚠️ | Only the mobile `Sheet`; destructive confirms use `window.confirm` **or** inline two-step |
| Drawers | ✅ | `Sheet` (mobile nav only) |
| Tabs | ❌ | None — long pages stack panels vertically |
| Tooltips | ⚠️ | Native `title=""` only (Holland codes, chart bars) — no tooltip component |
| Toasts | ❌ | None — feedback is inline `Alert` + inline "Saved." text |
| Alerts | ✅ | `Alert` (4 tones) |
| Badges | ✅ | `Badge` (5 tones) |
| Breadcrumbs | ⚠️ | AppShell shows a single active-section label; detail pages add manual "← back" links |
| Sidebar / nav / menus | ✅ | `AppShell` sidebar + `NavLink`s; mobile `Sheet` |
| Pagination | ⚠️ | Prev/Next **only** on Counselors + Audit log |
| Accordions | ⚠️ | Only the audit-log expandable detail row (ad hoc, not a component) |
| Progress indicators | ✅ | `Meter`, player bar, result bar, `Loader2` spinner, button `loading` — **4+ bespoke bars** |
| File upload | ✅ | Native `<input type=file>` styled with `file:` utilities (Knowledge, builder) |
| Calendar / date picker | ❌ | None (dates are display-only via `toLocaleDateString`) |
| Search bars | ⚠️ | Only Counselors (name/email) + Audit log (action prefix) |
| Dropdown menu | ⚠️ | Hand-rolled in NotificationBell; **`@radix-ui/react-dropdown-menu` installed but unused** |

---

## 5. UX evaluation

Rated per dimension across the app; page-specific notes called out. Scale is qualitative
(**Strong / Adequate / Weak**).

| Dimension | Rating | Evidence |
|---|---|---|
| **Visual hierarchy** | Strong | Consistent page pattern: `<h1>` + muted subtitle → cards. Dashboards lead with KPI row then charts. |
| **Information architecture** | Strong | Role-scoped shells; nav ordered by "how the day runs"; catalog nesting (college → program → career) matches the domain. |
| **Navigation clarity** | Adequate | Three separate doors are clear once in; but breadcrumbs are shallow (active label only) and detail pages hand-roll back-links (inconsistent). |
| **Cognitive load** | Adequate | Copy is unusually explanatory. But `ClassDetailPage` (5 stacked panels) and `TemplateBuilderPage` (6 stacked cards) are long single-column scrolls that would benefit from tabs/steps. |
| **Accessibility** | Adequate | Good primitives (Radix Sheet, aria-invalid, sr-only, reduced-motion, meter/img roles). Gaps in custom controls & the hand-rolled dropdown — see §9. |
| **Consistency** | Weak | Token-vs-slate drift, off-brand student flow, 3 confirmation patterns, 4 progress-bar implementations — see §7. |
| **Mobile responsiveness** | Strong | Sidebar→Sheet under `lg`; responsive grids; tables in `overflow-x-auto`; auth art panel hides under `lg`. |
| **Desktop responsiveness** | Strong | `max-w-6xl` centered content, sticky sidebar/top bar. |
| **Spacing** | Strong | Uniform `gap-4/6`, `p-5/6` card padding via primitives. |
| **Alignment** | Strong | Grid-based; tabular-nums on all numeric columns. |
| **Typography** | Adequate | One family (Inter), consistent sizes — but heading color is `text-slate-900` not `text-foreground` almost everywhere (works in light theme, blocks the deferred dark theme). |
| **Color usage** | Weak | Brand violet/teal present on dashboards/landing but **absent from the student assessment/result flow** (slate-900). Semantic status colors (red/rose, emerald, sky, amber) applied inconsistently. |
| **Feedback** | Adequate | Loading/error/success handled thoughtfully (D11). But no toasts means transient success relies on inline text that can scroll out of view; mutation success is sometimes silent (e.g. attach career). |
| **Affordance** | Strong | Buttons look like buttons; destructive steps are worded as what they do; codes are mono+tracked to be read off a projector. |
| **Discoverability** | Adequate | `/admin-login` intentionally hidden; some actions (regenerate code, reprocess) appear only in the right state — good, but the builder's per-mapping confirm requirement isn't obvious until you try to publish. |
| **Error prevention** | Strong | Two-step destructive confirms with consequence-naming; publish gate; roster preview-before-create; "no approve-all" AI gate; strand collapsed to 2 real options. |

### Page-level UX highlights

- **Exemplary**: Student Dashboard, Assessment Player, RosterBuilder, AssignmentPanel,
  ClassResultsPanel, TemplateBuilder — each handles the failed/empty/loading distinction carefully
  and names the consequences of destructive actions.
- **Weakest visually**: Admin Dashboard (metric rows, no charts — plainer than its siblings) and the
  student **Player/Result** pages (off-brand monochrome).

---

## 6. Functionality audit

### 6.1 Dead / non-functional elements
**None found.** Every visible control resolves to a handler or navigation. The app is unusually
disciplined here.

### 6.2 Hidden / gated features (intentional)
- `/admin-login` — unlinked by design (typed URL only).
- Reprocess (only on FAILED docs), Regenerate code, Restore (only when archived), Reset attempt —
  state-gated, correctly.
- Local-dev reset token surfaced in `ForgotPasswordPage` — dev affordance only.

### 6.3 Redundant actions / unnecessary clicks
- **Counselor dashboard quick actions** duplicate the sidebar nav; "New class" routes to the classes
  *list* (then a second click to open the form) rather than opening the form directly — one extra
  click vs. the label's promise.
- Both dashboards + landing offer multiple paths to the same destinations (acceptable overlap, not a
  bug).

### 6.4 Missing validation
- **`StudentProfilePage`** has no client Zod schema (relies on `type=number min/max` + server 422).
  The most likely mistake (entering GWA as "9.2") is only caught server-side — inconsistent with the
  Zod-validated staff forms.
- **Builder manual-question "dimension code"** is free text with no check against existing
  dimensions; a typo silently produces an unscored question.
- **`TemplateListPage`** / dimension inputs rely on server validation for length/format.

### 6.5 Poor workflows / confusing interactions
- **Three confirmation idioms** (native `window.confirm`, inline two-step, and the Sheet for nav)
  mean "how do I confirm a destructive action?" has no single answer (§7.4).
- **No bulk operations** on rosters (remove is one-at-a-time, each a two-step confirm) — tedious for
  a 40-student class, though safe.
- **Long single-column pages** (class detail, builder) require scrolling past completed steps.
- **Silent mutation success** in a few spots (e.g. `CareerMapping` attach/detach, dashboard nav
  cards) — no confirmation that the link was made beyond the list updating.

### 6.6 Duplicate features / components
- **4+ progress-bar implementations** (Meter, player bar, result DimensionBar, plus button spinner).
- **Multiple bespoke "field" wrappers** (ResetPassword `Field`, RosterBuilder `Field`,
  CounselorManagement `FormField`, admin forms' inline `FieldError`) — the same label+input+error
  pattern re-implemented 4–5 times.
- **Two hand-built table layouts** (audit log, counselor dashboard, roster) with no shared Table.
- **`@radix-ui/react-dropdown-menu`** shipped but unused; NotificationBell re-implements a dropdown.

### 6.7 Scale concerns (functional gaps at volume)
- **No pagination** on colleges, careers, classes, knowledge docs, templates, or roster — only
  Counselors & Audit log paginate. Careers and knowledge docs can grow unbounded.
- **No search** on colleges, careers, classes, or roster (up to 200 students/class).
- **No sorting / filtering** beyond the audit-log action prefix.

---

## 7. Design-consistency report

This is the area with the most debt. Ordered by impact.

### 7.1 Semantic tokens vs. raw slate scales — **pervasive (≈33 files)**
The design system defines `--foreground`, `--muted-foreground`, `--card`, etc., but nearly every
page writes raw slate: `text-slate-900` for headings, `text-slate-500` for subtitles,
`border-slate-100/50` for dividers, `bg-slate-50` for tinted blocks. Often **both** appear in one
file. Consequences: (a) the "light theme only, dark deferred" decision is *un-actionable* — the raw
slate values won't respond to a theme swap; (b) subtle divergence (e.g. `text-slate-500` vs
`text-muted-foreground` which is slate-500 — same value today, two sources of truth).

### 7.2 Off-brand student assessment flow
`AssessmentPlayerPage` (selected option + progress `bg-slate-900`) and `ResultPage`
(`DimensionBar` `bg-slate-800`, headline slate-900) are **monochrome**, while dashboards and
landing use brand violet/teal. The student's *core* interaction is the least on-brand surface.

### 7.3 Status-color drift
- Error text: mostly `text-red-600`, but `CounselorManagementPage` uses `text-rose-600`.
- Notification badge uses `bg-rose-600`; unread dot uses `bg-sky-500` — neither is a token.
- Success: `Badge`/`Alert` use emerald tokens, but inline confirmations use `text-emerald-600/700`
  ad hoc.
- Warnings: amber used both via `Alert tone=warning` and via raw `bg-amber-50 border-amber-200`
  (ClassDetail success banner, JoinCodeCard regenerate block) — the same visual re-hand-rolled
  instead of using `Alert`.

### 7.4 Three confirmation patterns
1. **Native `window.confirm`** — CollegeDetail (delete college, delete program), CareerList (delete
   career).
2. **Inline two-step** (button → confirm/cancel + warning Alert) — RosterTable, JoinCodeCard,
   AssignmentPanel, ClassResultsPanel, CounselorManagement.
3. **No `AlertDialog`/modal component** despite `@radix-ui/react-dialog` being available (used only
   for Sheet).

### 7.5 Duplicated bars / tables / fields
See §6.6 — progress bars ×4, field wrappers ×4–5, tables ×2–3, all without a shared primitive.

### 7.6 Component-level smells
- `Badge` defaults to `capitalize`, then multiple call sites fight it with `normal-case` (audit
  actions, assessment titles, "awaiting first sign-in").
- `Skeleton` exists but pages use `<p>Loading…</p>` or a centered `Loader2` instead — **three
  loading idioms** (text / spinner / skeleton) with skeleton effectively dead.
- Consistent border-radius (`rounded-md`/`rounded-lg`/`rounded-xl` mapped to the radius scale) and
  shadow (`shadow-sm`) — these *are* consistent. Good.

### 7.7 What *is* consistent (credit where due)
- Radius scale, card shadow, spacing scale, `tabular-nums` on numerics, Inter everywhere, the
  page-header pattern (`h1` + muted subtitle), the D11 loading/empty/error discipline, two-step
  destructive-confirm *copy* (consequence-naming), and the chart palette (validated, capped at 3).

---

## 8. Page relationships & navigation map

### 8.1 Route table & guards

| Route | Component | Guard | Layout |
|---|---|---|---|
| `/` | LandingPage | public | self |
| `/login` | LoginPage | public (redirects if authed) | StaffAuthLayout |
| `/admin-login` | AdminLoginPage | public, **unlinked** | StaffAuthLayout |
| `/forgot-password` | ForgotPasswordPage | public | StaffAuthLayout |
| `/reset-password` | ResetPasswordPage | public | StaffAuthLayout |
| `/join` | StudentAccessPage | public | StudentAccessLayout |
| `/change-password` | ChangePasswordPage | any authed (`must_change_password` funnel) | StaffAuthLayout |
| `/admin` `/admin/colleges` `/admin/colleges/:id` `/admin/careers` `/admin/knowledge` `/admin/ai-policy` `/admin/counselors` `/admin/audit-log` `/admin/assessment-templates(/:id)` | Admin pages | `allow=['admin']` | AdminLayout |
| `/counselor` `/counselor/classes` `/counselor/classes/:id` `/counselor/assessment-templates(/:id)` | Counselor pages | `allow=['counselor','admin']` | CounselorLayout |
| `/student` `/student/profile` `/student/assessments` `/student/attempts/:id` `/student/results` `/student/results/:id` `/student/recommendations` | Student pages | `allow=['student']` | StudentLayout |
| `*` (authed) | RoleHome | any authed → role dashboard | — |

**`ProtectedRoute` behavior**: no token → redirect to the *role-appropriate* sign-in door (student→
`/join`, admin→`/admin-login`, else `/login`); re-verifies `/auth/me`; `must_change_password` →
locked to `/change-password`; wrong role → bounced to that role's home.

### 8.2 Navigation map (text diagram)

```
                              ┌────────────── LANDING (/) ──────────────┐
                              │  "Join your class"        "Counselor Login"
                              ▼                                  ▼
                       /join (student)                    /login (counselor)
                              │                                  │        └─ "Forgot?" → /forgot-password → /reset-password
                              ▼                                  ▼
                     ┌── StudentLayout ──┐            ┌── CounselorLayout ──┐        (/admin-login, unlinked)
                     │  /student (dash)  │            │  /counselor (dash)  │                 │
                     │  ├ assessments ───┼─ :id player│  ├ classes ─────────┼─ :id detail     ▼
                     │  │   └ results ───┼─ :id result│  │   (JoinCode·Roster·Assign·Results) AdminLayout
                     │  ├ results        │            │  └ assessment-templates ─ :id builder  /admin (dash)
                     │  ├ recommendations│            └─────────────────────┘   ├ colleges ─ :id ─ programs ─ CareerMapping
                     │  └ profile        │              (admin allowed through   ├ careers
                     └───────────────────┘               counselor shell too)    ├ assessment-templates ─ :id builder
                                                                                  ├ knowledge
   Top bar (all shells): NotificationBell dropdown · identity · mobile Sheet nav  ├ ai-policy
   Sidebar (all shells): role nav + Sign out                                      ├ counselors
                                                                                  └ audit-log
```

### 8.3 Parent–child relationships
- **College → Program → Career mapping**: `CollegeDetailPage` embeds `ProgramForm`/`ProgramCard`,
  each `ProgramCard` embeds `CareerMapping` (which reads the global Careers list).
- **Class → {code, roster, assignments, results}**: `ClassDetailPage` composes all four panels.
- **Template → Version → Question → Dimension mapping**: `TemplateBuilderPage` nests all levels.
- **Attempt → Result**: player submit → result detail; result list → result detail.

### 8.4 Shared components across pages
- `AppShell` (all 3 signed-in shells) · `StatCard` (3 dashboards) · `NotificationBell` (all shells) ·
  charts (student + counselor dashboards) · `CredentialsLoginForm` (2 logins) · `extractText`
  (Knowledge upload + builder AI-from-document) · the builder pages themselves (admin + counselor).

---

## 9. Accessibility report

### 9.1 Strengths
- **Radix Sheet** for mobile nav → focus trap, Escape, scroll-lock, `aria-modal` for free.
- **Forms**: `aria-invalid` on invalid inputs; `<Label htmlFor>` associations; `aria-describedby`
  on the RIASEC code field; `noValidate` with surfaced messages.
- **Icon-only buttons** carry `aria-label` (remove student, delete program, close menu, notification
  bell with unread count).
- **Loading**: spinners wrapped with `role=status` + `sr-only` text.
- **Charts**: `DonutChart` `role=img` + `aria-label`; `Meter` `role=meter` with valuemin/max/now;
  identity never rides on color alone (legends + values printed).
- **Motion**: `FadeIn` honors `prefers-reduced-motion`.
- **Alert**: `role=alert` for failures (assertive) vs `role=status` for success/info (polite) — a
  thoughtful distinction.
- **Player**: options use `aria-pressed`; "No score. Never a score." is a real a11y+integrity
  choice.

### 9.2 Gaps & risks
- **Hand-rolled notification dropdown**: closes on outside pointer-down but has **no Escape
  handler, no focus trap, no `role=menu`/arrow-key navigation, no focus return** to the trigger.
- **Player options are `<button aria-pressed>`, not a radio group** — no arrow-key movement between
  options, no group semantics for "one of N."
- **Inline text buttons** (`<button className="underline">` for "Complete your profile", "See your
  result", "See breakdown"-style) — several lack explicit `focus-visible` ring styling (rely on UA
  default, which the app suppresses elsewhere with `focus-visible:outline-none`).
- **`window.confirm`** dialogs are technically accessible but jarring and unstyleable — and they
  bypass the app's own focus management.
- **Heading color** universally `text-slate-900` — fine for contrast in light theme, but a
  hardcoded value that won't survive theming.
- **Tooltips** are native `title=""` only — not keyboard-focusable, not screen-reader-reliable for
  the Holland-code meanings.
- **File inputs**: styled natively (OK), but no described drag-drop/format hint tied via `aria`.
- **Contrast**: brand violet `#6d28d9` on white is AA (stated in tokens); `text-slate-400`
  placeholder/hint text on white is borderline for small text and used frequently (audit "—",
  chart captions).

### 9.3 Not evaluated (out of static-scan scope)
Live keyboard-trap testing, screen-reader walkthroughs, and automated axe runs were not executed;
findings above are from source inspection.

---

## 10. Feature inventory

| Domain | Features present |
|---|---|
| **Auth** | Counselor login, admin login (unlinked), passwordless student join, forced temp-password change, forgot/reset (no-email D7 shape), session re-verification, 401 auto-logout, wrong-door token revocation |
| **Student** | Unified assignment list, resume-safe 60-item player w/ auto-advance, deterministic result breakdown (RIASEC code / SCCT summary), profile-as-engine-input, dual-list recommendations, on-demand AI "Explain more" w/ graceful fallback, analytics dashboard |
| **Counselor** | Class CRUD, join-code display/copy/regenerate (revocation-aware), bulk roster preview→confirm, roster removal, assessment assignment + close (expiry-warned), class results + attempt reset (D8), caseload dashboard |
| **Admin** | College/program/career catalog CRUD w/ archive-vs-delete, program↔career mapping, RIASEC-code authoring w/ live legend, knowledge-base upload (in-browser extraction) + reprocess/archive, AI policy editor, counselor account management (temp-password issuance), audit-log viewer w/ filter+detail |
| **Assessment builder** | CUSTOM template creation, dimensions (freeze-on-publish), versioning, AI generation (from description / from document), per-mapping human confirmation, manual Likert authoring, publish gate |
| **Cross-cutting** | Polling notification bell (all roles), role-scoped shells, responsive sidebar/drawer, live-data dashboards w/ honest empty states, D11 failed-vs-empty discipline |
| **Absent (by design or deferral)** | Email/SMS/push (deferred), dark theme (deferred), toasts, tabs, real breadcrumbs, global search, bulk roster ops, sorting/filtering, calendar/date pickers |

---

## 11. Prioritized redesign opportunities

> Observations only — sequenced by impact-to-effort. Not yet a redesign plan.

### P0 — Consistency foundation (high impact, mechanical)
1. **Adopt semantic tokens everywhere.** Replace raw `text-slate-900/500`, `border-slate-*`,
   `bg-slate-50` with `text-foreground`, `text-muted-foreground`, `border-border`, `bg-muted`.
   Unblocks the deferred dark theme and removes ~33 files of drift. (§7.1)
2. **Bring the student assessment/result flow on-brand.** Swap `bg-slate-900/800` selected/progress
   states for `primary`/`accent`. This is the product's core interaction. (§7.2)
3. **One confirmation pattern.** Build a single `AlertDialog`/`ConfirmDialog` on the already-present
   Radix Dialog and retire `window.confirm` + the ad-hoc inline two-steps (keep the excellent
   consequence-naming copy). (§7.4)

### P1 — Shared primitives (reduce duplication)
4. **Extract shared components**: `FormField` (label+control+error), `ProgressBar`/consolidated
   `Meter`, `Table`, and use the existing `Skeleton` for loading (retire the text/spinner mix).
   (§6.6, §7.5)
5. **Add a toast/notification-region** for transient mutation success (saved, linked, assigned) so
   feedback isn't a line that scrolls away. (§5 Feedback)
6. **Replace the hand-rolled notification dropdown** with the installed
   `@radix-ui/react-dropdown-menu` (fixes Escape/focus-trap/keyboard-nav a11y gaps). (§9.2)

### P2 — Scale & navigation
7. **Pagination + search** on colleges, careers, classes, knowledge, templates, and roster; the
   roster especially (200/class). (§6.7)
8. **Structure long pages**: tabs or a stepper for `ClassDetailPage` (5 panels) and
   `TemplateBuilderPage` (6 cards). (§5 Cognitive load)
9. **Real breadcrumbs** for nested routes (college→program, class detail, builder) to replace the
   shallow active-label + hand-rolled back-links. (§8.3)

### P3 — Validation & polish
10. **Client Zod on `StudentProfilePage`** (GWA range/format) to match the staff forms. (§6.4)
11. **Dimension-code dropdown** in the builder's manual-question editor instead of free text. (§6.4)
12. **Accessible tooltips** for Holland-code meanings and chart values (keyboard-focusable), and
    explicit `focus-visible` rings on inline text buttons. (§9.2)
13. **Normalize status colors** to tokens (rose→destructive, sky/emerald/amber via tokens or a
    documented status scale). (§7.3)

### Preserve (do not "fix")
- The three-door auth separation and unlinked `/admin-login`.
- The D11 failed-vs-empty discipline and consequence-naming on destructive actions.
- The "no approve-all" per-mapping AI confirmation gate.
- The "AI never scores; scores are computed" separation (distinct pages/tables/copy).
- Honest empty-state placeholders (no fake zeros) and the capped, validated chart palette.

---

*End of audit. Source of truth for intended behavior remains `FULLPLAN.md`; this document describes
the frontend as built as of the audit date.*

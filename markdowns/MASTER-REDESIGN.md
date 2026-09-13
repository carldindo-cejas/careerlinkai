# CareerLinkAI — Frontend Redesign to the "Industry" Design System

**For:** Claude Code (VS Code extension), run inside `careerlinkai_v1/frontend/`.
**What this is:** a complete, self-contained instruction set to reskin the CareerLinkAI
frontend from its violet/teal shadcn look into the **Industry** design language, matching the
approved hi-fi mockups. Work in the order given. Make className/token edits only — do **not**
change component logic, data hooks, routes, or copy except where a section explicitly says so.

> Read each target file before editing it. Apply changes as small diffs. After each numbered
> phase, run `npm run build` and fix type errors before moving on.

---

## 0. The design language (what "Industry" means)

A steel-blue technical **wireframe** on a light ground. Concretely:

- **Ground** `#f2f2f3`, **ink** `#1d1f20`, a single **steel accent** `#5980a6` (mono scheme —
  no second accent hue). Deep steel `#416180` for accent text on light; `#1d2d3d` for the sidebar field.
- **Type:** Barlow Condensed for all headings, Barlow for body. Headings are UPPERCASE in
  display spots (page `<h1>`, card kickers), sentence case in dense UI.
- **Shape:** squared corners (radius ~4px, not the old 12px). Cards and figures are
  **transparent line-drawings** — a hairline border does the work, no surface fill, no drop shadow.
- **Corner marks:** major framed objects (cards, KPI tiles, the primary button, avatars) wear
  four `+` registration marks at their corners — the "blueprint" motif. This is the signature.
- **The one solid object:** the primary button is a filled steel block. Everything else is outline.
- **Numbers** use `tabular-nums`. **Icons** are Lucide at `stroke-width={1.5}`.

Keep everything the audit flagged as *good*: the D11 failed-vs-empty discipline, consequence-naming
on destructive actions, the per-mapping "no approve-all" AI gate, honest empty states. This is a
**visual** reskin, not a behavior change.

---

## 1. Token layer — `src/index.css` (already delivered, verify it's in place)

The whole reskin pivots on this file because the components consume semantic tokens
(`bg-primary`, `text-foreground`, `bg-sidebar`, `border-border`…). Confirm `src/index.css`
matches the delivered "Industry retune": Barlow/Barlow Condensed `@import`, steel `--primary`,
deep-steel `--sidebar`, `--radius: 0.25rem`, accent `:focus-visible` ring, heading font on
`h1–h6`. If it's not in place, ask the user for the delivered `index.css` before continuing —
do not hand-author a replacement.

---

## 2. New primitive — `src/components/ui/blueprint.tsx`

Create this file. It is the corner-mark frame every card/tile/figure will wear.

```tsx
import type { HTMLAttributes } from 'react';

import { cn } from '@/components/ui/cn';

/**
 * The "Industry" wireframe frame: a square, hairline-bordered, transparent object with four
 * "+" registration marks at its corners. Wraps cards, KPI tiles, figures and the primary button.
 * The marks are decorative (aria-hidden); the border provides the actual boundary.
 */
export function Blueprint({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('relative border border-border', className)} {...props}>
      <Corners />
      {children}
    </div>
  );
}

/** The four corner marks on their own — for elements that already have their own border/box. */
export function Corners() {
  const base = 'pointer-events-none absolute size-[7px] text-primary';
  return (
    <span aria-hidden="true">
      <Mark className={cn(base, '-left-px -top-px border-l border-t')} />
      <Mark className={cn(base, '-right-px -top-px border-r border-t')} />
      <Mark className={cn(base, '-bottom-px -left-px border-b border-l')} />
      <Mark className={cn(base, '-bottom-px -right-px border-b border-r')} />
    </span>
  );
}

function Mark({ className }: { className: string }) {
  return <span className={className} style={{ borderColor: 'currentColor' }} />;
}
```

Usage everywhere: replace an outer `<Card>` wrapper's visual role with `<Blueprint className="p-…">`,
**or** keep `<Card>` and drop `<Corners />` as its first child once Card is squared/transparent (§3.1).
Prefer the latter so existing Card composition (CardHeader/CardTitle/…) keeps working.

---

## 3. Component pass (`src/components/ui/` + `src/components/dashboard/`)

Read each file first; these are targeted className edits.

### 3.1 `card.tsx` — transparent line-drawing + corner marks
- Root `Card`: remove any surface fill and shadow, square the corners, add the marks.
  - Change the container classes to: `relative border border-border bg-transparent rounded-none`
    (drop `bg-card`/`bg-white`, `rounded-xl`, `shadow-sm`).
  - Import `Corners` from `./blueprint` and render `<Corners />` as the first child inside the
    root div, before `{children}`/`{props.children}`.
- `CardTitle` (the `<h2>`): it inherits Barlow Condensed from `index.css`. Add
  `uppercase tracking-tight` for the kicker feel; keep its size class.
- Leave CardHeader/CardContent/CardDescription padding as-is.

### 3.2 `button.tsx` — squared, steel primary is the one solid object
In `buttonVariants`, edit the variant/size class strings:
- Base: keep `inline-flex items-center justify-center gap-2 font-medium transition`,
  add `rounded-none` (or ensure it reads the small radius), keep `active:scale-[0.98]` and the
  `focus-visible` ring (now steel via the token).
- `primary`: `bg-primary text-primary-foreground hover:bg-[#4d7196]` (one step darker steel).
- `secondary`: `border border-border bg-transparent text-foreground hover:bg-secondary`.
- `ghost`: `bg-transparent text-foreground hover:bg-secondary`.
- `outline`: same as secondary (they converge in this system — keep both names for callers).
- `danger`: `bg-destructive text-destructive-foreground hover:bg-[#9a322c]` — reserved for the
  *carrying-out* step of irreversible actions only.
- Keep `size` padding but note the squared corners; keep the `Loader2` spinner on `loading`.

> Optional flourish (nice-to-have, skip if noisy): give **primary** buttons the corner marks by
> rendering `<Corners />` when `variant === 'primary'`. Only do this after the base pass builds clean.

### 3.3 `badge.tsx` — tokens, drop the default capitalize
- Remove the default `capitalize` from the base class (audit §7.6) so call sites stop fighting it
  with `normal-case`. Add `rounded-none` and `font-medium tracking-wide`.
- Replace the tone ramps (mono scheme — success/brand/accent all read steel):
  - `neutral: 'bg-secondary text-muted-foreground'`
  - `success: 'bg-primary/10 text-primary'`   *(was emerald)*
  - `warning: 'bg-accent/10 text-accent'`      *(was amber; accent = deep steel #416180)*
  - `brand:   'bg-primary/10 text-primary'`
  - `accent:  'bg-accent/10 text-accent'`
- Add an `outline` tone if easy: `border border-border bg-transparent text-muted-foreground`
  (the mockups use it for FAILED/THROTTLED audit rows). Otherwise map those to `neutral`.

### 3.4 `alert.tsx` — tokenize the tone ramps
Replace the raw `alertVariants` tone map (keep `role`/icon logic untouched):
```
danger:  'border-destructive/30 bg-destructive/10 text-destructive',
warning: 'border-accent/30 bg-accent/10 text-accent',
success: 'border-primary/30 bg-primary/10 text-primary',
info:    'border-border bg-muted text-muted-foreground',
```
Add `rounded-none` to the base class. This retires the last raw red/amber/emerald/slate in a
primitive and lets the ad-hoc `bg-amber-50 border-amber-200` warning blocks (§7.3) be replaced by
`<Alert tone="warning">` at their call sites.

### 3.5 `StatCard.tsx` — KPI tile as a blueprint object
- Swap the hover hardcode `hover:border-slate-300` → `hover:border-primary`.
- Since Card is now transparent+marked (§3.1), the tile inherits the frame automatically — no
  other change needed. Keep `tabular-nums`, the uppercase label, `text-muted-foreground`.

### 3.6 `input.tsx` / `select.tsx` / `textarea.tsx`
- Square the corners (`rounded-none`), border `border-input`, `bg-transparent`,
  `focus-visible` steel ring (inherits from index.css). Keep `aria-invalid` → destructive border.

### 3.7 `src/components/charts/colors.ts` — steel ramp
The chart palette is violet/teal/amber. Retune to a steel monochrome ramp (magnitude, not
category — this system is mono). Replace the three hexes:
```
primary: '#416180',  // deep steel  (slot 1 / single-hue default)
accent:  '#5980a6',  // base steel  (slot 2)
amber:   '#93a9c1',  // light steel (slot 3)  — keep the export key name to avoid churn
```
Update the doc comment to say the palette is now a validated steel ramp. Bars/donuts/columns/meters
all read from these, so this reskins every chart at once.

---

## 4. The shell — `src/layouts/AppShell.tsx`

- Sidebar already uses `bg-sidebar` / `text-sidebar-foreground` (or should) — the token retune
  turns it deep steel automatically. Verify: active `NavLink` uses `bg-sidebar-active` +
  `text-sidebar-active-foreground` and a `border-l-2 border-primary` accent bar; inactive uses
  `text-sidebar-muted`. If any of those are hardcoded (`bg-[#171338]`, slate values), swap to tokens.
- Brand wordmark: "CareerLink" in `text-sidebar-foreground`, "AI" in `text-primary`.
- Top bar breadcrumb: the audit wants **real breadcrumbs** (§11.9). If AppShell only shows the
  active-section label, render a `Home / Section / Page` trail from the route match. Small win —
  do it only if the route data is readily available; otherwise leave a `// TODO breadcrumbs` note.

---

## 5. De-slate sweep (audit §7.1 — pervasive, ~33 files)

Grep first: `grep -rn "slate-" src/`. Apply these across all `.tsx`, reviewing each hit
(keep layout/spacing classes; only colors change):

| Find | Replace |
|---|---|
| `text-slate-900` / `text-slate-800` | `text-foreground` |
| `text-slate-700` | `text-foreground/80` |
| `text-slate-600` / `-500` / `-400` | `text-muted-foreground` |
| `border-slate-50/100/200` | `border-border` |
| `bg-slate-50` | `bg-muted` |
| `bg-slate-100` | `bg-secondary` |
| `bg-white` | `bg-transparent` (cards) or `bg-background` (page surfaces) — judge per case |

---

## 6. On-brand the student core flow (audit §7.2 — the most important screen)

Files: `src/features/student/pages/AssessmentPlayerPage.tsx`,
`src/features/student/pages/ResultPage.tsx` (and its `DimensionBar`), plus any progress fills.

| Find | Replace | Effect |
|---|---|---|
| `bg-slate-900` | `bg-primary` | selected option + progress fill → steel |
| `bg-slate-800` | `bg-primary` | result dimension bars → steel |
| `ring-slate-900` / `border-slate-900` | `ring-primary` / `border-primary` | selected ring |
| `text-slate-900` (headline) | `text-foreground` | Holland-code headline |

Selected answer buttons: give them `aria-pressed` steel treatment —
`aria-pressed:bg-primary aria-pressed:text-primary-foreground` (or the existing conditional class),
squared corners, hairline border when unselected. The progress bar track = `bg-secondary`, fill = `bg-primary`.

---

## 7. Status-color normalization (audit §7.3)

| Find | Replace | Location |
|---|---|---|
| `text-rose-600` | `text-destructive` | CounselorManagementPage |
| `bg-rose-600` | `bg-destructive` | notification badge |
| `bg-sky-500` | `bg-primary` | unread dot |
| `text-emerald-600` / `-700` | `text-primary` | inline "Saved." confirmations |
| `bg-amber-50 border-amber-200` blocks | `<Alert tone="warning">…</Alert>` | ClassDetail banner, JoinCodeCard |

Grep to confirm clean: `grep -rn "emerald-\|amber-\|rose-\|sky-\|teal-\|violet-" src/`.

---

## 8. Optional §11 opportunities (do only if the user asks — flag, don't auto-apply)

These are behavior/structure changes beyond a reskin. List them in your summary; implement only on request:
- **Toast region** for transient mutation success (§11.5) — a small `role="status"` region so
  "Saved / Linked / Assigned" doesn't rely on inline text that scrolls away.
- **One confirmation pattern** (§11.3): build a `ConfirmDialog` on the installed `@radix-ui/react-dialog`
  and retire `window.confirm` + ad-hoc inline two-steps (keep the consequence-naming copy verbatim).
- **Radix dropdown** for the notification bell (§11.6) — the installed `@radix-ui/react-dropdown-menu`
  fixes the Escape/focus-trap/keyboard gaps.
- **Pagination + search** on colleges/careers/classes/knowledge/roster (§11.7).
- **Tabs/stepper** for ClassDetailPage (5 panels) and TemplateBuilderPage (6 cards) (§11.8).

---

## 9. Do NOT touch (preserve)
- D11 failed-vs-empty branches and their distinct visuals.
- Consequence-naming copy on destructive actions; the two-step confirm *wording*.
- The per-mapping "no approve-all" AI confirmation gate.
- The "AI never scores; scores are computed" separation (distinct pages/tables/copy).
- Route guards, auth model, the three-door separation, unlinked `/admin-login`.
- Data hooks, services, query defaults.

---

## 10. Execution order & verification

1. Confirm `src/index.css` is the Industry retune (§1).
2. Add `blueprint.tsx` (§2). `npm run build`.
3. Component pass §3 (card → button → badge → alert → statcard → inputs → charts). `npm run build` after each.
4. Shell §4. De-slate §5. Student flow §6. Status colors §7. `npm run build`.
5. Grep gates (should be ~empty):
   `grep -rn "slate-\|emerald-\|amber-\|rose-\|sky-\|teal-\|violet-\|rounded-xl\|shadow-sm" src/`
6. `npm run dev` and eyeball: landing, three sign-in doors, all three dashboards, the assessment
   player, a result page, the admin audit log. They should read as steel wireframe with corner marks.

Reference mockups (approved visual target): the seven screens in the design chat
(landing, counselor/admin/student sign-in, student/counselor/admin dashboards).

# CareerLinkAI — De-slate sweep (Claude Code handoff)

Goal: remove the raw Tailwind `slate-*` and ad-hoc status colors (audit §7.1, §7.2, §7.3)
so every surface reads from the semantic tokens already retuned in `src/index.css`
(the "Industry" palette). No component logic changes — className edits only.

Run from `frontend/`. Work token-by-token, grep first, review each hit, then replace.
Keep `tabular-nums`, spacing, and layout classes untouched.

## 1. Neutral text & dividers (pervasive — ~33 files)

| Find (className fragment) | Replace with |
|---|---|
| `text-slate-900` | `text-foreground` |
| `text-slate-800` | `text-foreground` |
| `text-slate-700` | `text-foreground/80` |
| `text-slate-600` | `text-muted-foreground` |
| `text-slate-500` | `text-muted-foreground` |
| `text-slate-400` | `text-muted-foreground` |
| `border-slate-50` | `border-border` |
| `border-slate-100` | `border-border` |
| `border-slate-200` | `border-border` |
| `bg-slate-50` | `bg-muted` |
| `bg-slate-100` | `bg-secondary` |
| `bg-white` | `bg-card` |

Grep to scope:  `grep -rn "slate-" src/`

## 2. Off-brand student flow (audit §7.2) — the core interaction

Files: `src/features/student/pages/AssessmentPlayerPage.tsx`,
`src/features/student/pages/ResultPage.tsx` (DimensionBar), any progress fills.

| Find | Replace with | Why |
|---|---|---|
| `bg-slate-900` | `bg-primary` | selected option / progress fill → brand steel |
| `bg-slate-800` | `bg-primary` | result dimension bars → brand steel |
| `text-slate-900` (on those pages) | `text-foreground` | headline |
| `ring-slate-900` / `border-slate-900` | `ring-primary` / `border-primary` | selected state ring |

After: the player's selected option, progress bar, and result bars are steel, not monochrome.

## 3. Status colors → tokens (audit §7.3)

`src/components/ui/badge.tsx` — replace the raw ramps in `badgeVariants`:

```
neutral: 'bg-secondary text-secondary-foreground/80',
success: 'bg-primary/10 text-primary',        // was bg-emerald-100 text-emerald-800
warning: 'bg-accent/10 text-accent',           // was bg-amber-100 text-amber-800
brand:   'bg-primary/10 text-primary',
accent:  'bg-accent/10 text-accent',            // was bg-teal-100 text-teal-800
```
Also drop the default `capitalize` (audit §7.6) so call sites stop overriding with `normal-case`.

Elsewhere:
| Find | Replace with |
|---|---|
| `text-rose-600` (CounselorManagementPage) | `text-destructive` |
| `bg-rose-600` (notification badge) | `bg-destructive` |
| `bg-sky-500` (unread dot) | `bg-primary` |
| `text-emerald-600` / `text-emerald-700` (inline confirmations) | `text-primary` |
| raw `bg-amber-50 border-amber-200` warning blocks | use `<Alert tone="warning">` |

## 4. Verify

```
grep -rn "slate-\|emerald-\|amber-\|rose-\|sky-\|teal-" src/    # should be ~empty
npm run build
```
Spot-check: student dashboard, assessment player, result page, admin audit-log badges.

Preserve (do NOT touch): the D11 failed-vs-empty branches, consequence-naming copy,
per-mapping AI confirm gate, chart palette in `src/components/charts/colors.ts`
(retune those hex values separately to the steel ramp if desired).

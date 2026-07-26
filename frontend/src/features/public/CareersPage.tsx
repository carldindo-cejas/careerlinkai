import { Briefcase, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  usePublicCareers,
  usePublicEmploymentOutlooks,
} from '@/features/public/hooks/usePublicCatalog';
import { describeHollandCode, formatSalaryRange, type Career } from '@/types/catalog';

/**
 * The public Careers page (prompt-driven, v1.5). Every career, filterable by employment outlook and a
 * salary window — the three filters compose, and the list updates as they change.
 *
 * Filtering is client-side over a single fetch of the whole (small) active-career set, so results
 * update instantly with no request per keystroke. Salary is a *range overlap*: a career matches the
 * window when its own range intersects it, and a career with no salary on file is only shown when no
 * salary filter is active (it cannot be confirmed to match one).
 */

/** Parse a salary input to a whole number, or null when empty/invalid. Negatives are treated as empty. */
function parseSalary(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const parsed = Number(trimmed.replace(/,/g, ''));
  if (!Number.isFinite(parsed) || parsed < 0) return null;

  return Math.floor(parsed);
}

function matchesSalary(career: Career, min: number | null, max: number | null): boolean {
  if (min === null && max === null) return true;

  // Can't judge a salary window against a career that has no salary on file.
  if (career.salary_min === null && career.salary_max === null) return false;

  const careerMin = career.salary_min ?? career.salary_max!;
  const careerMax = career.salary_max ?? career.salary_min!;

  if (min !== null && careerMax < min) return false;
  if (max !== null && careerMin > max) return false;

  return true;
}

export function CareersPage() {
  const [outlookId, setOutlookId] = useState<string>('');
  const [minInput, setMinInput] = useState('');
  const [maxInput, setMaxInput] = useState('');

  const careers = usePublicCareers();
  const outlooks = usePublicEmploymentOutlooks();

  const min = parseSalary(minInput);
  const max = parseSalary(maxInput);
  const invalidRange = min !== null && max !== null && min > max;

  const filtered = useMemo(() => {
    const all = careers.data ?? [];

    return all.filter((career) => {
      if (outlookId && career.employment_outlook_id !== outlookId) return false;
      if (!matchesSalary(career, min, max)) return false;

      return true;
    });
  }, [careers.data, outlookId, min, max]);

  const hasFilters = outlookId !== '' || minInput !== '' || maxInput !== '';

  function clearFilters() {
    setOutlookId('');
    setMinInput('');
    setMaxInput('');
  }

  return (
    <div>
      {/* Header band on the steel canvas — title and the three filters. */}
      <section className="border-b border-sidebar-border">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <p className="mb-3 w-fit rounded-none border border-sidebar-border bg-sidebar-active/50 px-3 py-1 text-xs font-medium uppercase tracking-wide text-sidebar-foreground">
            Careers
          </p>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Careers your studies can lead to
          </h1>
          <p className="mt-3 max-w-2xl text-sidebar-foreground">
            Filter by employment outlook and expected monthly salary to see where different paths can
            take you.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="outlook-filter" className="text-sidebar-foreground">
                Employment outlook
              </Label>
              <Select
                id="outlook-filter"
                value={outlookId}
                onChange={(event) => setOutlookId(event.target.value)}
                className="border-sidebar-border bg-sidebar text-sidebar-active-foreground"
                disabled={outlooks.isPending}
              >
                <option value="">All outlooks</option>
                {(outlooks.data ?? []).map((outlook) => (
                  <option key={outlook.id} value={outlook.id}>
                    {outlook.name}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="min-salary" className="text-sidebar-foreground">
                Minimum salary (₱ / mo)
              </Label>
              <Input
                id="min-salary"
                type="number"
                inputMode="numeric"
                min={0}
                step={1000}
                placeholder="e.g. 20000"
                value={minInput}
                onChange={(event) => setMinInput(event.target.value)}
                className="border-sidebar-border bg-sidebar text-sidebar-active-foreground placeholder:text-sidebar-muted"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="max-salary" className="text-sidebar-foreground">
                Maximum salary (₱ / mo)
              </Label>
              <Input
                id="max-salary"
                type="number"
                inputMode="numeric"
                min={0}
                step={1000}
                placeholder="e.g. 80000"
                value={maxInput}
                onChange={(event) => setMaxInput(event.target.value)}
                className="border-sidebar-border bg-sidebar text-sidebar-active-foreground placeholder:text-sidebar-muted"
              />
            </div>
          </div>

          {invalidRange ? (
            <p className="mt-3 text-sm text-accent">
              The minimum salary is higher than the maximum — no career can match that range.
            </p>
          ) : null}

          {hasFilters ? (
            <button
              type="button"
              onClick={clearFilters}
              className="mt-4 text-sm text-sidebar-foreground underline-offset-4 transition-colors hover:text-sidebar-active-foreground hover:underline"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </section>

      {/* Results on the paper canvas. */}
      <section className="bg-background text-foreground">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          {careers.isError ? (
            <Alert>We could not load the careers. {careers.error.message}</Alert>
          ) : null}

          {careers.isPending ? (
            <div className="flex justify-center py-16" role="status">
              <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">Loading careers…</span>
            </div>
          ) : null}

          {careers.data && filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <Briefcase className="size-8 text-muted-foreground/60" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                {hasFilters
                  ? 'No careers match these filters. Try widening them.'
                  : 'No careers have been added yet. Check back soon.'}
              </p>
            </div>
          ) : null}

          {filtered.length > 0 ? (
            <>
              <p className="mb-6 text-sm text-muted-foreground">
                {filtered.length} {filtered.length === 1 ? 'career' : 'careers'}
                {hasFilters ? ' match your filters' : ''}
              </p>
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((career) => (
                  <CareerCard key={career.id} career={career} />
                ))}
              </div>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function CareerCard({ career }: { career: Career }) {
  const salary = formatSalaryRange(career.salary_min, career.salary_max);

  return (
    <article className="flex flex-col gap-3 border border-border bg-background p-6">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold leading-snug text-foreground">{career.title}</h3>
        {career.typical_riasec_code ? (
          <span
            className="shrink-0 rounded-none bg-secondary px-1.5 py-0.5 font-mono text-xs font-semibold tracking-widest text-foreground/80"
            title={describeHollandCode(career.typical_riasec_code) ?? undefined}
          >
            {career.typical_riasec_code}
          </span>
        ) : null}
      </div>

      {career.description ? (
        <p className="line-clamp-3 text-sm text-muted-foreground">{career.description}</p>
      ) : null}

      <dl className="mt-auto flex flex-col gap-1.5 text-sm">
        {career.employment_outlook ? (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">Outlook</dt>
            <dd className="font-medium text-foreground">{career.employment_outlook.name}</dd>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Salary</dt>
          <dd className="font-medium text-foreground">
            {salary ?? <span className="text-muted-foreground">Not disclosed</span>}
          </dd>
        </div>
      </dl>
    </article>
  );
}

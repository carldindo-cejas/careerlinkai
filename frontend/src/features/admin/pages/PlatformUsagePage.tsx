import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { usePlatformUsage } from '@/features/admin/hooks/usePlatformAdmin';
import type { UnmeteredLimit, UsageResource } from '@/types/platform';

/**
 * **Platform health** — what this deployment is spending of the Cloudflare free plan.
 *
 * The screen answers one question: *is anything about to stop working today?* So the bars are
 * ordered by how close each is to its ceiling rather than by which service is most interesting,
 * and the one number that can actually stop the AI — today's generation budget — is measured from
 * the guard that enforces it rather than estimated from anything.
 *
 * The second half of the page is the part that keeps the first half honest. Several limits this
 * project genuinely runs against, neurons among them, cannot be read from inside a Worker at all.
 * An admin looking at five green bars with no mention of them could reasonably conclude everything
 * is monitored, and the first they would hear otherwise is an outage — so they are named, with why
 * they are missing.
 */
export function PlatformUsagePage() {
  const { data, isLoading, isError, error } = usePlatformUsage();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Platform health</h1>
        <p className="text-sm text-muted-foreground">
          What this school&rsquo;s CareerLinkAI is using of the Cloudflare free plan. Bars closest
          to their limit are shown first.
        </p>
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {isError ? <Alert>We could not load platform usage. {error.message}</Alert> : null}

      {data ? (
        <>
          <div className="flex flex-col gap-4">
            {[...data.resources]
              .sort((a, b) => pressure(b) - pressure(a))
              .map((resource) => (
                <UsageBar key={resource.key} resource={resource} />
              ))}
          </div>

          <UnmeteredCard limits={data.unmetered} />

          <p className="text-xs text-muted-foreground">
            Measured {new Date(data.captured_at).toLocaleString()}. Refreshes every minute.
          </p>
        </>
      ) : null}
    </div>
  );
}

/** How close to its ceiling a resource is, as a fraction. Drives both ordering and colour. */
function pressure(resource: UsageResource): number {
  return resource.limit > 0 ? resource.used / resource.limit : 0;
}

/**
 * Three states, and the middle one is the point.
 *
 * A bar that only turns red at 100% would be useless for the generation budget, which stops
 * serving generated answers at its degrade line — 85% — and not at the cliff. So a resource that
 * declares a degrade line is judged against *that*, because that is the number at which a student
 * actually notices something has changed.
 */
function severityOf(resource: UsageResource): 'ok' | 'warn' | 'critical' {
  const ratio = pressure(resource);
  const ceiling = resource.degrade_at ?? 1;

  if (ratio >= ceiling) {
    return 'critical';
  }

  return ratio >= ceiling * 0.75 ? 'warn' : 'ok';
}

const TRACK: Record<ReturnType<typeof severityOf>, string> = {
  ok: 'bg-primary',
  warn: 'bg-amber-500',
  critical: 'bg-destructive',
};

function UsageBar({ resource }: { resource: UsageResource }) {
  const severity = severityOf(resource);
  const ratio = pressure(resource);
  // Always draw something for a non-zero value: a hairline that says "a little" reads correctly,
  // where a bar of literally zero width is indistinguishable from a resource nobody has touched.
  const width = resource.used === 0 ? 0 : Math.max(0.75, Math.min(100, ratio * 100));

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <CardTitle className="text-base">{resource.label}</CardTitle>
          <span className="text-sm tabular-nums text-muted-foreground">
            <span className="font-semibold text-foreground">{format(resource.used, resource.unit)}</span>
            {' of '}
            {format(resource.limit, resource.unit)}
          </span>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div>
          <div
            role="progressbar"
            aria-label={`${resource.label}: ${format(resource.used, resource.unit)} of ${format(resource.limit, resource.unit)}`}
            aria-valuenow={Math.round(ratio * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="relative h-2 w-full overflow-hidden bg-secondary"
          >
            <div
              className={cn('h-full transition-[width] duration-500', TRACK[severity])}
              style={{ width: `${width}%` }}
            />
            {/*
              The degrade line, drawn on the track rather than described in the caption. It is the
              threshold this platform actually acts on, so it belongs where the eye already is.
            */}
            {resource.degrade_at !== null && resource.degrade_at < 1 ? (
              <span
                aria-hidden="true"
                className="absolute inset-y-0 w-px bg-foreground/40"
                style={{ left: `${resource.degrade_at * 100}%` }}
              />
            ) : null}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular-nums">{(ratio * 100).toFixed(ratio < 0.01 ? 2 : 1)}% used</span>
            {resource.degrade_at !== null && resource.degrade_at < 1 ? (
              <span>· degrades at {Math.round(resource.degrade_at * 100)}%</span>
            ) : null}
            <Badge tone={resource.limit_source === 'platform' ? 'neutral' : 'outline'}>
              {resource.limit_source === 'platform' ? 'Cloudflare limit' : 'our own budget'}
            </Badge>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">{resource.detail}</p>
      </CardContent>
    </Card>
  );
}

/**
 * The blind spots, listed as plainly as the measurements.
 *
 * Deliberately not styled as a warning. Nothing is wrong — these are simply limits a Worker is
 * never told about, and the reason to print them is that a monitoring page which silently omits
 * what it cannot see is worse than one that has no bars at all.
 */
function UnmeteredCard({ limits }: { limits: UnmeteredLimit[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Limits nothing here can measure</CardTitle>
        <CardDescription>
          These are real ceilings this platform runs against, and a Worker is not told its usage of
          any of them. Check the Cloudflare dashboard for these.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-4">
          {limits.map((limit) => (
            <div key={limit.label} className="flex flex-col gap-0.5">
              <dt className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium text-foreground">{limit.label}</span>
                <span className="text-sm tabular-nums text-muted-foreground">{limit.limit}</span>
              </dt>
              <dd className="text-sm text-muted-foreground">{limit.why}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * Bytes get binary units; everything else gets thousands separators.
 *
 * A database reported as "3,026,944 bytes" is a number an admin has to decode before it means
 * anything, and this screen exists to be read at a glance.
 */
function format(value: number, unit: string): string {
  if (unit !== 'bytes') {
    return `${value.toLocaleString()} ${value === 1 ? unit.replace(/s$/, '') : unit}`;
  }

  if (value === 0) {
    return 'not reported';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  return `${size.toFixed(size < 10 && index > 0 ? 1 : 0)} ${units[index]}`;
}

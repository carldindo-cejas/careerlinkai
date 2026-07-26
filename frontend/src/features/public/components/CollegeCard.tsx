import { GraduationCap, MapPin } from 'lucide-react';

import { Blueprint } from '@/components/ui/blueprint';
import type { College } from '@/types/catalog';

/**
 * One college on the public site (prompt-driven, v1.5) — its name, school address, a short preview of
 * the programs it offers, and a "View on Google Maps" button when a map link is on file.
 *
 * The preview and the "+N more" count come straight from the API: `programs` is already capped to a
 * few, and `programs_count` carries the true total, so the overflow is `programs_count - programs`.
 * The Google Maps button is hidden entirely when there is no link — never a dead or disabled control.
 */

/** The resolved address, most specific level first, or null when the college has no location on file. */
function formatAddress(college: College): string | null {
  const parts = [college.barangay, college.town, college.province, college.region]
    .map((place) => place?.name)
    .filter((name): name is string => Boolean(name));

  return parts.length > 0 ? parts.join(', ') : null;
}

export function CollegeCard({ college }: { college: College }) {
  const address = formatAddress(college);
  const preview = college.programs ?? [];
  const total = college.programs_count ?? preview.length;
  const more = Math.max(0, total - preview.length);

  return (
    <Blueprint className="flex flex-col gap-4 bg-background p-6 text-foreground">
      <div className="flex items-start gap-2.5">
        <GraduationCap className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0">
          <h3 className="font-semibold leading-snug">{college.name}</h3>
          <p className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground">
            <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{address ?? 'Address not recorded'}</span>
          </p>
        </div>
      </div>

      {preview.length > 0 ? (
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Programs offered
          </p>
          <ul className="flex flex-wrap gap-2">
            {preview.map((program) => (
              <li
                key={program.id}
                className="rounded-none bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground/80"
                title={program.name}
              >
                {program.code}
                <span className="ml-1.5 font-normal text-muted-foreground">{program.name}</span>
              </li>
            ))}
            {more > 0 ? (
              <li className="rounded-none px-2.5 py-1 text-xs font-medium text-primary">
                +{more} more…
              </li>
            ) : null}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No programs listed yet.</p>
      )}

      {college.map_link ? (
        <a
          href={college.map_link}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-auto inline-flex h-9 w-fit items-center gap-2 rounded-none border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        >
          <MapPin className="size-4" aria-hidden="true" />
          View on Google Maps
        </a>
      ) : null}
    </Blueprint>
  );
}

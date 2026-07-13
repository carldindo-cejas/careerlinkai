import { Link2, X } from 'lucide-react';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useAttachCareer, useCareers, useDetachCareer } from '@/features/admin/hooks/useCatalog';
import { ApiRequestError } from '@/types/api';
import { describeHollandCode, type Program } from '@/types/catalog';

/**
 * The program <-> career mapping (FULLPLAN §57, §27).
 *
 * This is where a program stops being a name and becomes something the recommendation
 * engine can reason about: §27 averages the RIASEC compatibility of every career linked
 * here to produce the program's own RIASEC score. A program with nothing linked falls back
 * to a neutral 50 — so an empty mapping is a scoring decision, not an empty field, and the
 * UI says so out loud rather than leaving a blank space.
 */
export interface CareerMappingProps {
  collegeId: string;
  program: Program;
}

export function CareerMapping({ collegeId, program }: CareerMappingProps) {
  const [selectedCareerId, setSelectedCareerId] = useState('');

  const { data: careers } = useCareers();
  const attachCareer = useAttachCareer(collegeId);
  const detachCareer = useDetachCareer(collegeId);

  const linked = program.careers ?? [];
  const linkedIds = new Set(linked.map((career) => career.id));

  // Two exclusions, and both would otherwise offer an option that can only fail or can only
  // do nothing:
  //
  //   - already linked — re-attaching is a 422, because the mapping is a set;
  //   - archived — the server refuses to link one, and it would not count toward the
  //     program's score even if it did (§8, §27). A mapping row that is inert on the day it
  //     is made is not something to put in a dropdown.
  const available = (careers?.items ?? []).filter(
    (career) => !linkedIds.has(career.id) && career.status === 'active',
  );

  const error = attachCareer.error ?? detachCareer.error;
  const message = error instanceof ApiRequestError ? error.message : null;

  const onAttach = () => {
    if (!selectedCareerId) return;

    attachCareer.mutate(
      { programId: program.id, careerId: selectedCareerId },
      { onSuccess: () => setSelectedCareerId('') },
    );
  };

  return (
    <div className="flex flex-col gap-3 border-t border-slate-100 pt-3">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">
        <Link2 className="size-3.5" aria-hidden="true" />
        Careers this program leads to
      </div>

      {message ? <Alert>{message}</Alert> : null}

      {linked.length === 0 ? (
        <p className="text-sm text-slate-500">
          Not linked to any career yet — until it is, this program cannot be matched to a
          student's RIASEC profile.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {linked.map((career) => (
            <li key={career.id}>
              <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 py-1 pl-3 pr-1 text-sm text-slate-700">
                <span>
                  <span className={career.status === 'archived' ? 'line-through opacity-60' : ''}>
                    {career.title}
                  </span>
                  {career.typical_riasec_code ? (
                    <span
                      className="ml-1.5 font-mono text-xs tracking-wider text-slate-500"
                      title={describeHollandCode(career.typical_riasec_code) ?? undefined}
                    >
                      {career.typical_riasec_code}
                    </span>
                  ) : null}
                  {/*
                    The link survives archiving, but it stops counting: an archived career is
                    dropped from the program's RIASEC average (§27). Struck through and said
                    out loud, because a chip that looks live but scores nothing is worse than
                    no chip at all.
                  */}
                  {career.status === 'archived' ? (
                    <span className="ml-1.5 text-xs text-amber-700">archived — not counted</span>
                  ) : null}
                </span>

                <button
                  type="button"
                  onClick={() =>
                    detachCareer.mutate({ programId: program.id, careerId: career.id })
                  }
                  disabled={detachCareer.isPending}
                  className="rounded-full p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-50"
                  aria-label={`Unlink ${career.title} from ${program.code}`}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {available.length > 0 ? (
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <label htmlFor={`link-career-${program.id}`} className="sr-only">
              Link a career to {program.code}
            </label>
            <Select
              id={`link-career-${program.id}`}
              value={selectedCareerId}
              onChange={(event) => setSelectedCareerId(event.target.value)}
            >
              <option value="">Link a career…</option>
              {available.map((career) => (
                <option key={career.id} value={career.id}>
                  {career.title}
                  {career.typical_riasec_code ? ` (${career.typical_riasec_code})` : ''}
                </option>
              ))}
            </Select>
          </div>

          <Button
            type="button"
            variant="secondary"
            onClick={onAttach}
            disabled={!selectedCareerId}
            loading={attachCareer.isPending}
          >
            Link
          </Button>
        </div>
      ) : null}

      {careers && careers.items.length === 0 ? (
        <p className="text-sm text-slate-500">
          There are no careers in the catalog yet. Add some on the Careers page, then link
          them here.
        </p>
      ) : null}
    </div>
  );
}

import { Link2, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  CAREER_PICKER_PAGE_SIZE,
  useAttachCareer,
  useCareerSearch,
  useDetachCareer,
} from '@/features/admin/hooks/useCatalog';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/hooks/useDebouncedValue';
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
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [search, setSearch] = useState('');
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);

  /*
   * **The picker is server-backed now (audit F3).** It used to call `useCareers()`, which asked for
   * `per_page: 100` and treated the answer as the whole catalog, then filtered it in the browser.
   * That was true at 16 careers and false at 101 — the 101st simply was not in the dropdown, with
   * no empty state, no error and nothing on screen to distinguish "no such career" from "past the
   * page you were given". P0-1 took the catalog to 68, so the margin was one expansion wide.
   *
   * `isPickerOpen` keeps this from being a request per program row on page load: a college page
   * renders one `CareerMapping` per program, and a hook that fetched on mount would fire all of
   * them for a dropdown nobody has touched.
   */
  const careerSearch = useCareerSearch(debouncedSearch, isPickerOpen);

  const attachCareer = useAttachCareer(collegeId);
  const detachCareer = useDetachCareer(collegeId);

  const linked = program.careers ?? [];
  const linkedIds = useMemo(() => new Set(linked.map((career) => career.id)), [linked]);

  /*
   * One exclusion is still client-side: a career **already linked to this program**. Re-attaching
   * is a 422 (the mapping is a set), and the server cannot filter on it — "already linked" is a
   * fact about this program, and the careers endpoint knows nothing about programs.
   *
   * The other exclusion, `status === 'active'`, moved to the server: see `useCareerSearch`.
   */
  const available = useMemo(
    () =>
      (careerSearch.data?.items ?? [])
        .filter((career) => !linkedIds.has(career.id))
        .map((career) => ({
          id: career.id,
          name: career.typical_riasec_code
            ? `${career.title} (${career.typical_riasec_code})`
            : career.title,
        })),
    [careerSearch.data, linkedIds],
  );

  const total = careerSearch.data?.pagination.total ?? 0;
  const hiddenByPaging = Math.max(0, total - CAREER_PICKER_PAGE_SIZE);

  const error = attachCareer.error ?? detachCareer.error;
  const message = error instanceof ApiRequestError ? error.message : null;

  const onAttach = () => {
    if (!selected) return;

    attachCareer.mutate(
      { programId: program.id, careerId: selected.id },
      {
        onSuccess: () => {
          setSelected(null);
          setSearch('');
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Link2 className="size-3.5" aria-hidden="true" />
        Careers this program leads to
      </div>

      {message ? <Alert>{message}</Alert> : null}

      {linked.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Not linked to any career yet — until it is, this program cannot be matched to a
          student's RIASEC profile.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {linked.map((career) => (
            <li key={career.id}>
              <span className="inline-flex items-center gap-2 rounded-none border border-border bg-muted py-1 pl-3 pr-1 text-sm text-foreground/80">
                <span>
                  <span className={career.status === 'archived' ? 'line-through opacity-60' : ''}>
                    {career.title}
                  </span>
                  {career.typical_riasec_code ? (
                    <span
                      className="ml-1.5 font-mono text-xs tracking-wider text-muted-foreground"
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
                    <span className="ml-1.5 text-xs text-accent">archived — not counted</span>
                  ) : null}
                </span>

                <button
                  type="button"
                  onClick={() =>
                    detachCareer.mutate({ programId: program.id, careerId: career.id })
                  }
                  disabled={detachCareer.isPending}
                  className="rounded-none p-1 text-muted-foreground hover:bg-secondary hover:text-foreground/80 disabled:opacity-50"
                  aria-label={`Unlink ${career.title} from ${program.code}`}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/*
        Always rendered, unlike the old `<Select>`, which was hidden whenever `available` was empty.
        That was defensible when `available` meant "the whole catalog minus what is linked" — an
        empty list really did mean there was nothing to link. It is wrong for a typeahead, where an
        empty list usually means "nothing matches what you typed", and hiding the box would take
        away the only way to type something else.
      */}
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor={`link-career-${program.id}`} className="sr-only">
            Link a career to {program.code}
          </label>
          <Combobox
            id={`link-career-${program.id}`}
            value={selected?.id ?? null}
            selectedLabel={selected?.name ?? null}
            onChange={(id) =>
              setSelected(id === null ? null : (available.find((item) => item.id === id) ?? null))
            }
            options={available}
            query={search}
            onQueryChange={setSearch}
            onOpenChange={setIsPickerOpen}
            loading={careerSearch.isFetching}
            placeholder="Link a career…"
            searchPlaceholder="Search careers…"
            emptyText={
              search.trim() === ''
                ? 'No careers in the catalog yet — add some on the Careers page.'
                : `No active career matches “${search.trim()}”.`
            }
            footer={
              hiddenByPaging > 0
                ? `Showing ${CAREER_PICKER_PAGE_SIZE} of ${total} — keep typing to narrow it down.`
                : null
            }
            clearable
          />
        </div>

        <Button
          type="button"
          variant="secondary"
          onClick={onAttach}
          disabled={!selected}
          loading={attachCareer.isPending}
        >
          Link
        </Button>
      </div>
    </div>
  );
}

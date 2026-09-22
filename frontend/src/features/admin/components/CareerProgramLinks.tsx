import { GraduationCap, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  CANONICAL_OPTION_LIMIT,
  useAttachCanonicalCareer,
  useCanonicalProgramOptions,
  useCareerCanonicalPrograms,
  useDetachCanonicalCareer,
} from '@/features/admin/hooks/useCatalog';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/hooks/useDebouncedValue';
import { ApiRequestError } from '@/types/api';
import type { Career } from '@/types/catalog';

/**
 * "Programs that lead here" — the canonical program ↔ career links (backend migration 0040), read
 * and edited from the career's side.
 *
 * The same rows the Canonical programs page edits, so either screen is a valid place to make the
 * change: an admin adding "Data Scientist" to the catalog naturally wants to say which degrees lead
 * to it *there*, not go looking for each degree. A link made here applies to every college offering
 * the chosen program.
 */
export function CareerProgramLinks({ career }: { career: Career }) {
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [search, setSearch] = useState('');
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);

  const linked = useCareerCanonicalPrograms(career.id, true);
  const options = useCanonicalProgramOptions(debouncedSearch, isPickerOpen);

  const attach = useAttachCanonicalCareer();
  const detach = useDetachCanonicalCareer();

  const entries = linked.data ?? [];
  const linkedIds = useMemo(() => new Set(entries.map((entry) => entry.id)), [entries]);

  const available = (options.data ?? [])
    .filter((entry) => !linkedIds.has(entry.id))
    .map((entry) => ({ id: entry.id, name: `${entry.code} · ${entry.name}` }));

  const error = attach.error ?? detach.error;
  const message = error instanceof ApiRequestError ? error.message : null;
  const isArchived = career.status === 'archived';

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <GraduationCap className="size-3.5" aria-hidden="true" />
        Programs that lead here
      </div>

      {message ? <Alert>{message}</Alert> : null}

      {linked.isPending ? (
        <p className="text-sm text-muted-foreground">Loading programs…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No program leads here yet — until one does, no student is pointed to a degree for this
          career.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {entries.map((entry) => (
            <li key={entry.id}>
              <span className="inline-flex items-center gap-2 rounded-none border border-border bg-muted py-1 pl-3 pr-1 text-sm text-foreground/80">
                <span>
                  {entry.name}
                  <span className="ml-1.5 font-mono text-xs tracking-wider text-muted-foreground">
                    {entry.code}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => detach.mutate({ id: entry.id, careerId: career.id })}
                  disabled={detach.isPending}
                  className="rounded-none p-1 text-muted-foreground hover:bg-secondary hover:text-foreground/80 disabled:opacity-50"
                  aria-label={`Unlink ${entry.code} from ${career.title}`}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/*
        An archived career cannot be newly linked — the server refuses, since §27 would not count
        the link anyway. Saying so beats a picker whose every choice ends in an error.
      */}
      {isArchived ? (
        <p className="text-xs text-muted-foreground">
          Archived careers cannot be linked to new programs. Restore it first.
        </p>
      ) : (
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <label htmlFor={`link-program-${career.id}`} className="sr-only">
              Link a program to {career.title}
            </label>
            <Combobox
              id={`link-program-${career.id}`}
              value={selected?.id ?? null}
              selectedLabel={selected?.name ?? null}
              onChange={(id) =>
                setSelected(id === null ? null : (available.find((item) => item.id === id) ?? null))
              }
              options={available}
              query={search}
              onQueryChange={setSearch}
              onOpenChange={setIsPickerOpen}
              loading={options.isFetching}
              placeholder="Link a program…"
              searchPlaceholder="Search programs by name or code…"
              emptyText={
                search.trim() === ''
                  ? 'No other programs to link.'
                  : `No active program matches “${search.trim()}”.`
              }
              footer={
                (options.data?.length ?? 0) >= CANONICAL_OPTION_LIMIT
                  ? `Showing the first ${CANONICAL_OPTION_LIMIT} — keep typing to narrow it down.`
                  : null
              }
              clearable
            />
          </div>

          <Button
            type="button"
            variant="secondary"
            disabled={!selected}
            loading={attach.isPending}
            onClick={() => {
              if (!selected) return;

              attach.mutate(
                { id: selected.id, careerId: career.id },
                {
                  onSuccess: () => {
                    setSelected(null);
                    setSearch('');
                  },
                },
              );
            }}
          >
            Link
          </Button>
        </div>
      )}
    </div>
  );
}

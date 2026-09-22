import { Link2, Pencil, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Combobox } from '@/components/ui/combobox';
import { CAREER_PICKER_PAGE_SIZE, useCareerSearch } from '@/features/admin/hooks/useCatalog';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/hooks/useDebouncedValue';
import { ApiRequestError } from '@/types/api';
import {
  describeHollandCode,
  LINK_RELATIONSHIPS,
  type LinkedCareer,
  type LinkRelationship,
} from '@/types/catalog';

/**
 * The chips-and-picker editor for "the careers this leads to" — shared by one college's offering
 * (`CareerMapping`) and by a canonical program (`CanonicalCareerMapping`, backend migration 0040).
 *
 * The two differ only in *where* a link is written and in one thing an offering has that a
 * canonical program does not: **inherited** links. Those come from the offering's canonical program,
 * apply to every college offering it, and are removed there — so their chip carries `inheritedLabel`
 * where the remove button would be, and the picker never offers them again. They *can* be re-graded
 * from here: how strongly a degree leads to a career is a fact about the degree, so the grade picker
 * writes it to the canonical link and says, before saving, that every college gets the change.
 *
 * Everything else is the §27 contract both share: a linked career is a vote on the program's RIASEC
 * score, an archived one stays linked but stops counting, and an empty mapping is a scoring decision
 * the screen states out loud.
 */
export interface CareerLinkEditorProps {
  inputId: string;
  /** Names the thing being linked in the accessible labels — "Link a career to BSCS". */
  targetLabel: string;
  heading: string;
  linked: LinkedCareer[];
  /** What an empty mapping means for scoring, said in the words of this screen. */
  emptyText: string;
  onAttach: (careerId: string, relationship: LinkRelationship, onDone: () => void) => void;
  onDetach: (careerId: string) => void;
  /**
   * Re-grade a link — direct, related or conditional (backend migration 0041). When given, every
   * chip can be selected, and a selected chip shows a pencil that opens the grade picker. The caller
   * decides where the change is written: an inherited link is re-graded on its canonical program,
   * which is why the picker states `inheritedEditNote` for one.
   */
  onChangeRelationship?: (
    career: LinkedCareer,
    relationship: LinkRelationship,
    onDone: () => void,
  ) => void;
  isChangingRelationship?: boolean;
  /** Said in the grade picker for an inherited link — who else the change reaches. */
  inheritedEditNote?: string;
  isAttaching: boolean;
  isDetaching: boolean;
  error: unknown;
  /** Shown in place of the remove button on an inherited chip, e.g. "from BSCS". */
  inheritedLabel?: string;
  /** A line under the heading, when the screen has something to explain about where links live. */
  note?: ReactNode;
}

/** Weight, not hue, carries the grade — the mono scheme has one accent (see `Badge`). */
const RELATIONSHIP_TONE: Record<LinkRelationship, string> = {
  direct: 'font-medium text-primary',
  related: 'text-muted-foreground',
  conditional: 'text-accent',
};

function relationshipLabel(relationship: LinkRelationship): string {
  return LINK_RELATIONSHIPS.find((option) => option.value === relationship)?.label ?? relationship;
}

function relationshipHint(relationship: LinkRelationship): string | undefined {
  return LINK_RELATIONSHIPS.find((option) => option.value === relationship)?.hint;
}

export function CareerLinkEditor({
  inputId,
  targetLabel,
  heading,
  linked,
  emptyText,
  onAttach,
  onDetach,
  isAttaching,
  isDetaching,
  error,
  inheritedLabel,
  note,
  onChangeRelationship,
  isChangingRelationship = false,
  inheritedEditNote,
}: CareerLinkEditorProps) {
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [newRelationship, setNewRelationship] = useState<LinkRelationship>('direct');
  const [search, setSearch] = useState('');
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  /*
   * Re-grading is two steps: select a chip (its pencil appears), then open the picker with the
   * pencil. A select box on every chip made thirty grades look like thirty open forms, and could not
   * say which of them reach every college.
   */
  const [selectedChipId, setSelectedChipId] = useState<string | null>(null);
  const [editingChipId, setEditingChipId] = useState<string | null>(null);
  const [draftRelationship, setDraftRelationship] = useState<LinkRelationship>('direct');

  const canRegrade = onChangeRelationship !== undefined;
  const editing = linked.find((career) => career.id === editingChipId) ?? null;

  const toggleChip = (careerId: string) => {
    setSelectedChipId((current) => (current === careerId ? null : careerId));
    setEditingChipId(null);
  };

  const startEditing = (career: LinkedCareer) => {
    setEditingChipId(career.id);
    setDraftRelationship(career.relationship ?? 'direct');
  };

  const stopEditing = () => {
    setEditingChipId(null);
    setSelectedChipId(null);
  };

  const saveRelationship = () => {
    if (!editing || !onChangeRelationship) return;

    onChangeRelationship(editing, draftRelationship, stopEditing);
  };

  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);

  /*
   * **The picker is server-backed (audit F3).** It used to call `useCareers()`, which asked for
   * `per_page: 100` and treated the answer as the whole catalog, then filtered it in the browser.
   * That was true at 16 careers and false at 101 — the 101st simply was not in the dropdown, with
   * no empty state, no error and nothing on screen to distinguish "no such career" from "past the
   * page you were given".
   *
   * `isPickerOpen` keeps this from being a request per row on page load: a college page renders one
   * editor per program and the canonical page one per entry, and a hook that fetched on mount would
   * fire all of them for a dropdown nobody has touched.
   */
  const careerSearch = useCareerSearch(debouncedSearch, isPickerOpen);

  const linkedIds = useMemo(() => new Set(linked.map((career) => career.id)), [linked]);

  /*
   * One exclusion is still client-side: a career **already linked here**, inherited or not.
   * Re-attaching is a 422 (the mapping is a set), and the server cannot filter on it — "already
   * linked" is a fact about this program, and the careers endpoint knows nothing about programs.
   *
   * The other exclusion, `status === 'active'`, is server-side: see `useCareerSearch`.
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

  const message = error instanceof ApiRequestError ? error.message : null;

  const attach = () => {
    if (!selected) return;

    onAttach(selected.id, newRelationship, () => {
      setSelected(null);
      setSearch('');
      setNewRelationship('direct');
    });
  };

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Link2 className="size-3.5" aria-hidden="true" />
        {heading}
      </div>

      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}

      {message ? <Alert>{message}</Alert> : null}

      {linked.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {linked.map((career) => {
            const isSelected = selectedChipId === career.id;
            const relationship = career.relationship ?? 'direct';

            const body = (
              <>
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
                  How strongly it leads there (migration 0041), on every chip: once links are
                  graded, an unlabelled chip would read as "direct" and "not yet graded" alike.
                */}
                <span
                  className={cn('ml-1.5 text-xs', RELATIONSHIP_TONE[relationship])}
                  title={relationshipHint(relationship)}
                >
                  · {relationshipLabel(relationship)}
                </span>
                {/*
                  The link survives archiving, but it stops counting: an archived career is
                  dropped from the program's RIASEC average (§27). Struck through and said
                  out loud, because a chip that looks live but scores nothing is worse than
                  no chip at all.
                */}
                {career.status === 'archived' ? (
                  <span className="ml-1.5 text-xs text-accent">archived — not counted</span>
                ) : null}
              </>
            );

            return (
              <li key={career.id}>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-none border py-1 pl-1 pr-1 text-sm text-foreground/80',
                    isSelected ? 'border-primary bg-primary/5' : 'border-border bg-muted',
                  )}
                >
                  {canRegrade ? (
                    <button
                      type="button"
                      onClick={() => toggleChip(career.id)}
                      aria-pressed={isSelected}
                      className="rounded-none px-2 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {body}
                    </button>
                  ) : (
                    <span className="px-2">{body}</span>
                  )}

                  {career.inherited ? (
                    // Not a disabled button: there is nothing to remove here, and a greyed-out
                    // control reads as "you lack permission" rather than "this lives elsewhere".
                    <span className="px-1 text-xs text-muted-foreground">{inheritedLabel}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onDetach(career.id)}
                      disabled={isDetaching}
                      className="rounded-none p-1 text-muted-foreground hover:bg-secondary hover:text-foreground/80 disabled:opacity-50"
                      aria-label={`Unlink ${career.title} from ${targetLabel}`}
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  )}

                  {isSelected ? (
                    <button
                      type="button"
                      onClick={() => startEditing(career)}
                      aria-expanded={editingChipId === career.id}
                      className="rounded-none p-1 text-primary hover:bg-secondary"
                      aria-label={`Edit how strongly ${targetLabel} leads to ${career.title}`}
                    >
                      <Pencil className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {canRegrade && linked.length > 0 && editing === null ? (
        <p className="text-xs text-muted-foreground">
          Select a career, then its pencil, to change whether it is direct, related or conditional.
        </p>
      ) : null}

      {editing ? (
        <fieldset className="flex flex-col gap-3 border border-primary/40 bg-primary/5 p-3">
          <legend className="px-1 text-sm font-medium text-foreground">
            How strongly {targetLabel} leads to {editing.title}
          </legend>

          <div className="flex flex-col gap-2 sm:flex-row">
            {LINK_RELATIONSHIPS.map((option) => (
              <label
                key={option.value}
                className={cn(
                  'flex flex-1 cursor-pointer items-start gap-2 border p-2 text-sm',
                  draftRelationship === option.value
                    ? 'border-primary bg-background'
                    : 'border-border bg-background/60 hover:border-primary/50',
                )}
              >
                <input
                  type="radio"
                  name={`${inputId}-relationship`}
                  value={option.value}
                  checked={draftRelationship === option.value}
                  onChange={() => setDraftRelationship(option.value)}
                  className="mt-0.5 accent-primary"
                />
                <span className="flex flex-col">
                  <span className="font-medium text-foreground">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>

          {editing.inherited && inheritedEditNote ? (
            <p className="text-xs text-muted-foreground">{inheritedEditNote}</p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={stopEditing}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={saveRelationship}
              disabled={draftRelationship === (editing.relationship ?? 'direct')}
              loading={isChangingRelationship}
            >
              Save
            </Button>
          </div>
        </fieldset>
      ) : null}

      {/*
        Always rendered: an empty option list in a typeahead usually means "nothing matches what
        you typed", and hiding the box would take away the only way to type something else.
      */}
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor={inputId} className="sr-only">
            Link a career to {targetLabel}
          </label>
          <Combobox
            id={inputId}
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

        <select
          value={newRelationship}
          onChange={(event) => setNewRelationship(event.target.value as LinkRelationship)}
          aria-label={`How strongly ${targetLabel} leads to the career being linked`}
          className="h-11 rounded-none border border-border bg-background px-2 text-sm sm:h-10"
        >
          {LINK_RELATIONSHIPS.map((option) => (
            <option key={option.value} value={option.value} title={option.hint}>
              {option.label}
            </option>
          ))}
        </select>

        <Button
          type="button"
          variant="secondary"
          onClick={attach}
          disabled={!selected}
          loading={isAttaching}
        >
          Link
        </Button>
      </div>
    </div>
  );
}

import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  useCounselorClasses,
  useCounselors,
  useReassignClass,
} from '@/features/admin/hooks/usePlatformAdmin';
import { toast } from '@/stores/toastStore';

/**
 * The classes one counselor owns, and the control that hands them to someone else
 * (audit F5, plan P3-6).
 *
 * ## Why this screen has to exist at all
 *
 * `classes.counselor_id` was set at creation and writable by nothing. When a counselor left, their
 * classes stayed pointed at the removed account: an admin could still see them, but no replacement
 * could ever be *given* them — so the replacement could not read their own students' results, use
 * the join code, or close the assignments. The backend now has `PATCH /admin/classes/{id}`, and
 * this is the only thing that calls it. An endpoint with no caller is the F1/F2 defect this plan
 * opens by naming, and P3-2a found a third instance of it still sitting in the catalog module.
 *
 * ## One target, many classes
 *
 * The picker is chosen **once**, at the top, and each class carries its own Reassign button. That
 * is deliberate rather than lazy: the common case is one departing counselor and one replacement,
 * where re-picking per row would be nine identical choices; the less common case — splitting a
 * leaver's load between two people — still works, because the target is just changed between
 * presses. A "reassign all" button would be one press instead of nine and is not here on purpose:
 * it would be N requests behind one control, so a failure halfway through leaves a state nobody
 * asked for and no row on screen says which half moved. Each press is one endpoint call and one
 * audit row.
 */

/** The picker shows this many matches; the server caps the page and the footer says so. */
const PICKER_PAGE_SIZE = 20;

export function CounselorClassesPanel({
  counselorId,
  counselorName,
}: {
  counselorId: string;
  counselorName: string;
}) {
  const { data, isPending, isError, error } = useCounselorClasses(counselorId);
  const reassign = useReassignClass(counselorId);

  const [target, setTarget] = useState<string | null>(null);
  const [targetLabel, setTargetLabel] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);

  /**
   * Fetched on **open**, not on mount (the P2-1 / P3-2 guarantee): a counselor detail page that is
   * mostly a student table should not spend a request on a picker nobody touched.
   */
  const candidates = useCounselors(
    {
      status: 'active',
      ...(debouncedQuery.trim() === '' ? {} : { search: debouncedQuery.trim() }),
    },
    pickerOpen,
  );

  // The counselor being emptied is never a candidate for their own classes — the server treats
  // same-owner as a no-op, but offering it is offering a button that does nothing.
  const options = (candidates.data?.items ?? [])
    .filter((candidate) => candidate.id !== counselorId)
    .slice(0, PICKER_PAGE_SIZE)
    .map((candidate) => ({ id: candidate.id, name: candidate.name }));

  const total = candidates.data?.pagination.total ?? 0;

  async function onReassign(classId: string, className: string) {
    if (target === null) {
      return;
    }

    try {
      await reassign.mutateAsync({ classId, counselorId: target });
      toast.success(`${className} is now ${targetLabel ?? 'their'}’s class.`);
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : 'The class could not be reassigned.');
    }
  }

  if (isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h2">Classes</CardTitle>
          <CardDescription>Loading this counselor’s classes…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h2">Classes</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>We could not load this counselor’s classes. {error.message}</Alert>
        </CardContent>
      </Card>
    );
  }

  const classes = data.items;

  if (classes.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h2">Classes</CardTitle>
          <CardDescription>
            {counselorName} has no classes. Their account can be removed from the counselor list.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">
          Classes ({data.pagination.total})
        </CardTitle>
        <CardDescription>
          A class belongs to one counselor, and that is who can see its roster, results and join
          code. Hand these to a replacement before removing {counselorName} — an account with
          classes cannot be removed, because the classes would be left with an owner who no longer
          exists.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <Label htmlFor="reassign-target">Hand a class to</Label>
          <Combobox
            id="reassign-target"
            value={target}
            selectedLabel={targetLabel}
            onChange={(id) => {
              setTarget(id);
              setTargetLabel(options.find((option) => option.id === id)?.name ?? null);
            }}
            options={options}
            onOpenChange={setPickerOpen}
            onQueryChange={setQuery}
            query={query}
            loading={candidates.isFetching}
            placeholder="Choose a counselor…"
            searchPlaceholder="Search counselors…"
            emptyText="No other active counselor matches."
            clearable
            // F3's lesson, applied to a picker rather than a list: silence about the rest is what
            // makes a truncation invisible.
            footer={
              total > options.length
                ? `Showing ${options.length} of ${total} — keep typing to narrow it down.`
                : null
            }
          />
          <p className="text-xs text-muted-foreground">
            Only active counselors are offered: a class handed to a suspended or removed account
            would be one nobody can manage, which is the problem this fixes.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Class</th>
                <th className="px-4 py-2.5 font-medium">Year</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">
                  <span className="sr-only">Reassign</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {classes.map((classRoom) => (
                <tr key={classRoom.id} className="border-b border-border/60">
                  <td className="px-4 py-3 font-medium text-foreground">{classRoom.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{classRoom.academic_year}</td>
                  <td className="px-4 py-3">
                    <Badge tone={classRoom.status === 'active' ? 'success' : 'neutral'}>
                      {classRoom.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={target === null || reassign.isPending}
                      // Every row's button is otherwise named "Reassign", so a screen reader
                      // reaching one has nothing to say which class is about to move — the same
                      // defect P3-2a found on the canonical-programme rows.
                      aria-label={`Reassign ${classRoom.name}`}
                      onClick={() => void onReassign(classRoom.id, classRoom.name)}
                    >
                      Reassign
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {target === null ? (
          <p className="text-xs text-muted-foreground">
            Choose a counselor above to enable the Reassign buttons.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

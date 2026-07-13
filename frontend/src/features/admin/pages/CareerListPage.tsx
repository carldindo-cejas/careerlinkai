import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CareerForm } from '@/features/admin/components/CareerForm';
import { useCareers, useDeleteCareer, useUpdateCareer } from '@/features/admin/hooks/useCatalog';
import { describeHollandCode, type Career } from '@/types/catalog';

/**
 * The careers in the catalog (FULLPLAN §57, Phase 2).
 *
 * Careers are global rather than nested under a college — the same "Software Engineer" is
 * the destination of programs at many institutions, which is exactly what the mapping on
 * the college page exists to express.
 */
export function CareerListPage() {
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data, isPending, isError, error } = useCareers();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Careers</h1>
          <p className="text-sm text-slate-500">
            What programs lead to. Each career's RIASEC code is what a student's assessment
            result is matched against.
          </p>
        </div>

        {!isAdding ? (
          <Button onClick={() => setIsAdding(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Add career
          </Button>
        ) : null}
      </div>

      {isAdding ? (
        <CareerForm onSaved={() => setIsAdding(false)} onCancel={() => setIsAdding(false)} />
      ) : null}

      {isPending ? (
        <div className="flex justify-center py-12" role="status">
          <Loader2 className="size-6 animate-spin text-slate-400" aria-hidden="true" />
          <span className="sr-only">Loading careers…</span>
        </div>
      ) : null}

      {isError ? <Alert>{error.message}</Alert> : null}

      {data && data.items.length === 0 && !isAdding ? (
        <Card>
          <CardHeader>
            <CardTitle>No careers yet</CardTitle>
            <CardDescription>
              Add the careers students might pursue, then link them to programs from each
              college's page.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <ul className="flex flex-col gap-3">
        {(data?.items ?? []).map((career) =>
          editingId === career.id ? (
            <li key={career.id}>
              <CareerForm
                career={career}
                onSaved={() => setEditingId(null)}
                onCancel={() => setEditingId(null)}
              />
            </li>
          ) : (
            <li key={career.id}>
              <CareerRow career={career} onEdit={() => setEditingId(career.id)} />
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function CareerRow({ career, onEdit }: { career: Career; onEdit: () => void }) {
  const deleteCareer = useDeleteCareer();
  const updateCareer = useUpdateCareer();

  const isArchived = career.status === 'archived';

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-900">{career.title}</span>

            {career.typical_riasec_code ? (
              <span
                className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-semibold tracking-widest text-slate-700"
                title={describeHollandCode(career.typical_riasec_code) ?? undefined}
              >
                {career.typical_riasec_code}
              </span>
            ) : (
              // Not a missing value to be nagged about — a career with no code is a valid
              // entry that simply cannot be RIASEC-matched. Saying which is more useful
              // than an empty cell.
              <span className="text-xs text-amber-700">No RIASEC code — cannot be matched</span>
            )}

            <Badge tone={isArchived ? 'neutral' : 'success'}>{career.status}</Badge>
          </div>

          <p className="mt-0.5 truncate text-sm text-slate-500">
            {[career.employment_outlook, career.salary_range].filter(Boolean).join(' · ') ||
              'No outlook or salary recorded'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            loading={updateCareer.isPending}
            onClick={() =>
              updateCareer.mutate({
                id: career.id,
                payload: { status: isArchived ? 'active' : 'archived' },
              })
            }
          >
            {isArchived ? 'Restore' : 'Archive'}
          </Button>

          <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${career.title}`}>
            <Pencil className="size-4" aria-hidden="true" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            loading={deleteCareer.isPending}
            aria-label={`Delete ${career.title}`}
            onClick={() => {
              if (
                !window.confirm(
                  `Remove ${career.title} from the catalog? It will be unlinked from every program. To stop recommending it while keeping it, archive it instead.`,
                )
              ) {
                return;
              }

              deleteCareer.mutate(career.id);
            }}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

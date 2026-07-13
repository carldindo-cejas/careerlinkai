import { ArrowLeft, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CareerMapping } from '@/features/admin/components/CareerMapping';
import { ProgramForm } from '@/features/admin/components/ProgramForm';
import {
  useCollege,
  useDeleteCollege,
  useDeleteProgram,
  useUpdateCollege,
} from '@/features/admin/hooks/useCatalog';
import { paths } from '@/routes/paths';
import type { Program, ProgramStatus } from '@/types/catalog';

/**
 * One college, its programs, and where each program leads (FULLPLAN §57, Phase 2).
 *
 * The whole §57 Phase 2 demo happens on this screen except for the careers themselves:
 * programs are added under the college, given a recommended strand, and mapped to careers.
 */
export function CollegeDetailPage() {
  const { collegeId = '' } = useParams();
  const navigate = useNavigate();

  const { data: college, isPending, isError, error } = useCollege(collegeId);

  const updateCollege = useUpdateCollege(collegeId);
  const deleteCollege = useDeleteCollege();
  const deleteProgram = useDeleteProgram(collegeId);

  const [isAddingProgram, setIsAddingProgram] = useState(false);
  const [editingProgramId, setEditingProgramId] = useState<string | null>(null);

  if (isPending) {
    return (
      <div className="flex justify-center py-12" role="status">
        <Loader2 className="size-6 animate-spin text-slate-400" aria-hidden="true" />
        <span className="sr-only">Loading college…</span>
      </div>
    );
  }

  if (isError) {
    return <Alert>{error.message}</Alert>;
  }

  const programs = college.programs ?? [];
  const isArchived = college.status === 'archived';

  return (
    <div className="flex flex-col gap-6">
      <Link
        to={paths.adminColleges}
        className="inline-flex w-fit items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        All colleges
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-slate-900">{college.name}</h1>
            <Badge tone={isArchived ? 'neutral' : 'success'}>{college.status}</Badge>
          </div>
          {college.description ? (
            <p className="mt-1 text-sm text-slate-500">{college.description}</p>
          ) : null}
        </div>

        <div className="flex gap-2">
          {/*
            Archiving is the intended way to retire a college (§8) — the row and everything
            pointing at it survives, so a recommendation a student has already seen never
            dangles. Deleting is the harsher, rarer act, and is worded as such.
          */}
          <Button
            variant="secondary"
            loading={updateCollege.isPending}
            onClick={() =>
              updateCollege.mutate({ status: isArchived ? 'active' : 'archived' })
            }
          >
            {isArchived ? 'Restore' : 'Archive'}
          </Button>

          <Button
            variant="ghost"
            loading={deleteCollege.isPending}
            onClick={() => {
              if (
                !window.confirm(
                  `Remove ${college.name} from the catalog? Its programs go with it. If you only want to stop recommending it, archive it instead.`,
                )
              ) {
                return;
              }

              deleteCollege.mutate(collegeId, {
                onSuccess: () => void navigate(paths.adminColleges),
              });
            }}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Delete
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-slate-900">
          Programs
          <span className="ml-2 text-sm font-normal text-slate-500">
            {programs.length === 0
              ? 'none yet'
              : `${programs.length} ${programs.length === 1 ? 'program' : 'programs'}`}
          </span>
        </h2>

        {!isAddingProgram ? (
          <Button size="sm" onClick={() => setIsAddingProgram(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Add program
          </Button>
        ) : null}
      </div>

      {isAddingProgram ? (
        <ProgramForm
          collegeId={collegeId}
          onSaved={() => setIsAddingProgram(false)}
          onCancel={() => setIsAddingProgram(false)}
        />
      ) : null}

      {programs.length === 0 && !isAddingProgram ? (
        <Card>
          <CardHeader>
            <CardTitle>No programs yet</CardTitle>
            <CardDescription>
              Add the programs this college offers. Each one can be linked to the careers it
              leads to — that mapping is what lets a student be matched to it.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <ul className="flex flex-col gap-4">
        {programs.map((program) =>
          editingProgramId === program.id ? (
            <li key={program.id}>
              <ProgramForm
                collegeId={collegeId}
                program={program}
                onSaved={() => setEditingProgramId(null)}
                onCancel={() => setEditingProgramId(null)}
              />
            </li>
          ) : (
            <li key={program.id}>
              <ProgramCard
                collegeId={collegeId}
                program={program}
                onEdit={() => setEditingProgramId(program.id)}
                onDelete={() => {
                  if (!window.confirm(`Remove ${program.code} — ${program.name}?`)) return;

                  deleteProgram.mutate(program.id);
                }}
              />
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

interface ProgramCardProps {
  collegeId: string;
  program: Program;
  onEdit: () => void;
  onDelete: () => void;
}

function ProgramCard({ collegeId, program, onEdit, onDelete }: ProgramCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>
              <span className="font-mono text-sm tracking-wide text-slate-500">{program.code}</span>
              <span className="ml-2">{program.name}</span>
            </CardTitle>
            <CardDescription>
              {program.department_name ?? 'No department'}
              {' · '}
              {/*
                Null is not a gap here — it is a claim. §27 scores a program with no strand
                requirement as a full 100 for every student, so "Open to any strand" is the
                accurate reading, not "Unknown".
              */}
              {program.recommended_strand ?? 'Open to any strand'}
            </CardDescription>
          </div>

          <div className="flex items-center gap-2">
            <Badge tone={programStatusTone(program.status)}>{program.status}</Badge>

            <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${program.code}`}>
              <Pencil className="size-4" aria-hidden="true" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              aria-label={`Delete ${program.code}`}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <CareerMapping collegeId={collegeId} program={program} />
      </CardContent>
    </Card>
  );
}

/**
 * Only an active program is ever recommended (§27) — status is the difference between a
 * program students can be matched to and one that merely exists.
 */
function programStatusTone(status: ProgramStatus): 'success' | 'warning' | 'neutral' {
  switch (status) {
    case 'active':
      return 'success';
    case 'draft':
      return 'warning';
    case 'archived':
      return 'neutral';
  }
}

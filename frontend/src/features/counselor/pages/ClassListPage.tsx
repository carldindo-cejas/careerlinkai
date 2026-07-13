import { Loader2, Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CreateClassForm } from '@/features/counselor/components/CreateClassForm';
import { useClasses } from '@/features/counselor/hooks/useClasses';
import { classDetailPath } from '@/routes/paths';
import type { ClassRoom, ClassStatus } from '@/types/class';

/**
 * The counselor's classes (FULLPLAN §57, Phase 1A).
 */
export function ClassListPage() {
  const [isCreating, setIsCreating] = useState(false);
  const navigate = useNavigate();

  const { data, isPending, isError, error } = useClasses();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Classes</h1>
          <p className="text-sm text-slate-500">
            Create a class, share its code, and build the roster.
          </p>
        </div>

        {!isCreating ? (
          <Button onClick={() => setIsCreating(true)}>
            <Plus className="size-4" aria-hidden="true" />
            New class
          </Button>
        ) : null}
      </div>

      {isCreating ? (
        <CreateClassForm
          onCancel={() => setIsCreating(false)}
          // Straight to the new class: the code is on that screen, and reading it out is
          // the next thing the counselor actually does (§57).
          onCreated={(created) => {
            setIsCreating(false);
            void navigate(classDetailPath(created.id));
          }}
        />
      ) : null}

      {isPending ? (
        <div className="flex justify-center py-12" role="status">
          <Loader2 className="size-6 animate-spin text-slate-400" aria-hidden="true" />
          <span className="sr-only">Loading classes…</span>
        </div>
      ) : null}

      {isError ? <Alert>{error.message}</Alert> : null}

      {data && data.items.length === 0 && !isCreating ? (
        <Card>
          <CardHeader>
            <CardTitle>No classes yet</CardTitle>
            <CardDescription>
              Create your first class to get a class code your students can use to sign in.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {data && data.items.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2">
          {data.items.map((classRoom) => (
            <li key={classRoom.id}>
              <ClassCard classRoom={classRoom} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ClassCard({ classRoom }: { classRoom: ClassRoom }) {
  return (
    <Card className="h-full transition-colors hover:border-slate-300">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>
            <Link
              to={classDetailPath(classRoom.id)}
              className="hover:underline focus-visible:outline-none focus-visible:underline"
            >
              {classRoom.name}
            </Link>
          </CardTitle>
          <Badge tone={statusTone(classRoom.status)}>{classRoom.status}</Badge>
        </div>
        <CardDescription>
          {classRoom.academic_year}
          {classRoom.grade_level ? ` · ${classRoom.grade_level}` : null}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Class code</p>
          <p className="font-mono text-lg font-semibold tracking-wider text-slate-900">
            {classRoom.join_code}
          </p>
        </div>

        <Link
          to={classDetailPath(classRoom.id)}
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
        >
          <Users className="size-4" aria-hidden="true" />
          Roster
        </Link>
      </CardContent>
    </Card>
  );
}

/**
 * Only an active class admits students (§13.2) — so status is not decoration here, it is
 * the difference between a code that works and one that does not.
 */
function statusTone(status: ClassStatus): 'success' | 'warning' | 'neutral' {
  switch (status) {
    case 'active':
      return 'success';
    case 'draft':
      return 'warning';
    case 'archived':
      return 'neutral';
  }
}

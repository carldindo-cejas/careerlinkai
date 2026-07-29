import { ArrowLeft, ChevronDown, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { StudentRecommendationLists } from '@/components/recommendations/StudentRecommendationLists';
import { CounselorClassesPanel } from '@/features/admin/components/CounselorClassesPanel';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { Input } from '@/components/ui/input';
import { useCounselorStudents } from '@/features/admin/hooks/usePlatformAdmin';
import { paths } from '@/routes/paths';
import type { CounselorStudentRow } from '@/types/platform';

/**
 * The counselor detail page (prompt-driven §20): every student assigned to one counselor, with
 * their Grade Level, Strand, Holland Code, and top career/college recommendation shown by default —
 * each row expanding to reveal the top five of each.
 *
 * The roster is bounded (a counselor's classes hold tens of students), so the server returns it
 * whole and the search / sort / pagination all run here, over data already in hand. The heavy part —
 * hydrating every student's recommendations — was done N+1-free on the server.
 */

const PER_PAGE = 10;

type SortField = 'name' | 'grade_level' | 'strand' | 'holland_code';
type SortDirection = 'asc' | 'desc';

export function CounselorDetailPage() {
  const { counselorId = '' } = useParams();
  const { data, isPending, isError, error } = useCounselorStudents(counselorId);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortField>('name');
  const [direction, setDirection] = useState<SortDirection>('asc');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const students = data?.students ?? [];

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matched =
      term.length === 0
        ? students
        : students.filter((student) =>
            [student.name, student.strand, student.holland_code, student.grade_level]
              .filter(Boolean)
              .some((value) => value!.toLowerCase().includes(term)),
          );

    const sorted = [...matched].sort((a, b) => compare(a, b, sort));

    return direction === 'asc' ? sorted : sorted.reverse();
  }, [students, search, sort, direction]);

  const lastPage = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const currentPage = Math.min(page, lastPage);
  const pageItems = filtered.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);

  function onSort(field: SortField) {
    if (field === sort) {
      setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(field);
      setDirection('asc');
    }
    setPage(1);
  }

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  if (isPending) {
    return (
      <div className="flex justify-center py-12" role="status">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Loading counselor…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <Alert>We could not load this counselor’s students. {error.message}</Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <BackLink />

      <div>
        <h1 className="text-xl font-semibold text-foreground">{data.counselor.name}</h1>
        <p className="text-sm text-muted-foreground">
          {data.counselor.email}
          {data.counselor.specialization ? ` · ${data.counselor.specialization}` : ''}
        </p>
      </div>

      {/*
        The classes this counselor owns, and the only control in the system that moves one
        (audit F5, plan P3-6). It sits above the student table because reassignment is what an
        admin comes to this page to *do* when a counselor is leaving — the students below are the
        thing being handed over, and they follow their class.
      */}
      <CounselorClassesPanel counselorId={counselorId} counselorName={data.counselor.name} />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="student-search" className="text-sm font-medium text-foreground">
            Search students
          </label>
          <Input
            id="student-search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Name, strand, or Holland code"
            className="w-72"
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {filtered.length} {filtered.length === 1 ? 'student' : 'students'}
        </p>
      </div>

      {students.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No students yet</CardTitle>
            <CardDescription>
              This counselor has no students enrolled in their classes. Once students join and take
              their assessments, their recommendations appear here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No students match that search</CardTitle>
            <CardDescription>Clear the search to see the whole roster.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <SortableHeader label="Student" field="name" sort={sort} direction={direction} onSort={onSort} />
                    <SortableHeader label="Grade" field="grade_level" sort={sort} direction={direction} onSort={onSort} />
                    <SortableHeader label="Strand" field="strand" sort={sort} direction={direction} onSort={onSort} />
                    <SortableHeader label="Holland" field="holland_code" sort={sort} direction={direction} onSort={onSort} />
                    <th className="px-4 py-2.5 font-medium">Top college</th>
                    <th className="px-4 py-2.5 font-medium">Top career</th>
                    <th className="w-10 px-4 py-2.5" />
                  </tr>
                </thead>

                <tbody>
                  {pageItems.map((student) => (
                    <StudentRows
                      key={student.id}
                      student={student}
                      expanded={expanded.has(student.id)}
                      onToggle={() => toggle(student.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {lastPage > 1 ? (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {currentPage} of {lastPage}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={currentPage >= lastPage}
                  onClick={() => setPage(currentPage + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to={paths.adminCounselors}
      className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      All counselors
    </Link>
  );
}

function SortableHeader({
  label,
  field,
  sort,
  direction,
  onSort,
}: {
  label: string;
  field: SortField;
  sort: SortField;
  direction: SortDirection;
  onSort: (field: SortField) => void;
}) {
  const active = sort === field;

  return (
    <th className="px-4 py-2.5 font-medium">
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cn('inline-flex items-center gap-1 hover:text-foreground', active && 'text-foreground')}
      >
        {label}
        {active ? <span aria-hidden="true">{direction === 'asc' ? '▲' : '▼'}</span> : null}
      </button>
    </th>
  );
}

function StudentRows({
  student,
  expanded,
  onToggle,
}: {
  student: CounselorStudentRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const topCareer = student.top_careers[0];
  const topProgram = student.top_programs[0];

  return (
    <>
      <tr
        className="cursor-pointer border-b border-border/60 align-top hover:bg-muted/30"
        onClick={onToggle}
      >
        <td className="px-4 py-3 font-medium text-foreground">{student.name}</td>
        <td className="px-4 py-3 text-muted-foreground">{student.grade_level ?? '—'}</td>
        <td className="px-4 py-3 text-muted-foreground">{student.strand ?? '—'}</td>
        <td className="px-4 py-3">
          {student.holland_code ? (
            <Badge className="font-mono">{student.holland_code}</Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-muted-foreground">
          {topProgram ? (
            <span>
              <span className="text-foreground">{topProgram.college.name}</span>
              <span className="block text-xs">{topProgram.program.name}</span>
            </span>
          ) : (
            'No recommendations yet'
          )}
        </td>
        <td className="px-4 py-3 text-muted-foreground">
          {topCareer ? <span className="text-foreground">{topCareer.career.title}</span> : '—'}
        </td>
        <td className="px-4 py-3">
          <button
            type="button"
            aria-label={expanded ? 'Collapse recommendations' : 'Expand recommendations'}
            aria-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            className="text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={cn('size-4 transition-transform duration-200', expanded && 'rotate-180')}
              aria-hidden="true"
            />
          </button>
        </td>
      </tr>

      <tr className="border-b border-border/60">
        <td colSpan={7} className="p-0">
          {/* The grid-rows 0fr→1fr trick animates height without measuring it (§ smooth expand). */}
          <div
            className={cn(
              'grid transition-[grid-template-rows] duration-300 ease-out',
              expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
            )}
          >
            <div className="overflow-hidden">
              {/* The same lists the counselor's own `ClassRecommendationsPanel` renders — one
                  component, so the two staff views of a student cannot drift apart. */}
              <StudentRecommendationLists
                careers={student.top_careers}
                programs={student.top_programs}
                className="bg-muted/20 px-4 py-4"
              />
            </div>
          </div>
        </td>
      </tr>
    </>
  );
}

/** Sort by the chosen field, nulls last, case-insensitive, with a name tie-break. */
function compare(a: CounselorStudentRow, b: CounselorStudentRow, field: SortField): number {
  const av = (a[field] ?? '').toString().toLowerCase();
  const bv = (b[field] ?? '').toString().toLowerCase();

  if (av === bv) return a.name.localeCompare(b.name);
  if (av === '') return 1;
  if (bv === '') return -1;

  return av.localeCompare(bv);
}

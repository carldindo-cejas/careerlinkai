import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuditLogs } from '@/features/admin/hooks/usePlatformAdmin';
import type { AuditLogEntry } from '@/types/platform';

/**
 * The audit-log viewer (FULLPLAN §13.8, §20 — Phase 6, admin only).
 *
 * This screen is where two design decisions finally pay off:
 *   * §38 answers every failed student join with the same generic 401 and writes the real
 *     reason here — so this page is the *only* place an operator can see why.
 *   * D18's lesson: a listener that throws is swallowed by design; this trail is where a
 *     swallowed failure becomes visible.
 */
export function AuditLogPage() {
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState<{ action?: string }>({});
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, error, isFetching } = useAuditLogs({
    ...applied,
    page,
    per_page: 25,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Audit log</h1>
        <p className="text-sm text-slate-500">
          The append-only record of every critical action. Failed student sign-ins are answered
          generically on purpose — the real reason is only ever written here.
        </p>
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setApplied(action.trim() === '' ? {} : { action: action.trim().toUpperCase() });
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="audit-action" className="text-xs font-medium text-slate-600">
            Action (prefix match)
          </label>
          <Input
            id="audit-action"
            value={action}
            onChange={(event) => setAction(event.target.value)}
            placeholder="e.g. STUDENT_CLASS_ACCESS"
            className="w-72"
          />
        </div>
        <Button type="submit" variant="secondary" size="sm">
          Filter
        </Button>
        {applied.action ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setAction('');
              setApplied({});
              setPage(1);
            }}
          >
            Clear
          </Button>
        ) : null}
      </form>

      {isLoading ? <p className="text-sm text-slate-500">Loading the trail…</p> : null}

      {isError ? <Alert>We could not load the audit log. {error.message}</Alert> : null}

      {data && data.items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Nothing recorded{applied.action ? ' for this filter' : ' yet'}</CardTitle>
            <CardDescription>
              Every login, class change, publish and join attempt lands here as it happens.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {data && data.items.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-3 font-medium">When</th>
                    <th className="px-4 py-3 font-medium">Action</th>
                    <th className="px-4 py-3 font-medium">Actor</th>
                    <th className="px-4 py-3 font-medium">Module</th>
                    <th className="px-4 py-3 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((entry) => (
                    <AuditRow key={entry.id} entry={entry} />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {data && data.pagination.last_page > 1 ? (
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            Page {data.pagination.current_page} of {data.pagination.last_page} ·{' '}
            {data.pagination.total} entries
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1 || isFetching}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= data.pagination.last_page || isFetching}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AuditRow({ entry }: { entry: AuditLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = entry.old_values !== null || entry.new_values !== null;

  return (
    <>
      <tr className="border-b border-slate-50 align-top last:border-b-0">
        <td className="whitespace-nowrap px-4 py-3 text-slate-500">
          {entry.created_at ? new Date(entry.created_at).toLocaleString() : '—'}
        </td>
        <td className="px-4 py-3">
          <Badge tone={toneFor(entry.action)} className="normal-case">
            {entry.action}
          </Badge>
        </td>
        <td className="px-4 py-3 text-slate-700">
          {entry.user_name ?? <span className="italic text-slate-400">system / unresolved</span>}
        </td>
        <td className="px-4 py-3 text-slate-500">{entry.module}</td>
        <td className="px-4 py-3">
          {hasDetails ? (
            <button
              type="button"
              className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? 'Hide' : 'Show'}
            </button>
          ) : (
            <span className="text-xs text-slate-300">—</span>
          )}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-slate-50 bg-slate-50/60">
          <td colSpan={5} className="px-4 py-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {entry.old_values ? (
                <DetailBlock label="Before" values={entry.old_values} />
              ) : null}
              {entry.new_values ? <DetailBlock label="After" values={entry.new_values} /> : null}
            </div>
            {entry.ip_address ? (
              <p className="mt-2 text-xs text-slate-400">IP: {entry.ip_address}</p>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DetailBlock({ label, values }: { label: string; values: Record<string, unknown> }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <pre className="overflow-x-auto rounded-md bg-white p-3 text-xs text-slate-700 ring-1 ring-slate-100">
        {JSON.stringify(values, null, 2)}
      </pre>
    </div>
  );
}

/** Failures and deletions read as warnings; everything else stays neutral. */
function toneFor(action: string): 'neutral' | 'success' | 'warning' {
  if (action.endsWith('_FAILED') || action.endsWith('_THROTTLED') || action.endsWith('_DELETED')) {
    return 'warning';
  }

  if (action.endsWith('_SUCCESS') || action === 'ASSESSMENT_PUBLISHED') {
    return 'success';
  }

  return 'neutral';
}

import {
  Activity,
  BookOpen,
  Bot,
  Briefcase,
  GraduationCap,
  KeyRound,
  School,
  Users,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { StatCard } from '@/components/dashboard/StatCard';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminDashboard } from '@/features/admin/hooks/usePlatformAdmin';
import { paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';

/**
 * Admin dashboard (FULLPLAN §37, §54 — Phase 6).
 *
 * The §54 minimum metric set, pulled live on every visit: platform totals, assessment
 * completion, the student-access health signal (the passwordless model's primary monitor),
 * the AI window, and the newest audit entries.
 */
export function AdminDashboardPage() {
  const user = useAuthStore((state) => state.user);
  const { data, isLoading, isError, error } = useAdminDashboard();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">
          Welcome back, {user?.name ?? 'Administrator'}
        </h1>
        <p className="text-sm text-muted-foreground">Platform overview — live numbers, not caches.</p>
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Gathering the numbers…</p> : null}

      {isError ? <Alert>We could not load the dashboard. {error.message}</Alert> : null}

      {data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={<Users className="size-4" aria-hidden="true" />}
              label="Students"
              value={data.totals.students}
            />
            <StatCard
              icon={<School className="size-4" aria-hidden="true" />}
              label="Counselors"
              value={data.totals.counselors}
              to={paths.adminCounselors}
            />
            <StatCard
              icon={<GraduationCap className="size-4" aria-hidden="true" />}
              label="Colleges · Programs"
              value={`${data.totals.colleges} · ${data.totals.programs}`}
              to={paths.adminColleges}
            />
            <StatCard
              icon={<Briefcase className="size-4" aria-hidden="true" />}
              label="Careers"
              value={data.totals.careers}
              to={paths.adminCareers}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <BookOpen className="size-4 text-muted-foreground" aria-hidden="true" />
                  <CardTitle>Assessments</CardTitle>
                </div>
                <CardDescription>
                  {data.assessments.published_versions} published version
                  {data.assessments.published_versions === 1 ? '' : 's'}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                <MetricRow label="In progress" value={data.assessments.attempts_in_progress} />
                <MetricRow label="Scored" value={data.assessments.attempts_scored} />
                <MetricRow
                  label="Completion rate"
                  value={
                    data.assessments.completion_rate === null
                      ? '—'
                      : `${data.assessments.completion_rate}%`
                  }
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
                  <CardTitle>Student access · 7 days</CardTitle>
                </div>
                <CardDescription>
                  The passwordless model’s health signal (§54). Failures answer generically —
                  the reasons are in the audit log.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                <MetricRow label="Successful joins" value={data.student_access_7d.success} />
                <MetricRow label="Failed attempts" value={data.student_access_7d.failed} />
                <MetricRow label="Throttled" value={data.student_access_7d.throttled} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
                  <CardTitle>AI · 7 days</CardTitle>
                </div>
                <CardDescription>
                  Every gateway call is one row in ai_requests — success or failure (§29).
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                <MetricRow label="Requests" value={data.ai_7d.requests} />
                <MetricRow label="Failed" value={data.ai_7d.failed} />
                <MetricRow label="Tokens used" value={data.ai_7d.tokens_used.toLocaleString()} />
                <MetricRow
                  label="Avg latency"
                  value={data.ai_7d.avg_latency_ms === null ? '—' : `${data.ai_7d.avg_latency_ms} ms`}
                />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="size-4 text-muted-foreground" aria-hidden="true" />
                  <CardTitle>Recent activity</CardTitle>
                </div>
                <Link
                  to={paths.adminAuditLog}
                  className="text-sm font-medium text-muted-foreground hover:text-foreground hover:underline"
                >
                  Open the audit log
                </Link>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {data.recent_activity.length === 0 ? (
                <p className="px-6 pb-5 text-sm text-muted-foreground">Nothing recorded yet.</p>
              ) : (
                <ul>
                  {data.recent_activity.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-6 py-2.5 text-sm first:border-t-0"
                    >
                      <Badge className="normal-case">{entry.action}</Badge>
                      <span className="text-muted-foreground">
                        {entry.user_name ?? 'system / unresolved'}
                      </span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {entry.created_at ? new Date(entry.created_at).toLocaleString() : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

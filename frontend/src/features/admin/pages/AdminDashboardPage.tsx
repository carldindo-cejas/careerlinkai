import { Briefcase, GraduationCap } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';

/**
 * Admin dashboard (FULLPLAN §57).
 *
 * Still a shell where the numbers go — the live metrics defined in §54 arrive in Phase 6.
 * What it does have is a way into each section that exists, added by the phase that builds
 * it. Phase 2 brought the academic catalog.
 */
export function AdminDashboardPage() {
  const user = useAuthStore((state) => state.user);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">
          Welcome back, {user?.name ?? 'Administrator'}
        </h1>
        <p className="text-sm text-slate-500">Administrator dashboard</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <SectionCard
          to={paths.adminColleges}
          icon={<GraduationCap className="size-5 text-slate-400" aria-hidden="true" />}
          title="Colleges"
          description="Institutions and the programs each one offers. Programs are linked to the careers they lead to."
        />

        <SectionCard
          to={paths.adminCareers}
          icon={<Briefcase className="size-5 text-slate-400" aria-hidden="true" />}
          title="Careers"
          description="What programs lead to, each with the RIASEC code a student's assessment result is matched against."
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Coming with later phases</CardTitle>
          <CardDescription>
            Assessment templates, knowledge documents, AI policy and the audit log appear
            here as each phase is built.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600">
            Signed in as <span className="font-medium">{user?.email}</span>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function SectionCard({
  to,
  icon,
  title,
  description,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link to={to} className="focus-visible:outline-none">
      <Card className="h-full transition-colors hover:border-slate-300">
        <CardHeader>
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle>{title}</CardTitle>
          </div>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}

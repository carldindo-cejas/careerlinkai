import { NavLink } from 'react-router-dom';

import { cn } from '@/components/ui/cn';
import { StaffLayout } from '@/layouts/StaffLayout';
import { paths } from '@/routes/paths';

/**
 * Admin shell (FULLPLAN §35, §37).
 *
 * Colleges and Careers arrive with Phase 2. AI Policy, Assessment templates, Knowledge
 * documents and the Audit log are added by the phases that build them.
 */
export function AdminLayout() {
  return (
    <StaffLayout
      title="Administrator"
      nav={
        <div className="flex gap-1">
          <NavItem to={paths.adminDashboard} end>
            Dashboard
          </NavItem>
          <NavItem to={paths.adminColleges}>Colleges</NavItem>
          <NavItem to={paths.adminCareers}>Careers</NavItem>
          <NavItem to={paths.adminKnowledge}>Knowledge</NavItem>
          <NavItem to={paths.adminAiPolicy}>AI Policy</NavItem>
        </div>
      }
    />
  );
}

function NavItem({
  to,
  end = false,
  children,
}: {
  to: string;
  /** Exact-match only. "Dashboard" needs it, or /admin/colleges lights it up too. */
  end?: boolean | undefined;
  children: string;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
          isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-50',
        )
      }
    >
      {children}
    </NavLink>
  );
}

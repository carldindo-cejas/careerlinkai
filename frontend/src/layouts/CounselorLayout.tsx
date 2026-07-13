import { NavLink } from 'react-router-dom';

import { cn } from '@/components/ui/cn';
import { StaffLayout } from '@/layouts/StaffLayout';
import { paths } from '@/routes/paths';

/**
 * Counselor shell (FULLPLAN §35, §37).
 *
 * Assignments and Results are added by the phases that build those sections.
 */
export function CounselorLayout() {
  return (
    <StaffLayout
      title="Counselor"
      nav={
        <div className="flex gap-1">
          <NavItem to={paths.counselorDashboard} end>
            Dashboard
          </NavItem>
          <NavItem to={paths.counselorClasses}>Classes</NavItem>
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
  /** Exact-match only. "Dashboard" needs it, or /counselor/classes lights it up too. */
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

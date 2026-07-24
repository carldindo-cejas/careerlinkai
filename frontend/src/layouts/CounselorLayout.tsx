import { BookOpen, LayoutDashboard, Users } from 'lucide-react';

import { AppShell, type AppNavItem } from '@/layouts/AppShell';
import { paths } from '@/routes/paths';

/** Counselor shell (FULLPLAN §35, §37) — deliberately short: dashboard, classes, builder. */
const nav: AppNavItem[] = [
  { to: paths.counselorDashboard, label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: paths.counselorClasses, label: 'Classes', icon: Users },
  { to: paths.counselorAssessmentTemplates, label: 'Assessments', icon: BookOpen },
];

export function CounselorLayout() {
  return <AppShell title="Counselor" nav={nav} />;
}

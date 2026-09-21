import { BookOpen, FileText, HelpCircle, LayoutDashboard, Users } from 'lucide-react';

import { AppShell, type AppNavItem } from '@/layouts/AppShell';
import { paths } from '@/routes/paths';

/**
 * Counselor shell (FULLPLAN §35, §37) — dashboard, classes, builder, and since migration 0031
 * the two AI screens.
 *
 * "AI gaps" is placed directly above "Knowledge" rather than below it because that is the order
 * the work happens in: the report is where a counselor finds out what to write, and the knowledge
 * screen is where they write it. A nav that listed the library first would put the empty form
 * before the reason to fill it in.
 */
const nav: AppNavItem[] = [
  { to: paths.counselorDashboard, label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: paths.counselorClasses, label: 'Classes', icon: Users },
  { to: paths.counselorAssessmentTemplates, label: 'Assessments', icon: BookOpen },
  { to: paths.counselorAiInsights, label: 'AI gaps', icon: HelpCircle },
  { to: paths.counselorKnowledge, label: 'Knowledge', icon: FileText },
];

/**
 * Not a nav row (2026-09-20). `AppShell` renders it as the identity block above "Sign out" and as
 * the name in the top bar, which is where an account belongs — among the things that are true
 * about you, rather than among the five things you came here to do.
 */
const profile = { to: paths.counselorProfile, label: 'My account' };

export function CounselorLayout() {
  return <AppShell title="Counselor" nav={nav} profile={profile} />;
}

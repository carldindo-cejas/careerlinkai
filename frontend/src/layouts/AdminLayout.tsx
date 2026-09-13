import {
  Activity,
  Bot,
  BookOpen,
  Briefcase,
  FileText,
  GraduationCap,
  HelpCircle,
  LayoutDashboard,
  Library,
  Landmark,
  MapPin,
  ScrollText,
  Settings,
  Sparkles,
  Users,
} from 'lucide-react';

import { AppShell, type AppNavEntry } from '@/layouts/AppShell';
import { paths } from '@/routes/paths';

/**
 * Admin shell (FULLPLAN §35, §37) — every §37 admin destination, grouped.
 *
 * It was eleven flat links, which is a list you read top to bottom rather than a structure you
 * navigate. The grouping states relationships the routes already had and nothing else: the four
 * catalog screens are the things a student's recommendations are *drawn from*, and the three AI
 * screens are what the assistant may know, where it fell short, and what it may say. Those three
 * previously sat between the catalog and the audit log for no reason a person could infer.
 *
 * Dashboard stays outside any group. It is the shell's root, the breadcrumb links to it, and a
 * group of one would be a worse label than no group at all.
 *
 * Administration is everything an admin operates rather than authors: the assessment templates,
 * counselor accounts, platform health and the audit trail. Assessments sits here rather than at
 * the top level because it is a staff-management surface — the counselor shell serves the very
 * same two screens — and not one of the catalog tables a recommendation is computed from.
 */
const nav: AppNavEntry[] = [
  { to: paths.adminDashboard, label: 'Dashboard', icon: LayoutDashboard, end: true },
  {
    label: 'Catalog',
    icon: Landmark,
    items: [
      { to: paths.adminAddresses, label: 'Addresses', icon: MapPin },
      { to: paths.adminColleges, label: 'Colleges', icon: GraduationCap },
      { to: paths.adminCareers, label: 'Careers', icon: Briefcase },
      { to: paths.adminCanonicalPrograms, label: 'Canonical programs', icon: Library },
    ],
  },
  {
    label: 'AI integration',
    icon: Sparkles,
    items: [
      { to: paths.adminKnowledge, label: 'Knowledge', icon: FileText },
      { to: paths.adminAiInsights, label: 'AI gaps', icon: HelpCircle },
      { to: paths.adminAiPolicy, label: 'AI policy', icon: Bot },
    ],
  },
  {
    label: 'Administration',
    icon: Settings,
    items: [
      { to: paths.adminAssessmentTemplates, label: 'Assessments', icon: BookOpen },
      { to: paths.adminCounselors, label: 'Counselors', icon: Users },
      { to: paths.adminPlatformUsage, label: 'Platform health', icon: Activity },
      { to: paths.adminAuditLog, label: 'Audit log', icon: ScrollText },
    ],
  },
];

export function AdminLayout() {
  return <AppShell title="Administrator" nav={nav} />;
}

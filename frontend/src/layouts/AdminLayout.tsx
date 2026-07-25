import {
  BookOpen,
  Bot,
  Briefcase,
  FileText,
  GraduationCap,
  LayoutDashboard,
  MapPin,
  ScrollText,
  Users,
} from 'lucide-react';

import { AppShell, type AppNavItem } from '@/layouts/AppShell';
import { paths } from '@/routes/paths';

/**
 * Admin shell (FULLPLAN §35, §37) — every §37 admin destination, one nav item each,
 * in the order an admin's day actually runs: overview, then content, then governance.
 */
const nav: AppNavItem[] = [
  { to: paths.adminDashboard, label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: paths.adminAddresses, label: 'Addresses', icon: MapPin },
  { to: paths.adminColleges, label: 'Colleges', icon: GraduationCap },
  { to: paths.adminCareers, label: 'Careers', icon: Briefcase },
  { to: paths.adminAssessmentTemplates, label: 'Assessments', icon: BookOpen },
  { to: paths.adminKnowledge, label: 'Knowledge', icon: FileText },
  { to: paths.adminAiPolicy, label: 'AI Policy', icon: Bot },
  { to: paths.adminCounselors, label: 'Counselors', icon: Users },
  { to: paths.adminAuditLog, label: 'Audit log', icon: ScrollText },
];

export function AdminLayout() {
  return <AppShell title="Administrator" nav={nav} />;
}

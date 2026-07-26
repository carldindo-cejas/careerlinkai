import { Link } from 'react-router-dom';

import { Logo } from '@/components/brand/Logo';
import { paths } from '@/routes/paths';

/** The public site footer, shared across every unauthenticated page (prompt-driven, v1.5). */
export function PublicFooter() {
  return (
    <footer className="border-t border-sidebar-border">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-sidebar-muted sm:flex-row sm:px-6">
        <Logo wordmarkClassName="text-sidebar-active-foreground" />
        <p>Career &amp; college guidance for Senior High School.</p>
        <div className="flex gap-4">
          <Link to={paths.publicColleges} className="hover:text-sidebar-active-foreground">
            Colleges
          </Link>
          <Link to={paths.publicCareers} className="hover:text-sidebar-active-foreground">
            Careers
          </Link>
          <Link to={paths.studentAccess} className="hover:text-sidebar-active-foreground">
            Join a class
          </Link>
          <Link to={paths.login} className="hover:text-sidebar-active-foreground">
            Counselor Login
          </Link>
        </div>
      </div>
    </footer>
  );
}

import { Outlet } from 'react-router-dom';

/**
 * Shell for the student class-access screen (FULLPLAN §35, §38).
 *
 * Separate from StaffAuthLayout on purpose. The two sign-in flows never share a screen —
 * a student has no password, and a page that offers both a password field and a class-code
 * field invites exactly the confusion the split was made to avoid.
 */
export function StudentAccessLayout() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-50 p-4">
      <div className="flex flex-col items-center gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">CareerLinkAI</h1>
        <p className="text-sm text-slate-500">Career &amp; college guidance</p>
      </div>

      <Outlet />
    </div>
  );
}

import { Outlet } from 'react-router-dom';

/**
 * Shell for the staff authentication screens (FULLPLAN §35).
 *
 * Student access has its own layout (StudentAccessLayout), added in Phase 1 — the two
 * flows never share a screen.
 */
export function StaffAuthLayout() {
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

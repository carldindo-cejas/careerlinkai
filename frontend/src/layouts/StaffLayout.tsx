import { LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { useLogout } from '@/features/auth/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';

export interface StaffLayoutProps {
  title: string;
  /** Navigation for the role. Empty in Phase 0 — the sections arrive with their phases. */
  nav?: ReactNode;
}

/**
 * Shared chrome for the signed-in staff shells (FULLPLAN §35).
 *
 * AdminLayout and CounselorLayout compose this rather than duplicating it; they differ
 * only in title and navigation.
 */
export function StaffLayout({ title, nav }: StaffLayoutProps) {
  const user = useAuthStore((state) => state.user);
  const logout = useLogout();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-baseline gap-3">
            <span className="text-base font-semibold text-slate-900">CareerLinkAI</span>
            <span className="text-sm text-slate-500">{title}</span>
          </div>

          <div className="flex items-center gap-4">
            {user ? (
              <span className="text-sm text-slate-600">
                {user.name}
                <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs capitalize text-slate-600">
                  {user.role}
                </span>
              </span>
            ) : null}

            <Button
              variant="ghost"
              size="sm"
              onClick={() => logout.mutate()}
              loading={logout.isPending}
            >
              <LogOut className="size-4" aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </div>

        {nav ? <nav className="mx-auto max-w-6xl px-6 pb-3">{nav}</nav> : null}
      </header>

      <main className="mx-auto max-w-6xl p-6">
        <Outlet />
      </main>
    </div>
  );
}

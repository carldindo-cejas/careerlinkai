import { ArrowLeft } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

import { cn } from '@/components/ui/cn';
import { backTargetFor } from '@/routes/back';
import { useAuthStore } from '@/stores/authStore';

export interface BackButtonProps {
  /**
   * Classes for the *wrapper*, not the link — spacing and column width belong to the screen the
   * control sits on, while the link's own size stays the width of its text so the hit area never
   * stretches across an empty row.
   */
  className?: string;
  /**
   * `inverted` for the deep-navy panels (the staff sign-in card floats on one). The two tones are
   * separate class strings rather than one string plus an override because `text-*` overrides are
   * exactly the case tailwind-merge has to guess at, and a back button that silently loses its
   * colour against navy is invisible rather than merely wrong.
   */
  tone?: 'default' | 'inverted';
}

/**
 * One step back, above the page (prompt-driven).
 *
 * Rendered by the three signed-in shells and both sign-in layouts, so every screen in the product
 * carries the same control in the same place — rather than each page remembering its own. Where a
 * screen has no honest step back (the three dashboards, the forced password change) it renders
 * nothing at all, wrapper included, so no layout pays a stray gap for it.
 *
 * It is a `<Link>`, not a button: the destination is a real URL, which means middle-click, "open in
 * new tab" and the status bar all behave the way a reader expects them to.
 */
export function BackButton({ className, tone = 'default' }: BackButtonProps) {
  const location = useLocation();
  const user = useAuthStore((state) => state.user);

  const target = backTargetFor(location.pathname, {
    role: user?.role ?? null,
    mustChangePassword: user?.must_change_password ?? false,
    state: location.state,
  });

  if (!target) {
    return null;
  }

  return (
    <div className={className}>
      <Link
        to={target.to}
        className={cn(
          // `min-h-11` below `sm`: this is a 20px-tall text link, and it is the way back out of
          // every detail page in the product — the one control a phone user reaches for most and
          // the one hardest to hit. The negative margin keeps the extra height from pushing the
          // page down; the target grows, the layout does not move.
          'inline-flex min-h-11 w-fit items-center gap-1.5 rounded-none text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-0',
          tone === 'inverted'
            ? 'text-sidebar-muted hover:text-sidebar-active-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
        Back to {target.label}
      </Link>
    </div>
  );
}

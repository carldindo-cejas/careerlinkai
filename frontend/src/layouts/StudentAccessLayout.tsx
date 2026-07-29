import { Link, Outlet } from 'react-router-dom';

import { BrandArt } from '@/components/brand/BrandArt';
import { Logo } from '@/components/brand/Logo';
import { FadeIn } from '@/components/motion/FadeIn';
import { paths } from '@/routes/paths';

/**
 * Shell for the student class-access screen (FULLPLAN §35, §38) — post-Phase-6 design pass.
 *
 * Separate from StaffAuthLayout on purpose. The two sign-in flows never share a screen —
 * a student has no password, and a page that offers both a password field and a class-code
 * field invites exactly the confusion the split was made to avoid. The composition mirrors
 * the staff layout (a student should still feel they are in the same product) but the copy
 * speaks to the student, and the form sits on the light panel — friendlier at 7:30 AM in a
 * computer lab.
 */
export function StudentAccessLayout() {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.15fr]">
      <div className="relative flex flex-col items-center justify-center gap-6 overflow-hidden bg-background p-4 sm:p-8">
        <Link to={paths.landing} className="focus-visible:outline-none">
          <Logo />
        </Link>

        <FadeIn className="w-full max-w-md">
          <Outlet />
        </FadeIn>

        <p className="text-center text-xs text-muted-foreground">
          Counselor?{' '}
          <Link to={paths.login} className="font-medium text-primary hover:underline">
            Log in here
          </Link>
        </p>
      </div>

      {/* Artwork panel (desktop only) — navy, with the students illustration. */}
      <div className="relative hidden flex-col justify-center overflow-hidden bg-sidebar p-10 lg:flex">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-40 -right-40 size-112 rounded-full bg-[radial-gradient(circle,rgba(89,128,166,0.32),transparent_65%)]"
        />
        <FadeIn delay={0.05} className="mx-auto w-full max-w-xl">
          {/* Not an `h1` — see the matching note in StaffAuthLayout. The page's `h1` is the
              "Join your class" card, which is the only part of this screen a student can act on. */}
          <p className="text-3xl font-bold tracking-tight text-sidebar-active-foreground">
            Find where your strengths point.
          </p>
          <p className="mt-3 max-w-md text-sidebar-foreground">
            Answer two short assessments and get ranked careers, programs and colleges —
            matched to you, and explained.
          </p>
          <BrandArt
            alt="Senior high school students taking the RIASEC assessment on laptops and tablets"
            className="mt-8 w-full rounded-none border border-sidebar-border bg-background object-contain p-2"
          />
        </FadeIn>
      </div>
    </div>
  );
}

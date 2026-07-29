import { Link, Outlet } from 'react-router-dom';

import { BrandArt } from '@/components/brand/BrandArt';
import { Logo } from '@/components/brand/Logo';
import { FadeIn } from '@/components/motion/FadeIn';
import { paths } from '@/routes/paths';

/**
 * Shell for the staff authentication screens (FULLPLAN §35) — post-Phase-6 design pass.
 *
 * The reference composition: a light panel carrying the brand, a one-line promise and the
 * official artwork, beside a deep-navy panel holding the form. On mobile the art steps
 * aside and the form takes the screen.
 *
 * Student access has its own layout (StudentAccessLayout) — the two flows never share a
 * screen (§38).
 */
export function StaffAuthLayout() {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.15fr_1fr]">
      {/* Brand + artwork panel (desktop only). */}
      <div className="hidden flex-col justify-between bg-background p-10 lg:flex">
        <Link to={paths.landing} className="w-fit focus-visible:outline-none">
          <Logo />
        </Link>

        <FadeIn className="mx-auto w-full max-w-xl">
          {/*
            A `<p>` set at heading size, not an `h1`. This line is the panel's promise, not the
            page's subject — the page's subject is the sign-in card, which now carries the `h1`.
            As an `h1` it both outranked that card and disappeared entirely below `lg`, so the
            screen's heading outline changed with the viewport width.
          */}
          <p className="text-3xl font-bold tracking-tight text-foreground">
            Guidance that starts with evidence.
          </p>
          <p className="mt-3 max-w-md text-muted-foreground">
            RIASEC and SCCT assessments, deterministic career matching, and AI explanations
            grounded in your school&apos;s own guidance materials.
          </p>
          <BrandArt
            alt="Senior high school students exploring career recommendations together"
            className="mt-8 w-full rounded-none border border-border object-contain"
          />
        </FadeIn>

        <p className="text-xs text-muted-foreground">
          CareerLinkAI · Career &amp; college guidance for Senior High School
        </p>
      </div>

      {/* Form panel: deep navy, the card floats on it. */}
      <div className="relative flex flex-col items-center justify-center gap-6 overflow-hidden bg-sidebar p-4 sm:p-8">
        {/* A soft glow in the single steel accent — mono, so both blobs are the same hue at
            different depths rather than the old violet→teal pair. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-40 -top-40 size-112 rounded-full bg-[radial-gradient(circle,rgba(89,128,166,0.32),transparent_65%)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-44 -left-48 size-120 rounded-full bg-[radial-gradient(circle,rgba(65,97,128,0.26),transparent_65%)]"
        />

        <Link to={paths.landing} className="focus-visible:outline-none lg:hidden">
          <Logo wordmarkClassName="text-sidebar-active-foreground" />
        </Link>

        {/* The plate the card floats on. Cards are transparent line-drawings everywhere else,
            because everywhere else they sit on the light ground and their ink reads against it.
            This is the one panel where a card sits on the deep field, so the layout that put it
            there supplies the light surface — rather than every auth page remembering to. */}
        <FadeIn delay={0.05} className="relative w-full max-w-md bg-background">
          <Outlet />
        </FadeIn>
      </div>
    </div>
  );
}

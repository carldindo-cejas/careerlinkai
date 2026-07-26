import {
  ArrowRight,
  BookOpenCheck,
  Compass,
  KeyRound,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { FadeIn } from '@/components/motion/FadeIn';
import { Blueprint, Corners } from '@/components/ui/blueprint';
import { CollegeCard } from '@/features/public/components/CollegeCard';
import { usePublicColleges } from '@/features/public/hooks/usePublicCatalog';
import { paths } from '@/routes/paths';

/**
 * The public home page (prompt-driven, v1.5 — the post-Phase-6 landing, restructured).
 *
 * Two audiences, two doors, stated plainly: students join with a class code (no account, no
 * password — §38), staff sign in. The nav and footer now live in `PublicLayout`, shared with the
 * Colleges and Careers pages; this page owns only its content. The `careerlinkai_art` hero plate is
 * gone (per the prompt), and the old "Programs" browser is now a Colleges preview linking to the
 * dedicated Colleges page.
 */
export function HomePage() {
  const location = useLocation();

  // The nav's "How It Works" is a hash link (`/#how-it-works`). React Router doesn't scroll to a hash
  // on its own, so do it here — whether we arrived from another page or the hash changed in place.
  useEffect(() => {
    if (location.hash) {
      const target = document.getElementById(location.hash.slice(1));
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }, [location.hash]);

  return (
    <>
      {/* --- Hero ------------------------------------------------------------------ */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-56 left-1/2 size-[36rem] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(89,128,166,0.35),transparent_65%)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-40 -right-40 size-112 rounded-full bg-[radial-gradient(circle,rgba(65,97,128,0.3),transparent_65%)]"
        />

        <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pt-24">
          <FadeIn className="mx-auto max-w-3xl text-center">
            <p className="mx-auto mb-4 w-fit rounded-none border border-sidebar-border bg-sidebar-active/50 px-4 py-1 text-xs font-medium uppercase tracking-wide text-sidebar-foreground">
              For Senior High School students, counselors and administrators
            </p>
            <h1 className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
              Know where your strengths point{' '}
              <span className="text-primary">before you choose a college.</span>
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base text-sidebar-foreground sm:text-lg">
              CareerLinkAI matches your RIASEC interests and career confidence to real careers,
              programs and colleges — with every recommendation scored by a formula you can
              inspect, and explained by an AI grounded in your school&apos;s own guidance
              materials.
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link
                to={paths.studentAccess}
                className="relative inline-flex h-11 items-center gap-2 rounded-none bg-primary px-6 text-base font-medium text-primary-foreground transition-all hover:bg-[#4d7196] active:scale-[0.98]"
              >
                <Corners className="text-primary-foreground" />
                Join with a class code
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
              <Link
                to={paths.publicColleges}
                className="inline-flex h-11 items-center rounded-none border border-sidebar-border px-6 text-base font-medium text-sidebar-active-foreground transition-colors hover:bg-sidebar-active"
              >
                Explore colleges
              </Link>
            </div>
            <p className="mt-3 text-xs text-sidebar-muted">
              Students need no account and no password — just the code your counselor gave you.
            </p>
          </FadeIn>
        </div>
      </section>

      {/* --- How it works ------------------------------------------------------------ */}
      <section id="how-it-works" className="scroll-mt-20 bg-background text-foreground">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight">Three steps to a direction</h2>
            <p className="mt-3 text-muted-foreground">
              Built on two validated instruments — Holland&apos;s RIASEC and Social Cognitive
              Career Theory — scored deterministically, never by a model.
            </p>
          </div>

          <div className="mt-12 grid gap-6 md:grid-cols-3">
            <StepCard
              step="1"
              icon={<KeyRound className="size-5" aria-hidden="true" />}
              title="Join your class"
              body="Your counselor gives you a class code and a username. That's the whole sign-in — no email, no password to forget."
            />
            <StepCard
              step="2"
              icon={<BookOpenCheck className="size-5" aria-hidden="true" />}
              title="Take two assessments"
              body="RIASEC maps what holds your interest. SCCT measures how confident you are acting on it. Together they are your profile."
            />
            <StepCard
              step="3"
              icon={<Compass className="size-5" aria-hidden="true" />}
              title="Get matched — and told why"
              body="Ten careers and ten programs, ranked with a match score, each resolving to a real college. Ask the AI to explain any of them."
            />
          </div>

          {/* --- The claims that make it thesis-grade -------------------------------- */}
          <div className="mt-16 grid gap-6 md:grid-cols-3">
            <ValueCard
              icon={<Compass className="size-5 text-primary" aria-hidden="true" />}
              title="Deterministic by design"
              body="Match scores come from a published formula over your own answers — the same inputs always produce the same ranking. No model ever writes a number."
            />
            <ValueCard
              icon={<Sparkles className="size-5 text-primary" aria-hidden="true" />}
              title="AI that cites, or stays quiet"
              body="Explanations are generated only from documents your school uploaded. When the AI has no grounding, it says nothing invented — you still get the formula's reason."
            />
            <ValueCard
              icon={<ShieldCheck className="size-5 text-primary" aria-hidden="true" />}
              title="Humans keep the keys"
              body="Every AI-drafted question is confirmed by a counselor before it can ever be published — one mapping at a time, no approve-all button."
            />
          </div>
        </div>
      </section>

      {/* --- Colleges preview --------------------------------------------------------- */}
      <CollegesPreview />
    </>
  );
}

function StepCard({
  step,
  icon,
  title,
  body,
}: {
  step: string;
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <FadeIn className="relative rounded-none border border-border bg-transparent p-6">
      <Corners />
      <span className="absolute right-5 top-4 text-4xl font-bold tabular-nums text-secondary">
        {step}
      </span>
      <span className="flex size-10 items-center justify-center rounded-none border border-border bg-primary/10 text-primary">
        {icon}
      </span>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
    </FadeIn>
  );
}

function ValueCard({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <Blueprint className="p-6">
      <div className="flex items-center gap-2.5">
        {icon}
        <h3 className="font-semibold">{title}</h3>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
    </Blueprint>
  );
}

/**
 * A live preview of the college catalog (prompt-driven, v1.5) — the home page's replacement for the
 * old program browser, renamed to Colleges. Shows the first few institutions and links to the full
 * Colleges page. Collapses entirely when the catalog is empty rather than showing an empty promise.
 */
const HOME_COLLEGE_PREVIEW = 3;

function CollegesPreview() {
  const { data } = usePublicColleges(null);

  if (!data || data.length === 0) {
    return null;
  }

  const preview = data.slice(0, HOME_COLLEGE_PREVIEW);

  return (
    <section className="border-t border-border bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            {data.length} {data.length === 1 ? 'college' : 'colleges'} in the catalog
          </h2>
          <p className="mt-3 text-muted-foreground">
            The institutions your recommendations are drawn from — curated by your school&apos;s
            administrators, matched to you by the engine.
          </p>
        </div>

        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {preview.map((college) => (
            <CollegeCard key={college.id} college={college} />
          ))}
        </div>

        <div className="mt-10 flex justify-center">
          <Link
            to={paths.publicColleges}
            className="inline-flex h-11 items-center gap-2 rounded-none border border-border px-6 text-base font-medium text-foreground transition-colors hover:bg-secondary"
          >
            View all colleges
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}

import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  BookOpenCheck,
  Compass,
  GraduationCap,
  KeyRound,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import artUrl from '@/assets/careerlinkai_art.png';
import { Logo } from '@/components/brand/Logo';
import { FadeIn } from '@/components/motion/FadeIn';
import { Blueprint, Corners } from '@/components/ui/blueprint';
import { catalogApi } from '@/services/catalogApi';
import { homePathForRole, paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';

/**
 * The public landing page (post-Phase-6 design pass).
 *
 * Two audiences, two doors, stated plainly: students join with a class code (no account, no
 * password — §38), staff sign in. Everything on this page is either true of the running
 * system or rendered from it — the program browser is the live `GET /programs/public`
 * catalog, not marketing copy.
 */
export function LandingPage() {
  const user = useAuthStore((state) => state.user);

  return (
    <div className="min-h-screen bg-sidebar text-sidebar-active-foreground">
      {/* --- Nav ------------------------------------------------------------------- */}
      <header className="sticky top-0 z-40 border-b border-sidebar-border bg-sidebar/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Logo wordmarkClassName="text-sidebar-active-foreground" />

          <nav className="hidden items-center gap-6 text-sm text-sidebar-foreground md:flex">
            <a href="#how-it-works" className="transition-colors hover:text-sidebar-active-foreground">
              How it works
            </a>
            <a href="#programs" className="transition-colors hover:text-sidebar-active-foreground">
              Programs
            </a>
          </nav>

          <div className="flex items-center gap-2">
            {user ? (
              <Link
                to={homePathForRole(user.role)}
                className="inline-flex h-9 items-center gap-1.5 rounded-none bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-[#4d7196]"
              >
                Go to my dashboard
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            ) : (
              <>
                <Link
                  to={paths.login}
                  className="hidden h-9 items-center rounded-none px-4 text-sm font-medium text-sidebar-foreground transition-colors hover:text-sidebar-active-foreground sm:inline-flex"
                >
                  Counselor Login
                </Link>
                <Link
                  to={paths.studentAccess}
                  className="inline-flex h-9 items-center gap-1.5 rounded-none bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-[#4d7196]"
                >
                  Join your class
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

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
              {/* Mono scheme: the emphasis is the single steel accent, not a two-hue gradient. */}
              <span className="text-primary">
                before you choose a college.
              </span>
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
                to={paths.login}
                className="inline-flex h-11 items-center rounded-none border border-sidebar-border px-6 text-base font-medium text-sidebar-active-foreground transition-colors hover:bg-sidebar-active"
              >
                Counselor Login
              </Link>
            </div>
            <p className="mt-3 text-xs text-sidebar-muted">
              Students need no account and no password — just the code your counselor gave you.
            </p>
          </FadeIn>

          <FadeIn delay={0.15} className="mx-auto mt-12 max-w-4xl">
            {/* The hero figure is a framed plate: hairline border, registration marks, no shadow. */}
            <Blueprint className="border-sidebar-border bg-background p-3">
              <img
                src={artUrl}
                alt="Senior high school students reviewing their career recommendations on laptops and tablets"
                className="w-full rounded-none object-contain"
              />
            </Blueprint>
          </FadeIn>
        </div>
      </section>

      {/* --- How it works ------------------------------------------------------------ */}
      <section id="how-it-works" className="bg-background text-foreground">
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

      {/* --- Program browser ---------------------------------------------------------- */}
      <ProgramBrowser />

      {/* --- Footer -------------------------------------------------------------------- */}
      <footer className="border-t border-sidebar-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-sidebar-muted sm:flex-row sm:px-6">
          <Logo wordmarkClassName="text-sidebar-active-foreground" />
          <p>Career &amp; college guidance for Senior High School.</p>
          <div className="flex gap-4">
            <Link to={paths.studentAccess} className="hover:text-sidebar-active-foreground">
              Join a class
            </Link>
            <Link to={paths.login} className="hover:text-sidebar-active-foreground">
              Counselor Login
            </Link>
          </div>
        </div>
      </footer>
    </div>
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
 * The live catalog (GET /programs/public). Rendered only when it has content — an empty
 * or failed fetch collapses the section entirely rather than showing an empty promise.
 */
function ProgramBrowser() {
  const { data } = useQuery({
    queryKey: ['public', 'programs'],
    queryFn: () => catalogApi.publicPrograms(),
    staleTime: 5 * 60 * 1000,
  });

  if (!data || data.colleges.length === 0) {
    return null;
  }

  const programCount = data.colleges.reduce((sum, college) => sum + college.programs.length, 0);

  return (
    <section id="programs" className="border-t border-border bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            {programCount} programs across {data.colleges.length}{' '}
            {data.colleges.length === 1 ? 'institution' : 'institutions'}
          </h2>
          <p className="mt-3 text-muted-foreground">
            The catalog your recommendations are drawn from — curated by your school&apos;s
            administrators, matched to you by the engine.
          </p>
        </div>

        <div className="mt-10 grid gap-6 sm:grid-cols-2">
          {data.colleges.map((college) => (
            <Blueprint key={college.id} className="p-6">
              <div className="flex items-center gap-2.5">
                <GraduationCap className="size-5 text-primary" aria-hidden="true" />
                <h3 className="font-semibold">{college.name}</h3>
              </div>
              <ul className="mt-3 flex flex-wrap gap-2">
                {college.programs.map((program) => (
                  <li
                    key={program.id}
                    className="rounded-none bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground/80"
                    title={program.name}
                  >
                    {program.code}
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      {program.name}
                    </span>
                  </li>
                ))}
              </ul>
            </Blueprint>
          ))}
        </div>
      </div>
    </section>
  );
}

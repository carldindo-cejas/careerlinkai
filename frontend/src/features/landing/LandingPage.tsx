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
    <div className="min-h-screen bg-sidebar text-white">
      {/* --- Nav ------------------------------------------------------------------- */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-sidebar/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Logo wordmarkClassName="text-white" />

          <nav className="hidden items-center gap-6 text-sm text-sidebar-foreground md:flex">
            <a href="#how-it-works" className="transition-colors hover:text-white">
              How it works
            </a>
            <a href="#programs" className="transition-colors hover:text-white">
              Programs
            </a>
          </nav>

          <div className="flex items-center gap-2">
            {user ? (
              <Link
                to={homePathForRole(user.role)}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-white px-4 text-sm font-medium text-sidebar transition-colors hover:bg-white/90"
              >
                Go to my dashboard
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            ) : (
              <>
                <Link
                  to={paths.login}
                  className="hidden h-9 items-center rounded-md px-4 text-sm font-medium text-sidebar-foreground transition-colors hover:text-white sm:inline-flex"
                >
                  Staff sign in
                </Link>
                <Link
                  to={paths.studentAccess}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary/90"
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
          className="pointer-events-none absolute -top-56 left-1/2 size-[36rem] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(139,92,246,0.35),transparent_65%)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-40 -right-40 size-112 rounded-full bg-[radial-gradient(circle,rgba(20,184,166,0.25),transparent_65%)]"
        />

        <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pt-24">
          <FadeIn className="mx-auto max-w-3xl text-center">
            <p className="mx-auto mb-4 w-fit rounded-full border border-white/15 bg-white/5 px-4 py-1 text-xs font-medium tracking-wide text-sidebar-foreground">
              For Senior High School students, counselors and administrators
            </p>
            <h1 className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
              Know where your strengths point{' '}
              <span className="bg-gradient-to-r from-violet-400 to-teal-300 bg-clip-text text-transparent">
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
                className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-6 text-base font-medium text-white shadow-lg shadow-primary/25 transition-all hover:bg-primary/90 active:scale-[0.98]"
              >
                Join with a class code
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
              <Link
                to={paths.login}
                className="inline-flex h-11 items-center rounded-md border border-white/20 px-6 text-base font-medium text-white transition-colors hover:bg-white/10"
              >
                Staff sign in
              </Link>
            </div>
            <p className="mt-3 text-xs text-sidebar-muted">
              Students need no account and no password — just the code your counselor gave you.
            </p>
          </FadeIn>

          <FadeIn delay={0.15} className="mx-auto mt-12 max-w-4xl">
            <div className="rounded-2xl bg-white/95 p-3 shadow-2xl shadow-black/40 ring-1 ring-white/20">
              <img
                src={artUrl}
                alt="Senior high school students reviewing their career recommendations on laptops and tablets"
                className="w-full rounded-xl object-contain"
              />
            </div>
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
      <footer className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-sidebar-muted sm:flex-row sm:px-6">
          <Logo wordmarkClassName="text-white" />
          <p>Career &amp; college guidance for Senior High School.</p>
          <div className="flex gap-4">
            <Link to={paths.studentAccess} className="hover:text-white">
              Join a class
            </Link>
            <Link to={paths.login} className="hover:text-white">
              Staff sign in
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
    <FadeIn className="relative rounded-xl border border-border bg-card p-6 shadow-sm">
      <span className="absolute right-5 top-4 text-4xl font-bold text-secondary">{step}</span>
      <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </span>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
    </FadeIn>
  );
}

function ValueCard({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl bg-secondary/60 p-6">
      <div className="flex items-center gap-2.5">
        {icon}
        <h3 className="font-semibold">{title}</h3>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
    </div>
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
            <div key={college.id} className="rounded-xl border border-border bg-card p-6 shadow-sm">
              <div className="flex items-center gap-2.5">
                <GraduationCap className="size-5 text-primary" aria-hidden="true" />
                <h3 className="font-semibold">{college.name}</h3>
              </div>
              <ul className="mt-3 flex flex-wrap gap-2">
                {college.programs.map((program) => (
                  <li
                    key={program.id}
                    className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground/80"
                    title={program.name}
                  >
                    {program.code}
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      {program.name}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

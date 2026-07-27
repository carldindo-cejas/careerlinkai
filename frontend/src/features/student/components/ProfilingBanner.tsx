import { AlertTriangle, ArrowRight } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { useProfile } from '@/features/student/hooks/useAssessment';
import { paths } from '@/routes/paths';

/**
 * The persistent profiling warning (prompt-driven, v1.6).
 *
 * **It lives in the shell rather than on the dashboard**, above the content column and beside the
 * navigation, and that placement is the requirement rather than a layout preference: profiling
 * gates the recommendation features, and those are reachable from every screen. A banner that only
 * appeared on the dashboard would be invisible to the student who lands on Assessments, finishes
 * both instruments, and then finds an empty recommendations page with no explanation.
 *
 * Three properties it has to have, and each is one line below:
 *
 *   * **It states the consequence, not the chore.** "Complete your profile" is an instruction with
 *     no reason attached; a student who understands that recommendations depend on it is a student
 *     who fills it in accurately rather than quickly.
 *   * **It names what is missing.** The fields come from the server (`profiling.missing`, each with
 *     the label to print), so the banner cannot drift from the rule that decides completeness.
 *   * **It disappears on its own.** Nothing dismisses it and nothing remembers a dismissal: it is
 *     rendered from `profiling.is_complete`, so saving the last field removes it on the next fetch
 *     of a query the profile form already invalidates.
 *
 * It renders nothing while the profile is loading or failed to load. An empty banner slot is
 * better than a warning the student cannot act on — and `StudentProfilePage` already refuses to
 * show its form at all when the profile could not be read (D11), so a banner sending them there
 * would be sending them to an error.
 */
export function ProfilingBanner() {
  const { data: profile } = useProfile();
  const navigate = useNavigate();
  const location = useLocation();

  if (profile === undefined || profile.profiling.is_complete) {
    return null;
  }

  // Already on the profile page: the banner would be pointing at the screen it is sitting on.
  // Keeping the warning but dropping the button avoids a button that goes nowhere.
  const onProfilePage = location.pathname === paths.studentProfile;
  const missing = profile.profiling.missing;

  return (
    <div
      role="status"
      className="border-b border-accent/30 bg-accent/10"
      data-testid="profiling-banner"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <AlertTriangle className="size-4 shrink-0 text-accent" aria-hidden="true" />

        <p className="min-w-0 flex-1 text-sm text-foreground">
          <span className="font-medium">Complete your profile to get recommendations.</span>{' '}
          <span className="text-muted-foreground">
            We match programs and careers against{' '}
            {/* Named, in the student's words, from the server's own list. */}
            {missing.map((field) => field.label.toLowerCase()).join(', ')} — until{' '}
            {missing.length === 1 ? 'it is' : 'they are'} filled in we cannot recommend anything.
          </span>
        </p>

        {onProfilePage ? null : (
          <Button size="sm" onClick={() => navigate(paths.studentProfile)}>
            Complete profile
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}

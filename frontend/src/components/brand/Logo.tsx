import { cn } from '@/components/ui/cn';
import logoUrl from '@/assets/careerlinkai_logo-256.png';

/**
 * The official CareerLinkAI mark. One component so the logo can never drift between
 * screens — every shell, auth page and the landing page render this.
 *
 * **The 256px variant, not the master.** This renders at `size-9` (36 CSS px), so 256px covers
 * even a 3× device pixel ratio with room to spare. The master `careerlinkai_logo.png` is
 * 3.26 MB and was previously imported here — which, because every shell and auth page renders
 * this component, put 3.26 MB on the critical path of *every* screen in the application. The
 * 256px file is 14 kB: the same mark, 233× smaller, and indistinguishable at the size it is
 * actually drawn.
 *
 * The masters and the generated variants live in `frontend/assets/` and
 * `frontend/assets/optimized/`; `src/assets/` holds only what the app actually ships. If the
 * mark is ever redrawn, regenerate the variants there and copy the 256px one across — do not
 * point this import back at a master.
 */
export function Logo({
  className,
  wordmarkClassName,
  withWordmark = true,
}: {
  className?: string;
  wordmarkClassName?: string;
  withWordmark?: boolean;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <img src={logoUrl} alt="" aria-hidden="true" className="size-9 shrink-0 object-contain" />
      {withWordmark ? (
        <span
          className={cn('text-lg font-bold tracking-tight text-foreground', wordmarkClassName)}
        >
          CareerLink<span className="text-primary">AI</span>
        </span>
      ) : null}
    </span>
  );
}

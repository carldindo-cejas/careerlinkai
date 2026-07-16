import { cn } from '@/components/ui/cn';
import logoUrl from '@/assets/careerlinkai_logo.png';

/**
 * The official CareerLinkAI mark. One component so the logo can never drift between
 * screens — every shell, auth page and the landing page render this.
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

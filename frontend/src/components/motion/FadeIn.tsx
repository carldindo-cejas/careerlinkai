import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * The one entrance animation the app uses (design brief: subtle, never showy) — a short
 * fade-and-rise on mount. `delay` staggers siblings; `useReducedMotion` turns the whole
 * thing into a plain render for users who asked their OS for less movement.
 */
export function FadeIn({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind classes, with later classes winning conflicts.
 *
 * This is shadcn/ui's `cn` helper. It normally lives at `@/lib/utils`, but §35's
 * frontend tree has no `lib/` folder, so it sits alongside the primitives that use
 * it. If the shadcn CLI is introduced later, point its `aliases.utils` here.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

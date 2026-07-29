import { useEffect, useState } from 'react';

/**
 * Debounce a fast-changing value — the search box — so it drives one request rather than one per
 * keystroke.
 *
 * This was three identical private copies (`AddressPage`, `AuditLogPage`,
 * `AssessmentManagementPage`) before P3-2 needed a fourth, fifth and sixth. Six copies of a hook
 * whose whole contract is a timing constant is six places for that constant to disagree, and the
 * disagreement would show up as "search feels different on this page" rather than as a bug anyone
 * files. One copy, and the three originals now import it.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);

    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

/** The pause every search box in the app waits for. One number, so they cannot drift apart. */
export const SEARCH_DEBOUNCE_MS = 300;

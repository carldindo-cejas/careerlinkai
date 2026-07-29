import { cn } from '@/components/ui/cn';

/**
 * A validation message that is *attached* to its field rather than merely printed beside it.
 *
 * Every form in this app already set `aria-invalid` on the input and rendered the reason in a
 * neighbouring `<p>`. Visually that is the same thing; to a screen reader it is not. `aria-invalid`
 * announces "invalid" and nothing else — the sentence explaining *why* sits in a paragraph the
 * input has no relationship to, and is reached only by leaving the field and reading forward. A
 * student who mistypes their class code hears "Class code, edit, invalid entry" and is given no way
 * to find out what was wrong with it.
 *
 * Two things fix that, and both need the `id` this component insists on:
 *
 *   - `aria-describedby` on the input, pointing here, so the message is read *as part of* the
 *     field — on focus, and again on every return to it.
 *   - `role="alert"` here, so a message that appears in response to a submit is announced at the
 *     moment it appears, without the student having to go looking for it.
 *
 * Callers pass the same `id` to both sides; `describedBy` below builds the attribute value for the
 * common case of a field with more than one possible message.
 */
export function FieldError({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p id={id} role="alert" className={cn('text-sm text-destructive', className)}>
      {children}
    </p>
  );
}

/**
 * Join the ids of the messages a field currently has, or `undefined` when it has none.
 *
 * `aria-describedby=""` is not the same as an absent attribute — an empty token list is legal and
 * some screen readers announce it as a described-by with no target — so the empty case must return
 * `undefined` and drop the attribute entirely.
 */
export function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => Boolean(id));

  return present.length > 0 ? present.join(' ') : undefined;
}

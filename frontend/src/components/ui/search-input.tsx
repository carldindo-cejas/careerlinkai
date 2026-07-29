import { Search, X } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { cn } from '@/components/ui/cn';

/**
 * The search box every list surface uses (§20's catalog, knowledge and address lists).
 *
 * Extracted from `AddressTable`, which had the only one, at the point where P3-2 needed four more.
 * The `aria-label` is required rather than optional: this control has no visible `<label>` — the
 * magnifier is decorative and the placeholder disappears the moment anything is typed — so a
 * screen-reader user meets an unnamed text box unless the caller names it.
 */
export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Names the control for assistive technology, e.g. "Search careers". */
  label: string;
  placeholder?: string;
  className?: string;
  id?: string;
}

export function SearchInput({
  value,
  onChange,
  label,
  placeholder,
  className,
  id,
}: SearchInputProps) {
  return (
    <div className={cn('relative max-w-xs', className)}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        id={id}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? label}
        className={cn('pl-9', value && 'pr-9')}
        aria-label={label}
      />

      {/*
        A clear button, because `type="search"` renders a native one in Chrome and Safari and
        nothing at all in Firefox — and a filter the user cannot see how to remove is a list that
        looks broken. Hidden from the accessibility tree only when there is nothing to clear.
      */}
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={`Clear ${label.toLowerCase()}`}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

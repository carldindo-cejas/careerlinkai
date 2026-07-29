import { Check, ChevronsUpDown, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { cn } from '@/components/ui/cn';

/**
 * A searchable single-select — the one control the native `<Select>` cannot be: a long list (every
 * barangay in a town, every region) that a user filters by typing. Native `<Select>` stays the
 * default for short closed enums (status, strand); this exists for the cascading address dropdowns
 * and anywhere else a picker has more options than an eye can scan.
 *
 * Controlled and uncomplicated: it owns only its open/query UI state, never the value. Closes on an
 * outside click or Escape, filters case-insensitively on the option label, and (when `clearable`)
 * offers a way back to "nothing selected".
 *
 * ## Two filtering modes, one component
 *
 * By default it filters `options` **itself**, which is right when the caller already holds the whole
 * list (the address levels, the canonical-programme picker).
 *
 * Pass `onQueryChange` and it filters **nothing**: the caller owns the query, sends it to the
 * server, and hands back whatever came home. That is the mode audit F3 needs — the career picker
 * used to load "the whole catalog" and filter it here, which was true at 16 careers, false at 101,
 * and gave no sign of the difference. Client-side filtering cannot be made correct over a list the
 * client does not have, so at that point the query has to move rather than the filter get cleverer.
 */

export interface ComboboxOption {
  id: string;
  name: string;
}

export interface ComboboxProps {
  value: string | null;
  onChange: (id: string | null) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Shown in place of the placeholder, and disables the control — e.g. "Choose a region first". */
  disabledHint?: string | undefined;
  disabled?: boolean;
  loading?: boolean;
  clearable?: boolean;
  id?: string;
  invalid?: boolean;
  /**
   * Present ⇒ **server-filtered**. The caller owns the search term and `options` is taken as the
   * answer for it, unfiltered. Absent ⇒ the component filters `options` on the label, as before.
   */
  onQueryChange?: (query: string) => void;
  /** The current term, when the caller owns it. Ignored unless `onQueryChange` is given. */
  query?: string;
  /**
   * The label for `value` when the selected option is **not** in `options` — which is normal in
   * server mode, where a later search replaces the result set the choice was made from. Without it
   * the button would fall back to the placeholder and read as "nothing selected".
   */
  selectedLabel?: string | null;
  /** A note under the list, e.g. "42 matches — refine your search to narrow this down." */
  footer?: string | null;
  /**
   * Fired when the panel opens or closes. A server-filtered caller uses it to key its query's
   * `enabled` off, so a screen rendering many of these fetches once per picker *opened* rather than
   * once per picker *rendered*.
   */
  onOpenChange?: (open: boolean) => void;
}

export function Combobox({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No matches.',
  disabledHint,
  disabled = false,
  loading = false,
  clearable = false,
  id,
  invalid = false,
  onQueryChange,
  query: controlledQuery,
  selectedLabel = null,
  footer = null,
  onOpenChange,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [ownQuery, setOwnQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const isServerFiltered = onQueryChange !== undefined;
  const query = isServerFiltered ? (controlledQuery ?? '') : ownQuery;

  function setQuery(next: string) {
    if (onQueryChange) {
      onQueryChange(next);
    } else {
      setOwnQuery(next);
    }
  }

  const selectedOption = options.find((option) => option.id === value) ?? null;
  const selected =
    selectedOption ?? (value !== null && selectedLabel ? { id: value, name: selectedLabel } : null);
  const isDisabled = disabled || Boolean(disabledHint);

  const filtered = useMemo(() => {
    if (isServerFiltered) return options;

    const term = query.trim().toLowerCase();

    return term.length === 0
      ? options
      : options.filter((option) => option.name.toLowerCase().includes(term));
  }, [isServerFiltered, options, query]);

  // Close on an outside click.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        close();
      }
    }

    document.addEventListener('mousedown', onPointerDown);

    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Focus the search box the moment the panel opens — the whole point is to start typing.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /** The one place `open` changes, so `onOpenChange` cannot be missed on a path that closes it. */
  function setPanelOpen(next: boolean) {
    setOpen(next);
    onOpenChange?.(next);
  }

  function close() {
    setPanelOpen(false);
    setQuery('');
  }

  function choose(optionId: string | null) {
    onChange(optionId);
    close();
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        id={id}
        disabled={isDisabled}
        aria-invalid={invalid}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : setPanelOpen(true))}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-none border border-input bg-transparent px-3 py-2 text-left text-sm transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          'disabled:cursor-not-allowed disabled:opacity-50',
          invalid && 'border-destructive focus-visible:ring-destructive/60',
        )}
      >
        <span className={cn('truncate', !selected && 'text-muted-foreground')}>
          {disabledHint ?? (selected ? selected.name : loading ? 'Loading…' : placeholder)}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>

      {open ? (
        <div className="absolute z-50 mt-1 w-full border border-input bg-popover text-popover-foreground shadow-md">
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') close();
                if (event.key === 'Enter' && filtered.length > 0) {
                  event.preventDefault();
                  choose(filtered[0]!.id);
                }
              }}
              placeholder={searchPlaceholder}
              // The placeholder is the only visible name this box has, and a placeholder is not an
              // accessible name — it disappears the moment anything is typed (P2-3's rule).
              aria-label={searchPlaceholder}
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <ul id={listId} role="listbox" className="max-h-56 overflow-auto py-1">
            {/*
              In server mode the list is a request in flight, not a filter over data already here,
              so "no matches" and "not back yet" are genuinely different states and must not look
              alike — otherwise every pause reads as "there is no such career".
            */}
            {isServerFiltered && loading ? (
              <li className="px-3 py-2 text-sm text-muted-foreground" role="status">
                Searching…
              </li>
            ) : null}

            {clearable && selected ? (
              <li>
                <button
                  type="button"
                  onClick={() => choose(null)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
                >
                  <X className="size-3.5" aria-hidden="true" />
                  Clear selection
                </button>
              </li>
            ) : null}

            {filtered.length === 0 && !(isServerFiltered && loading) ? (
              <li className="px-3 py-2 text-sm text-muted-foreground">{emptyText}</li>
            ) : (
              filtered.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.id === value}
                    onClick={() => choose(option.id)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted',
                      option.id === value && 'bg-muted/60',
                    )}
                  >
                    <span className="truncate">{option.name}</span>
                    {option.id === value ? (
                      <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
                    ) : null}
                  </button>
                </li>
              ))
            )}
          </ul>

          {footer ? (
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              {footer}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

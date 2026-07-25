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
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = options.find((option) => option.id === value) ?? null;
  const isDisabled = disabled || Boolean(disabledHint);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();

    return term.length === 0
      ? options
      : options.filter((option) => option.name.toLowerCase().includes(term));
  }, [options, query]);

  // Close on an outside click.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }

    document.addEventListener('mousedown', onPointerDown);

    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Focus the search box the moment the panel opens — the whole point is to start typing.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
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
        onClick={() => setOpen((value) => !value)}
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
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <ul id={listId} role="listbox" className="max-h-56 overflow-auto py-1">
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

            {filtered.length === 0 ? (
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
        </div>
      ) : null}
    </div>
  );
}

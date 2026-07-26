import { Check, ChevronsUpDown, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { cn } from '@/components/ui/cn';
import type { ComboboxOption } from '@/components/ui/combobox';

/**
 * A searchable **multi**-select — `Combobox`'s sibling, for the one case a single choice cannot
 * express: an assessment reports several scoring methods at once, and the compatibility matrix lists
 * up to nine of them for a single type.
 *
 * It follows `Combobox` in every respect that matters (controlled, owns only its open/query state,
 * closes on outside click or Escape, filters case-insensitively) and differs in exactly two:
 *
 *   * **The panel stays open after a choice.** Picking three methods in a row should be three
 *     clicks, not three open-pick-reopen cycles.
 *   * **Selections are shown as removable chips** rather than as text in the trigger. A trigger
 *     reading "Likert Scales, Raw Scores, T-Scores, +2" truncates to uselessness at the width this
 *     sits in, and gives no way to remove one without reopening the list.
 *
 * `options` is the **already-filtered** set — the caller narrows it by the selected assessment type,
 * because the rule about which methods are legal belongs with the data, not in this control.
 */

export interface MultiComboboxProps {
  value: string[];
  onChange: (ids: string[]) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Shown in place of the placeholder, and disables the control — e.g. "Choose a type first". */
  disabledHint?: string | undefined;
  disabled?: boolean;
  loading?: boolean;
  id?: string;
  invalid?: boolean;
}

export function MultiCombobox({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No matches.',
  disabledHint,
  disabled = false,
  loading = false,
  id,
  invalid = false,
}: MultiComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const isDisabled = disabled || Boolean(disabledHint);
  const selectedIds = useMemo(() => new Set(value), [value]);

  /**
   * Chips render in the *options'* order, not the click order. The options arrive in the scoring
   * lookup's curated sequence, so the same three methods always read the same way — a set that
   * reshuffled itself by the order somebody happened to click would look like different data.
   */
  const selected = useMemo(
    () => options.filter((option) => selectedIds.has(option.id)),
    [options, selectedIds],
  );

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();

    return term.length === 0
      ? options
      : options.filter((option) => option.name.toLowerCase().includes(term));
  }, [options, query]);

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

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    setQuery('');
  }

  function toggle(optionId: string) {
    onChange(
      selectedIds.has(optionId)
        ? value.filter((id) => id !== optionId)
        : [...value, optionId],
    );
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
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
        className={cn(
          'flex min-h-10 w-full items-center justify-between gap-2 rounded-none border border-input bg-transparent px-3 py-2 text-left text-sm transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          'disabled:cursor-not-allowed disabled:opacity-50',
          invalid && 'border-destructive focus-visible:ring-destructive/60',
        )}
      >
        <span className={cn('truncate', selected.length === 0 && 'text-muted-foreground')}>
          {disabledHint ??
            (selected.length > 0
              ? `${selected.length} selected`
              : loading
                ? 'Loading…'
                : placeholder)}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>

      {selected.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {selected.map((option) => (
            <li key={option.id}>
              <span className="inline-flex items-center gap-1 bg-secondary px-2 py-0.5 text-xs font-medium text-foreground/80">
                {option.name}
                {isDisabled ? null : (
                  <button
                    type="button"
                    onClick={() => toggle(option.id)}
                    aria-label={`Remove ${option.name}`}
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

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
                  toggle(filtered[0]!.id);
                }
              }}
              placeholder={searchPlaceholder}
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <ul id={listId} role="listbox" aria-multiselectable className="max-h-56 overflow-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted-foreground">{emptyText}</li>
            ) : (
              filtered.map((option) => {
                const isSelected = selectedIds.has(option.id);

                return (
                  <li key={option.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => toggle(option.id)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted',
                        isSelected && 'bg-muted/60',
                      )}
                    >
                      <span className="truncate">{option.name}</span>
                      {isSelected ? (
                        <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
                      ) : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

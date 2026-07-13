import type { InputHTMLAttributes } from 'react';

import { cn } from '@/components/ui/cn';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={cn(
        'flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-red-500 aria-invalid:focus-visible:ring-red-400',
        className,
      )}
      {...props}
    />
  );
}

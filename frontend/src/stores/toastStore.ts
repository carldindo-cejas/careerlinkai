import { create } from 'zustand';

/**
 * Transient toast notifications (FULLPLAN §36 keeps ephemeral UI state in Zustand).
 *
 * Deliberately tiny: a queue of messages, a `push`, and a `dismiss`. Auto-expiry is driven by the
 * `<Toaster>` component rather than a timer inside the store, so the store stays a pure state
 * container and nothing schedules work that a test would have to tear down.
 *
 * Callers use the `toast` helper (`toast.success('Saved.')`) rather than the hook, so a mutation's
 * `onSuccess` need not be a component to raise one.
 */

export type ToastTone = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  tone: ToastTone;
  message: string;
}

interface ToastState {
  toasts: Toast[];
  push: (tone: ToastTone, message: string) => void;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (tone, message) =>
    set((state) => ({
      toasts: [...state.toasts, { id: crypto.randomUUID(), tone, message }],
    })),
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

export const toast = {
  success: (message: string) => useToastStore.getState().push('success', message),
  error: (message: string) => useToastStore.getState().push('error', message),
  info: (message: string) => useToastStore.getState().push('info', message),
};

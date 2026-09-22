import { create } from 'zustand';

/**
 * Whether the recommendations page's assistant drawer is open (2026-09-22).
 *
 * It lived in `RecommendationChatPanel`'s own state until "Explain more" moved into the chat: a
 * card now has to open the drawer on a phone, and the card is not the panel's child. On `xl` and
 * up the assistant is a column that is always showing, so this flag simply goes unread there.
 */
interface ChatPanelState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useChatPanelStore = create<ChatPanelState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

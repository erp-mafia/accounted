import { redirect } from 'next/navigation'
import { assistantChatEnabled } from '@/lib/env/assistant-chat-switch'

/**
 * What the built-in assistant's pages do about the installation's switch
 * (ASSISTANT_CHAT_ENABLED, lib/env/assistant-chat-switch.ts), in one place.
 *
 * Switched off, every one of them sends its visitor to where a person's own
 * assistant connects: the chat's start page, a new conversation, a stored
 * conversation, the interview on /chat/intake and the build before it on
 * /onboarding/agent. The chat layout asks, and each chat page asks again: a
 * layout is not rendered again when the visitor moves between its pages.
 */

/** Agenter > Koppla en agent: where the assistant's pages lead while it is switched off. */
export const CHAT_SWITCHED_OFF_HREF = '/settings/api'

/** Leaves for Koppla en agent when the built-in assistant is switched off. */
export function leaveWhenChatSwitchedOff(): void {
  if (!assistantChatEnabled()) redirect(CHAT_SWITCHED_OFF_HREF)
}

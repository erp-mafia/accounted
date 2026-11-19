import { redirect } from 'next/navigation'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { assistantChatEnabledFor } from '@/lib/env/assistant-chat-switch'

/**
 * What the built-in assistant's pages do about its switch
 * (ASSISTANT_CHAT_ENABLED and the companies that keep the chat,
 * lib/env/assistant-chat-switch.ts), in one place.
 *
 * For a company without the chat, /chat shows what took its place
 * (components/agent/ChatReplaced.tsx) and every other page of the assistant
 * leads there: a new conversation, a stored conversation, the interview on
 * /chat/intake and the build before it on /onboarding/agent. The chat layout
 * asks, and each chat page asks again: a layout is not rendered again when
 * the visitor moves between its pages.
 */

/** Where a company without the chat is shown what took its place. */
export const CHAT_REPLACED_HREF = '/chat'

/** Whether this company has the built-in assistant today. */
export function chatSwitchedOnFor(companyId: string | null | undefined): boolean {
  return assistantChatEnabledFor(companyId, todayIsoStockholm())
}

/** Leaves for /chat when the company has no chat: every page of the assistant but /chat itself. */
export function leaveWhenChatSwitchedOff(companyId: string | null | undefined): void {
  if (!chatSwitchedOnFor(companyId)) redirect(CHAT_REPLACED_HREF)
}

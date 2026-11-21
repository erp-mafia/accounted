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
 * leads there: a new conversation and a stored conversation. The addresses
 * of the removed interview (/chat/intake) and of the removed build
 * (/onboarding/agent) lead to /chat for every company. The chat layout asks,
 * and each chat page asks again: a layout is not rendered again when the
 * visitor moves between its pages.
 */

/** Where a company without the chat is shown what took its place. */
export const CHAT_REPLACED_HREF = '/chat'

/**
 * Agenter > Koppla en agent: where the chat layout leads a company that has
 * the chat switched on but no built assistant (agent_profiles.verified_at).
 * The build is removed, so there is no chat for it to open; this is where its
 * own assistant connects.
 */
export const CONNECT_AGENT_HREF = '/settings/api'

/** Whether this company has the built-in assistant today. */
export function chatSwitchedOnFor(companyId: string | null | undefined): boolean {
  return assistantChatEnabledFor(companyId, todayIsoStockholm())
}

/** Leaves for /chat when the company has no chat: every page of the assistant but /chat itself. */
export function leaveWhenChatSwitchedOff(companyId: string | null | undefined): void {
  if (!chatSwitchedOnFor(companyId)) redirect(CHAT_REPLACED_HREF)
}

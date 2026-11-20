import type { SupportHandoff } from './assistant-stream'

/**
 * The conversation with the AI assistant, kept while the page is loaded.
 *
 * The support dialog unmounts when it closes, and an answer often ends in a
 * link to the page where the thing is done: following it closes the dialog.
 * Held here, the conversation is still there when the dialog opens again, in
 * this tab, until the page is reloaded or the user starts over. One company
 * at a time: a conversation never follows the user into another company.
 *
 * In memory only. The turns are stored on the server as they are asked and
 * answered (agent_conversations); this is what the dialog shows, not a record.
 */
export interface SupportAskTurn {
  role: 'user' | 'assistant'
  text: string
  /** Set on an answer where the assistant itself offered a person. */
  handoff?: SupportHandoff | null
  /** The user's rating of an answer, once given. */
  vote?: 'positive' | 'negative'
}

export interface SupportAskSession {
  companyId: string
  conversationId: string | null
  turns: SupportAskTurn[]
}

let session: SupportAskSession | null = null

export function readSupportAskSession(companyId: string): SupportAskSession {
  if (session && session.companyId === companyId) return session
  return { companyId, conversationId: null, turns: [] }
}

export function writeSupportAskSession(next: SupportAskSession): void {
  session = next
}

export function clearSupportAskSession(): void {
  session = null
}

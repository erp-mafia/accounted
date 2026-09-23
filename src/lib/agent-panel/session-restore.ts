/**
 * Per-tab memory of which thread the docked assistant panel had open.
 *
 * The panel's state lives in React only, so a full page reload (the "Ladda om"
 * deploy prompt, a browser refresh, a crash recovery) closed it and dropped the
 * thread from view; the user had to dig it out of "Tidigare konversationer" by
 * hand. This remembers just enough to reopen the same thread after a reload:
 * the conversation id (the thread itself is already persisted server-side),
 * the intent that shaped it, and whether the panel was collapsed.
 *
 * sessionStorage on purpose, not user_preferences: this is "this tab, this
 * session" state. It survives a reload of the tab and nothing else, so a
 * thread never follows the user to another device or another tab, and a closed
 * tab forgets it. Nothing here is authoritative: the id is re-validated by the
 * conversations API on restore, and a thread that no longer opens is dropped.
 */

export const AGENT_SHEET_SESSION_KEY = 'accounted-agent-sheet'

export interface AgentSheetSession {
  conversationId: string
  intentId: string
  contextRef: string | null
  collapsed: boolean
}

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.sessionStorage
  } catch {
    // Storage access can throw (privacy modes, sandboxed frames): then there
    // is simply nothing to remember.
    return null
  }
}

export function readAgentSheetSession(): AgentSheetSession | null {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(AGENT_SHEET_SESSION_KEY)
    if (!raw) return null
    return parseAgentSheetSession(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Validate an untrusted parsed value; anything malformed reads as "nothing stored". */
export function parseAgentSheetSession(value: unknown): AgentSheetSession | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.conversationId !== 'string' || v.conversationId.length === 0) return null
  if (typeof v.intentId !== 'string' || v.intentId.length === 0) return null
  return {
    conversationId: v.conversationId,
    intentId: v.intentId,
    contextRef: typeof v.contextRef === 'string' ? v.contextRef : null,
    collapsed: v.collapsed === true,
  }
}

export function writeAgentSheetSession(session: AgentSheetSession): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(AGENT_SHEET_SESSION_KEY, JSON.stringify(session))
  } catch {
    // Quota or privacy mode: a lost write only costs the reload convenience.
  }
}

export function clearAgentSheetSession(): void {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(AGENT_SHEET_SESSION_KEY)
  } catch {
    // ignored: see writeAgentSheetSession
  }
}

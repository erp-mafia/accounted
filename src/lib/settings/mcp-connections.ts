// Browser-safe on purpose: Settings → API & MCP renders from this in a
// client component. Pure so the readout can be pinned in tests.

/**
 * Who is behind a connection row, as the Settings list labels it. The
 * built-in OAuth clients come from api_keys.client (migration
 * 20260913120000): claude, chatgpt, grok, cursor, cursor_deeplink and local.
 * `local` is any loopback sign-in (Claude Code, Codex, ...), so it is named
 * as a local client, never guessed as Claude Code.
 */
export type ConnectionKind = 'claude' | 'chatgpt' | 'grok' | 'cursor' | 'local' | 'mcp' | 'key'

export interface ConnectionRow {
  source?: 'signin' | 'manual'
  client?: string | null
  last_used_at: string | null
  created_at: string
}

/** Map a key row to the label/logo family it is shown with. */
export function connectionKind(row: Pick<ConnectionRow, 'source' | 'client'>): ConnectionKind {
  if (row.source !== 'signin') return 'key'
  switch (row.client) {
    case 'claude':
    case 'chatgpt':
    case 'grok':
    case 'local':
      return row.client
    case 'cursor':
    case 'cursor_deeplink':
      return 'cursor'
    default:
      // Rows minted before the client column, and registered clients.
      return 'mcp'
  }
}

/** A connection unused this long is worth one quiet question: still needed? */
export const STALE_AFTER_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * True when the row has not been used for STALE_AFTER_DAYS. A row that was
 * never used counts from its creation date, so a fresh key is not stale.
 */
export function isStaleConnection(row: Pick<ConnectionRow, 'last_used_at' | 'created_at'>, now: Date): boolean {
  const since = Date.parse(row.last_used_at ?? row.created_at)
  if (Number.isNaN(since)) return false
  return now.getTime() - since >= STALE_AFTER_DAYS * DAY_MS
}

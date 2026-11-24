// Browser-safe on purpose: Settings → API & MCP renders from this in a
// client component. Pure so the readout can be pinned in tests.

import { partnerSlugOf } from '@/lib/auth/oauth-partner-clients'

/**
 * Who is behind a connection row, as the Settings list labels it. The
 * built-in OAuth clients come from api_keys.client (migration
 * 20260913120000): claude, chatgpt, grok, gemini, copilot, cursor, cursor_deeplink,
 * squidler, celemine and local. `local` is any loopback sign-in (Claude Code,
 * Codex, ...), so it is named as a local client, never guessed as Claude Code.
 * `partner` is a key minted through a partner row (client 'partner:<slug>',
 * migration 20261122153300); the list names it by the partner's name.
 */
export type ConnectionKind = 'claude' | 'chatgpt' | 'grok' | 'gemini' | 'copilot' | 'cursor' | 'squidler' | 'celemine' | 'partner' | 'local' | 'mcp' | 'key'

export interface ConnectionRow {
  source?: 'signin' | 'manual'
  client?: string | null
  last_used_at: string | null
  created_at: string
}

/** Map a key row to the label/logo family it is shown with. */
export function connectionKind(row: Pick<ConnectionRow, 'source' | 'client'>): ConnectionKind {
  if (row.source !== 'signin') return 'key'
  if (partnerSlugOf(row.client)) return 'partner'
  switch (row.client) {
    case 'claude':
    case 'chatgpt':
    case 'grok':
    case 'gemini':
    case 'copilot':
    case 'squidler':
    case 'celemine':
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

/**
 * The shown names that more than one row of the list carries. Rows under
 * such a name cannot be told apart by it, so each of them also says since
 * when it has been connected; a row whose name is its own says nothing more.
 */
export function sharedNames(names: readonly string[]): Set<string> {
  const seen = new Set<string>()
  const shared = new Set<string>()
  for (const name of names) (seen.has(name) ? shared : seen).add(name)
  return shared
}

/**
 * The most characters the quiet text after a shared name may hold
 * ("sedan 28 mars 2026", "since Sep 30, 2026"), so that it is shown whole
 * with its date, the part that tells two such rows apart.
 *
 * A row of the connection list is one line. At the settings column's full
 * width (880px) the row's fixed parts (the mark, the sign-in column, the
 * permissions, the company control of a person with several companies, last
 * used, the button and the gaps between them) leave the name cell about
 * 194px. Beside the name "MCP-klient" (68px and an 8px gap) that is about
 * 118px: 18 characters of this text at 12px, which average 6.5px each.
 */
export const SHARED_NAME_TEXT_BUDGET = 18

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

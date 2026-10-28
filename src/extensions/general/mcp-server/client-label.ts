/**
 * The `client` telemetry label on every MCP event (mcp.tool_called,
 * mcp.tools_list_called, mcp.resource_read, mcp.tool_searched, skill events).
 * Telemetry only: never identity, auth or behavior.
 *
 * Sources, first one that answers wins:
 *  1. marker: X-Accounted-Client, the legacy X-Gnubok-Client or `?client=`,
 *     stored lowercased exactly as before (every existing label unchanged).
 *  2. oauth: the provider the OAuth sign-in stored on the key from its
 *     validated redirect URI (api_keys.client), server-side.
 *  3. client_info: the MCP clientInfo name a 2026-07-28 client carries in
 *     `_meta` on every request.
 *  4. user_agent: the User-Agent header.
 * Sources 3 and 4 are mapped into the same vocabulary the markers use. A name
 * that maps to nothing is labelled `other` with the sanitized raw name in
 * `clientName`; a request with no source at all is `other` with source `none`.
 */

import type { McpClientSource } from '@/lib/events/types'

export type ClientSource = McpClientSource

export interface ClientLabel {
  client: string | null
  /** Sanitized raw client name, only when the fallback name maps to no label. */
  clientName: string | null
  /** Which fallback produced the label; null when it came from the marker. */
  clientSource: ClientSource | null
}

const MARKER_RE = /^[A-Za-z0-9._-]{1,64}$/

/** The explicit marker, validated and lowercased; null when absent or invalid. */
export function parseClientMarker(raw: string | null | undefined): string | null {
  return raw && MARKER_RE.test(raw) ? raw.toLowerCase() : null
}

const CLIENT_NAME_MAX = 64
// How much of a raw name is scanned for a product token: bounds the regex work
// on a header the caller controls.
const RAW_NAME_SCAN_MAX = 512

/**
 * A raw client name (clientInfo name, User-Agent) reduced to letters, digits
 * and `.-_/ `, whitespace collapsed, at most 64 characters. Null when nothing
 * is left.
 */
export function sanitizeClientName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .replace(/[^A-Za-z0-9._/ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CLIENT_NAME_MAX)
    .trim()
  return cleaned.length > 0 ? cleaned : null
}

/**
 * Product names to labels, matched against the start of a lowercased product
 * name. Mirrors public.agent_client_family so a fallback label lands in the
 * same family as the marker the connect dialog would have set.
 */
const CLIENT_NAME_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude[-_ ]?code/, 'claude-code'],
  [/^claude-cli/, 'claude-code'],
  [/^claude[-_ ]?desktop/, 'claude-desktop'],
  [/^claude(-ai|-user)?$/, 'claude-connector'],
  [/^chatgpt/, 'chatgpt'],
  [/^openai-mcp/, 'chatgpt'],
  [/^codex/, 'codex'],
  [/^cursor/, 'cursor'],
  [/^gem[ie]ni/, 'gemini'],
  [/^grok/, 'grok'],
  [/^openclaw/, 'openclaw'],
  [/^opencode/, 'opencode'],
  [/^accounted-cli/, 'accounted-cli'],
  [/^(vscode|visual studio code)/, 'vscode'],
  [/^zed/, 'zed'],
]

function labelForProduct(product: string): string | null {
  for (const [pattern, label] of CLIENT_NAME_LABELS) {
    if (pattern.test(product)) return label
  }
  return null
}

/**
 * The label for a raw client name, or null when it maps to nothing. Tries the
 * whole name first ("Visual Studio Code", "claude-ai"), then each
 * User-Agent product token ("Mozilla/5.0 (...) Cursor/1.7" -> "cursor").
 */
export function clientLabelForName(raw: string): string | null {
  const whole = raw.trim().toLowerCase()
  if (!whole) return null
  const direct = labelForProduct(whole)
  if (direct) return direct
  for (const token of whole.split(/\s+/)) {
    const product = token.replace(/^[^a-z0-9]+/, '').split('/')[0]
    if (!product) continue
    const label = labelForProduct(product)
    if (label) return label
  }
  return null
}

/**
 * The label for the provider an OAuth key was minted for. `local` (any
 * loopback client) and `registered:<id>` say nothing about the product, so
 * they fall through to the next source.
 */
export function clientLabelForOAuthProvider(provider: string | null | undefined): string | null {
  switch (provider) {
    case 'claude':
      return 'claude-connector'
    case 'chatgpt':
      return 'chatgpt'
    case 'grok':
      return 'grok'
    case 'gemini':
      return 'gemini'
    case 'cursor':
    case 'cursor_deeplink':
      return 'cursor'
    default:
      return null
  }
}

/** clientInfo.name from a stateless request's `_meta`, when present. */
export function clientInfoNameFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null
  const info = (meta as Record<string, unknown>)['io.modelcontextprotocol/clientInfo']
  if (!info || typeof info !== 'object') return null
  const name = (info as Record<string, unknown>).name
  return typeof name === 'string' && name.trim() ? name : null
}

export function resolveClientLabel(input: {
  marker: string | null | undefined
  oauthProvider?: string | null
  clientInfoName?: string | null
  userAgent?: string | null
}): ClientLabel {
  const marker = parseClientMarker(input.marker)
  if (marker) return { client: marker, clientName: null, clientSource: null }
  const oauth = clientLabelForOAuthProvider(input.oauthProvider)
  if (oauth) return { client: oauth, clientName: null, clientSource: 'oauth' }
  const fallbacks: ReadonlyArray<readonly [ClientSource, string | null | undefined]> = [
    ['client_info', input.clientInfoName],
    ['user_agent', input.userAgent],
  ]
  for (const [source, raw] of fallbacks) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    // Mapped on the raw value: the 64-character cut of a long browser-style
    // User-Agent could drop the product token that names the client.
    const label = clientLabelForName(raw.slice(0, RAW_NAME_SCAN_MAX))
    if (label) return { client: label, clientName: null, clientSource: source }
    return { client: 'other', clientName: sanitizeClientName(raw), clientSource: source }
  }
  return { client: 'other', clientName: null, clientSource: 'none' }
}

/**
 * The client fields every MCP telemetry payload carries. clientName and
 * clientSource are left out when empty, so a marker-labelled row keeps its
 * exact previous shape.
 */
export function clientTelemetryFields(actor: {
  client?: string | null
  clientName?: string | null
  clientSource?: ClientSource | null
}): { client: string | null; clientName?: string; clientSource?: ClientSource } {
  return {
    client: actor.client ?? null,
    ...(actor.clientName ? { clientName: actor.clientName } : {}),
    ...(actor.clientSource ? { clientSource: actor.clientSource } : {}),
  }
}

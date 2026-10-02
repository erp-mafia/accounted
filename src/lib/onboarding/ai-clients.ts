import { claudeConnectorLink, sideDoorServerUrl, type SideDoor } from '@/lib/onboarding/checklist'

// Browser-safe on purpose: client components import this file. The
// database read lives in ai-clients.server.ts (lib/auth/api-keys pulls in
// node:crypto, which must not reach the client bundle).

/**
 * The three AI clients the product connects to over MCP, in display order.
 * One list for the books act's last card, the Hem worklist footer and the
 * connected-state readout, so the logos, names and connector pages can
 * never disagree between surfaces.
 */
export type AiClient = 'claude' | 'chatgpt' | 'grok'

export const AI_CLIENTS: { id: AiClient; name: string; logo: string; home: string }[] = [
  { id: 'claude', name: 'Claude', logo: '/logos/claude.webp', home: 'https://claude.ai/customize/connectors' },
  { id: 'chatgpt', name: 'ChatGPT', logo: '/logos/chatgpt.webp', home: 'https://chatgpt.com/#settings/Connectors' },
  { id: 'grok', name: 'Grok', logo: '/logos/grok.webp', home: 'https://grok.com/connectors' },
]

const AI_CLIENT_IDS = new Set<string>(AI_CLIENTS.map((c) => c.id))

/** Open the connector with no opener access, or continue in this tab if popups are blocked. */
export function openAiConnector(url: string): void {
  // Opening with noopener returns null even on success, so first open a blank
  // same-origin page, sever its opener, and only then navigate externally.
  const popup = window.open('about:blank', '_blank')
  if (popup) {
    popup.opener = null
    popup.location.replace(url)
  } else {
    window.location.assign(url)
  }
}

/**
 * Which clients have completed the MCP OAuth sign-in, from the user's live
 * OAuth-minted keys. `client` is what the token route stored from the
 * redirect URI (migration 20260913120000); rows older than that column,
 * Cursor, localhost and registered clients carry null or another value and
 * count as none of the three. This answers "which named client can work be
 * handed to", never "is an agent connected": that is aiConnection().
 * Pure so the readout can be pinned in tests.
 */
export function connectedAiClients(rows: { client: string | null }[]): AiClient[] {
  const seen = new Set<AiClient>()
  for (const r of rows) {
    if (r.client && AI_CLIENT_IDS.has(r.client)) seen.add(r.client as AiClient)
  }
  return AI_CLIENTS.map((c) => c.id).filter((id) => seen.has(id))
}

/**
 * Whether an agent is connected, and which of the three it is when known.
 *
 * `connected` is the one fact every "is an agent connected" readout answers
 * from (the Hem agent chip, the checklist's connect step, the Instruktioner
 * pages' connect gate, the books act's chips; the browser gets it as
 * `agentConnected`, see aiConnectionFromWire): a live, unrevoked
 * OAuth MCP key for this user, whatever its `client` value. A key's client
 * is null when it predates migration 20260913120000 or came from a
 * registered client, and Cursor or a localhost bridge store their own
 * values: those are real, working connections, so they count. Manually
 * created Settings keys never reach this (the read filters on the OAuth key
 * name): a manual key may be a REST integration, not an agent. Nor the
 * in-app AI-profile flag, which has nothing to do with it (issue #2133).
 *
 * `clients` is only the verified subset (connectedAiClients), for anything
 * that hands work to a named client. It may be empty while `connected` is
 * true: an agent is connected, just not one we can open a chat in.
 */
export interface AiConnection {
  connected: boolean
  clients: AiClient[]
}

export const NO_AI_CONNECTION: AiConnection = { connected: false, clients: [] }

/** Pure: `rows` are the user's live OAuth MCP keys (ai-clients.server.ts). */
export function aiConnection(rows: { client: string | null }[]): AiConnection {
  return { connected: rows.length > 0, clients: connectedAiClients(rows) }
}

/**
 * The connection as the browser reads it back from /api/ai/connections,
 * /api/onboarding/ai-status or the books findings: the verified clients plus
 * the `agentConnected` fact. A verified client is itself a live key, so a
 * payload without the flag still reads as connected when it names one.
 */
export function aiConnectionFromWire(clients: AiClient[], agentConnected: boolean | undefined): AiConnection {
  return { connected: agentConnected === true || clients.length > 0, clients }
}

/**
 * An agent is connected, but not one of the three we can name. A surface that
 * lists the three clients with connect offers (the books act's chips) shows a
 * generic connected agent instead: any offer would only earn "a connector
 * with this URL already exists" from the client the user already added.
 */
export function unknownAgentOnly(connection: AiConnection): boolean {
  return connection.connected && connection.clients.length === 0
}

/**
 * The Hem agent chip. Off: the three connectable logos, the generic name and
 * a connect pill. On: the known clients' logos and names; when only an
 * unknown client is connected, no logo and no name, so the chip reads as a
 * generic connected agent. Either way on means no connect pill: offering it
 * again only earns "a connector with this URL already exists" from the
 * client.
 */
export function agentChipView(connection: AiConnection): { on: boolean; logos: AiClient[]; named: AiClient[] } {
  if (!connection.connected) return { on: false, logos: AI_CLIENTS.map((c) => c.id), named: [] }
  return { on: true, logos: connection.clients, named: connection.clients }
}

/** Prefer the client just connected, but never offer an unverified connection. */
export function pickConnectedAiClient(clients: AiClient[], preferred?: AiClient): AiClient | null {
  if (preferred && clients.includes(preferred)) return preferred
  return AI_CLIENTS.find((client) => clients.includes(client.id))?.id ?? null
}

/**
 * Open an empty chat. Company identifiers and task details must never enter
 * third-party URLs, browser history or URL logs. The user reviews and copies
 * the prompt inside Accounted, then pastes it into their chosen client.
 *
 * The one exception is a claude:// link to Claude Desktop or Cowork
 * (components/skills/run.ts): it is a local handoff to the app on the same
 * device, with no HTTP request and no URL log, like a paste. It may carry
 * text the user wrote and the company (name and company_id). An https ?q=
 * link never does.
 */
export function aiChatLink(client: AiClient): string {
  switch (client) {
    case 'claude':
      return 'https://claude.ai/new'
    case 'chatgpt':
      return 'https://chatgpt.com/'
    case 'grok':
      return 'https://grok.com/'
  }
}

/**
 * What the Anslut button for a client does. Claude has an add-connector
 * deep link that prefills everything. ChatGPT and Grok have none: the
 * server address is copied and the client's connector page opened. Pure:
 * the component owns window.open and the clipboard.
 */
export function aiConnectAction(client: AiClient, input: { origin: string; appName: string }): { open: string; copy: string | null } {
  if (client === 'claude') {
    return { open: claudeConnectorLink({ origin: input.origin, appName: input.appName }), copy: null }
  }
  return {
    open: AI_CLIENTS.find((c) => c.id === client)?.home ?? '/',
    copy: sideDoorServerUrl({ origin: input.origin, door: client as SideDoor }),
  }
}

/** The Kvittojakten skill served to each client (lib/agent-skills/workflows/kvittojakten.ts). */
export function kvittojaktenSkillSlug(client: AiClient): string {
  return `kvittojakten-${client}`
}

/**
 * Open a chat with the Kvittojakten prompt already typed in: the one handoff
 * that travels in a query string. The rule above still holds because this
 * prompt names a skill and nothing else: no company, no count, no task
 * detail. The agent learns the company and the work from Accounted over MCP
 * after the chat opens. Never pass a prompt that carries tenant data here.
 */
export function aiPrefilledChatLink(client: AiClient, prompt: string): string {
  return `${aiChatLink(client)}?q=${encodeURIComponent(prompt)}`
}

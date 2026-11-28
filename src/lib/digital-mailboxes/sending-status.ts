import { DIGITAL_MAILBOX_PROVIDERS, type DigitalMailboxProviderId } from '@/lib/digital-mailboxes/types'

/**
 * The company's digital mailbox sending as the browser reads it from
 * GET /api/digital-mailboxes. Client-safe: no provider code, no keys; the
 * invoice editor and the salary run page decide from it which mailbox
 * channels to offer. The server checks again on every send.
 */

/** The providers' own names: brand names, the same in every locale. */
export const DIGITAL_MAILBOX_PROVIDER_NAMES: Record<DigitalMailboxProviderId, string> = {
  kivra: 'Kivra',
  billo: 'Billo',
}

/**
 * Where the company's sending through a provider stands: active; pending,
 * while the provider has not yet accepted Accounted's access request (the
 * company already sends through it via another service); rejected, when the
 * provider declined that request; off otherwise (never switched on, or
 * switched off). The Inkorg row shows it, and a send refused while it is not
 * active names it (lib/digital-mailboxes/sending-not-active.ts).
 */
export type DigitalMailboxSendingState = 'off' | 'pending' | 'rejected' | 'active'

/** See DigitalMailboxSendingState: from the connection's send_state and its access request (ConnectionSummary). */
export function sendingStateOf(
  connection: { send_state?: string | null; send_request?: 'pending' | 'rejected' | null } | null,
): DigitalMailboxSendingState {
  if (connection?.send_state === 'active') return 'active'
  return connection?.send_request ?? 'off'
}

interface ProviderStatusEntry {
  available?: { send?: unknown } | null
  connection?: { send_state?: unknown } | null
}

/**
 * The providers this company sends through: the deployment can send through
 * the provider (available.send) and the company activated itself as a sender
 * (connection.send_state 'active'). In provider order. Anything that is not
 * the route's answer reads as none, so a failed read offers no mailbox
 * channel instead of one the server would refuse.
 */
export function activeSendingProviders(body: unknown): DigitalMailboxProviderId[] {
  if (!body || typeof body !== 'object') return []
  const providers = (body as { data?: { providers?: unknown } }).data?.providers
  if (!providers || typeof providers !== 'object') return []
  return DIGITAL_MAILBOX_PROVIDERS.filter((id) => {
    const entry = (providers as Record<string, ProviderStatusEntry | undefined>)[id]
    return entry?.available?.send === true && entry.connection?.send_state === 'active'
  })
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Read GET /api/digital-mailboxes once. Never throws: a refused or failed
 * read (offline, a role without access) is no active provider, and email
 * stays the channel.
 */
export async function fetchActiveSendingProviders(fetchImpl: FetchLike = fetch): Promise<DigitalMailboxProviderId[]> {
  try {
    const response = await fetchImpl('/api/digital-mailboxes')
    if (!response.ok) return []
    return activeSendingProviders(await response.json())
  } catch {
    return []
  }
}

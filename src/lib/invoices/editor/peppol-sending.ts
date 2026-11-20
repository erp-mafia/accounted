import type { PeppolSending } from './channel'

/**
 * The company's e-faktura sending as the browser reads it from
 * GET /api/settings/peppol (lib/invoices/peppol-settings-service.ts). The
 * invoice editor decides from it whether to list Peppol; the send route
 * checks access, the monthly cap and the transport again on every send.
 */

interface SettingsBody {
  data?: {
    transport?: { available?: unknown } | null
    access?: { send_enabled?: unknown; remaining_sends?: unknown } | null
  } | null
}

/**
 * Sending is open when the deployment has a Peppol transport and the
 * company's access is granted (the same pair the invoice page gates its
 * "Skicka via Peppol" on). Anything that is not the route's answer reads as
 * closed, so a failed read lists no Peppol channel instead of one the server
 * would refuse.
 */
export function peppolSendingFromSettings(body: unknown): PeppolSending | null {
  if (!body || typeof body !== 'object') return null
  const data = (body as SettingsBody).data
  if (data?.transport?.available !== true || data.access?.send_enabled !== true) return null
  const remaining = data.access.remaining_sends
  return { remainingSends: typeof remaining === 'number' ? remaining : null }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Read GET /api/settings/peppol once. Never throws: a refused or failed read
 * (offline, a server error) is no Peppol sending, and the other channels stay.
 */
export async function fetchPeppolSending(fetchImpl: FetchLike = fetch): Promise<PeppolSending | null> {
  try {
    const response = await fetchImpl('/api/settings/peppol')
    if (!response.ok) return null
    return peppolSendingFromSettings(await response.json())
  } catch {
    // Safe to ignore: the read only decides whether the menu lists Peppol.
    // Closed hides one channel; the send route is the gate that matters.
    return null
  }
}

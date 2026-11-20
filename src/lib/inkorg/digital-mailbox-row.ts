/**
 * What one Kivra or Billo row of "Lägg till brevlåda" shows, from what
 * GET /api/digital-mailboxes answers for the provider: whether the mailbox
 * is read, waits for its activation or is off; whether the company sends
 * through the provider; and the failure worth a line.
 *
 * Pure: the dialog fetches and renders, this decides.
 */
import type { ConnectionSummary } from '@/lib/digital-mailboxes/connections'
import type { DigitalMailboxAvailability } from '@/lib/digital-mailboxes/providers'

/**
 * off: nothing reads the mailbox (never connected, or disconnected), so the
 * row offers to connect it. pending: Kivra has not confirmed the activation
 * yet. active: the mailbox is read into the Inkorg.
 */
export type DigitalMailboxReceive = 'off' | 'pending' | 'active'

export type DigitalMailboxSending = 'off' | 'pending' | 'rejected' | 'active'

export interface DigitalMailboxRowView {
  receive: DigitalMailboxReceive
  /** When the mailbox was last read, while it is read. */
  lastSyncedAt: string | null
  /** Billo's scanning address for paper mail on one line, while the mailbox is read and Billo gave one. */
  postalAddress: string | null
  /**
   * Whether the company sends invoices and payslips through the provider;
   * null where this deployment cannot send. pending: the company already
   * sends through another service and the provider has not yet accepted
   * Accounted's access request; rejected: the provider declined it.
   */
  sending: DigitalMailboxSending | null
  /**
   * The last failure, while something still reads the mailbox: an error left
   * on a disconnected row is history, not something to act on. The provider's
   * own text is never shown, only that it failed and when.
   */
  error: { at: string | null } | null
}

export function digitalMailboxRowView(
  available: DigitalMailboxAvailability,
  connection: ConnectionSummary | null,
): DigitalMailboxRowView {
  const state = connection?.receive_state
  const receive: DigitalMailboxReceive = state === 'pending' || state === 'active' ? state : 'off'
  return {
    receive,
    lastSyncedAt: receive === 'active' ? (connection?.last_synced_at ?? null) : null,
    postalAddress: receive === 'active' ? billoPostalAddress(connection?.postal_address) : null,
    sending: available.send ? sendingOf(connection) : null,
    error: receive !== 'off' && connection?.last_error ? { at: connection.last_error_at } : null,
  }
}

function sendingOf(connection: ConnectionSummary | null): DigitalMailboxSending {
  if (connection?.send_state === 'active') return 'active'
  return connection?.send_request ?? 'off'
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Billo's billoAddress ({ careOf, line1, line2, postalCode, city, state,
 * country }) on one line: "careOf, line1, line2, postalCode city". The
 * careOf part is kept as Billo wrote it, since it carries the customer
 * number the post is sorted by. The country is left out: Billo scans in
 * Sweden. Null for anything that is not an address with at least a street
 * line or a postal town.
 */
export function billoPostalAddress(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const address = value as Record<string, unknown>
  const line1 = text(address.line1)
  const town = [text(address.postalCode), text(address.city)].filter(Boolean).join(' ') || null
  if (!line1 && !town) return null
  return [text(address.careOf), line1, text(address.line2), town].filter(Boolean).join(', ')
}

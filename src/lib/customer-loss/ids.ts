/**
 * The id of the next kundförlust decision of `kind` on an invoice: a name
 * based UUID (RFC 9562 version 5 layout) over the invoice, the kind and how
 * many rows of that kind the invoice already has.
 *
 * The id is also the voucher's source_id, and
 * journal_entries_customer_loss_live_unique allows one live voucher per
 * source_id. Two concurrent clicks on the same invoice therefore compute the
 * same id, and the second fails at the draft insert before a voucher number
 * is taken, instead of booking the loss twice.
 *
 * Web Crypto rather than node:crypto: the services are reachable from client
 * modules through the credit-note path (check:guards client-node-builtin).
 */
export async function decisionId(invoiceId: string, kind: string, ordinal: number): Promise<string> {
  const data = new TextEncoder().encode(`accounted:customer-loss:${invoiceId}:${kind}:${ordinal}`)
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', data)).slice(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

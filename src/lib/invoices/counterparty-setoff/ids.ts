/**
 * The id of the next set-off between a customer invoice and a supplier
 * invoice: a name based UUID (RFC 9562 version 5 layout) over the pair and how
 * many set-offs the pair already has, reversed ones included.
 *
 * The id is also the voucher's source_id, and
 * journal_entries_counterparty_setoff_live_unique allows one live voucher per
 * source_id. Two concurrent clicks on the same pair therefore compute the same
 * id, and the second fails at the draft insert before a voucher number is
 * taken, instead of setting off twice.
 *
 * Web Crypto rather than node:crypto, as lib/customer-loss/ids.ts: no
 * node built-in in a module a client component may reach.
 */
export async function setoffId(invoiceId: string, supplierInvoiceId: string, ordinal: number): Promise<string> {
  const data = new TextEncoder().encode(`accounted:counterparty-setoff:${invoiceId}:${supplierInvoiceId}:${ordinal}`)
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', data)).slice(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

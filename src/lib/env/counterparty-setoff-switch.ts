/**
 * COUNTERPARTY_SETOFF_ENABLED: kvittning of a customer invoice against a
 * supplier invoice of the same counterparty (lib/invoices/counterparty-setoff):
 * the Kvitta action, its routes and the two operations (served to v1 and MCP
 * only while it is set). Unset = off, until the founder switches it on in
 * Vercel.
 *
 * What the flag never stops: the dashboard's open items and net balance for a
 * counterparty (a read of the invoices as they stand), and the storno of a
 * set-off voucher already booked, whose reversal hook restores both invoices
 * whatever the flag says.
 *
 * Kept in the shared lib/env rather than lib/invoices: the ledger's
 * systemdokumentation reads the switch too, and the ledger imports nothing
 * from the invoicing block.
 */
export function counterpartySetoffEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.COUNTERPARTY_SETOFF_ENABLED?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

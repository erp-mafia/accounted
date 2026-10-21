/**
 * CUSTOMER_LOSS_ENABLED: the kundförlust menu, route and operation, and with
 * them every new write to the written_off status. Unset = off (F14: off until
 * the founder decides, after the accountant has seen real cases).
 *
 * Kundförlust is provider-independent: it does not depend on the collections
 * gates, and a closed collection case only changes where the menu shows.
 * What the flag never stops: releasing a befarad reserve once the invoice is
 * paid or credited, and the bookkeeping that follows a storno of a
 * kundförlust voucher. Those keep the books right for decisions already made.
 *
 * Kept in the shared lib/env rather than lib/customer-loss: the ledger's
 * systemdokumentation reads the switch too, and the ledger imports nothing
 * from the invoicing block (Phase 2's exit check,
 * lib/modules/__tests__/phase2-exit-check.test.ts).
 */
export function customerLossEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.CUSTOMER_LOSS_ENABLED?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

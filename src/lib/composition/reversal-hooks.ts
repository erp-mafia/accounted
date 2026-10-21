/**
 * The reversal hooks reverseEntry() runs (contract and rules:
 * lib/bookkeeping/reversal-hooks.ts). Written out by hand and imported
 * statically by engine.ts: no lazy loading, no lib/init, no event bus, so
 * every runtime that can reverse an entry has every hook.
 *
 * Each entry wraps a function that already existed, unchanged, with the
 * same arguments engine.ts passed before the list existed. The source types
 * do not overlap, so at most one hook runs per storno.
 *
 * This folder is a composition seam: only allowlisted files may import it,
 * and it may import only hook leaf modules, which never reach engine.ts
 * (compositionSeams in lib/modules/__tests__/boundary.test.ts, and the
 * cycle guard in ./__tests__/reversal-hooks.test.ts).
 */
import type { ReversalHook } from '@/lib/bookkeeping/reversal-hooks'
import { PAYMENT_SOURCE_TYPES, syncInvoiceStatusFromPaymentEntry } from '@/lib/bookkeeping/payment-sync'
import { syncRotRutReclaimAfterReversal } from '@/lib/invoices/rot-rut-reclaim-reversal'
import {
  assertMigratedDeductionReversible,
  syncMigratedDeductionAfterReversal,
} from '@/lib/invoices/migrated-deduction-reversal'
import { releaseSettlementAfterReversal } from '@/lib/collections/settlement-reversal'
import { assertCustomerLossReversible, syncCustomerLossAfterReversal } from '@/lib/customer-loss/reversal'

export const REVERSAL_HOOKS: readonly ReversalHook[] = Object.freeze<ReversalHook[]>([
  // A reversed payment voucher puts the linked invoice or supplier invoice
  // back to its unpaid state. The helper is shared with the DELETE journal
  // entry route so both paths leave the invoice consistent (BFL 5 kap 5 §
  // requires the GL reversal; this covers the business state outside it).
  {
    id: 'invoice-payment-status',
    module: 'ledger',
    sourceTypes: PAYMENT_SOURCE_TYPES,
    // The collections rebook's storno leaves the collected payment rows
    // for the rebook to remove (ReversalHookContext.leaveCollectedPaymentRows).
    afterReversal: ({ supabase, companyId, entry, leaveCollectedPaymentRows }) =>
      leaveCollectedPaymentRows
        ? syncInvoiceStatusFromPaymentEntry(supabase, companyId, entry, undefined, { leaveCollectedPaymentRows })
        : syncInvoiceStatusFromPaymentEntry(supabase, companyId, entry),
  },
  // A reversed rot_rut_reclaim voucher hands the refused share back to
  // Skatteverket's side: the invoices it reopened close again and the
  // begäran becomes reclaimable again (skeptic #2397 R3).
  {
    id: 'rot-rut-reclaim',
    module: 'invoicing',
    sourceTypes: ['rot_rut_reclaim'],
    afterReversal: ({ supabase, companyId, entry }) =>
      syncRotRutReclaimAfterReversal(supabase, companyId, entry.id),
  },
  // A migrated invoice's deduction reclassification: refused while a
  // begäran holds the invoice (checked before a voucher number is spent),
  // and once reversed the deduction is back on 1510, so the invoice reads it
  // as the buyer's again.
  {
    id: 'migrated-deduction',
    module: 'invoicing',
    sourceTypes: ['rot_rut_reclassification'],
    beforeReversal: ({ supabase, companyId, entry }) =>
      assertMigratedDeductionReversible(supabase, companyId, entry),
    afterReversal: ({ supabase, companyId, entry }) =>
      syncMigratedDeductionAfterReversal(supabase, companyId, entry),
  },
  // A reversed collections payout voucher returns the payout to the
  // settlements view to be booked again (lib/collections/settlement-reversal.ts).
  {
    id: 'collections-payout',
    module: 'collections',
    sourceTypes: ['collection_settlement'],
    afterReversal: async ({ companyId, entry }) => {
      await releaseSettlementAfterReversal(companyId, entry.id)
    },
  },
  // A kundförlust voucher is undone latest decision first (a recovery before
  // the write-off it recovers), refused before a voucher number is spent;
  // once reversed, its decision is annulled: a written-off invoice gets its
  // open status back and the momsdeklaration adds the ruta 05 base back in
  // the storno's period (lib/customer-loss/reversal.ts). A recovery booked
  // from a collected payment is refused earlier, in reverseEntry, unless the
  // collections rebook holds it.
  {
    id: 'customer-loss',
    module: 'invoicing',
    sourceTypes: ['customer_loss'],
    beforeReversal: ({ supabase, companyId, entry }) => assertCustomerLossReversible(supabase, companyId, entry.id),
    afterReversal: ({ supabase, companyId, userId, entry, storno }) =>
      syncCustomerLossAfterReversal(supabase, companyId, userId, entry.id, {
        id: storno.id,
        entry_date: storno.entry_date,
      }),
  },
])

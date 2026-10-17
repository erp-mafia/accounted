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

export const REVERSAL_HOOKS: readonly ReversalHook[] = Object.freeze<ReversalHook[]>([
  // A reversed payment voucher puts the linked invoice or supplier invoice
  // back to its unpaid state. The helper is shared with the DELETE journal
  // entry route so both paths leave the invoice consistent (BFL 5 kap 5 §
  // requires the GL reversal; this covers the business state outside it).
  {
    id: 'invoice-payment-status',
    module: 'ledger',
    sourceTypes: PAYMENT_SOURCE_TYPES,
    afterReversal: ({ supabase, companyId, entry }) =>
      syncInvoiceStatusFromPaymentEntry(supabase, companyId, entry),
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
])

/**
 * The reversal hooks reverseEntry() runs (contract and rules:
 * lib/bookkeeping/reversal-hooks.ts). Written out by hand and imported
 * statically by engine.ts: no lazy loading, no lib/init, no event bus, so
 * every runtime that can reverse an entry has every hook.
 *
 * Each entry wraps a function that already existed, unchanged, with the
 * same arguments engine.ts passed before the list existed. The source types
 * do not overlap, so at most one hook runs per storno. The storno of a
 * correction runs only the hooks marked followsCorrection, for the source
 * type of the verifikat it corrects; each says what it reads there.
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
import {
  assertCounterpartySetoffReversible,
  syncCounterpartySetoffAfterReversal,
} from '@/lib/invoices/counterparty-setoff/reversal'
import {
  assertComponentReplacementReversible,
  assertValueAdjustmentReversible,
  releaseComponentsAfterReversal,
} from '@/lib/bokslut/assets/component-reversal'
import {
  assertSupplierInvoiceRegistrationReversible,
  releaseSupplierInvoiceRegistrationAfterReversal,
} from '@/lib/supplier-invoices/registration-reversal'
import { assertInvoiceVerifikatReversible } from '@/lib/invoices/invoice-verifikat-reversal'
import { assertSalaryRunVerifikatReversible } from '@/lib/salary/run-verifikat-reversal'
import { assertExpenseClaimVerifikatReversible } from '@/lib/expenses/claim-verifikat-reversal'

export const REVERSAL_HOOKS: readonly ReversalHook[] = Object.freeze<ReversalHook[]>([
  // A reversed payment voucher puts the linked invoice or supplier invoice
  // back to its unpaid state. The helper is shared with the DELETE journal
  // entry route so both paths leave the invoice consistent (BFL 5 kap 5 §
  // requires the GL reversal; this covers the business state outside it).
  {
    id: 'invoice-payment-status',
    module: 'ledger',
    sourceTypes: PAYMENT_SOURCE_TYPES,
    // A correction of a payment verifikat carries its payment rows
    // (relinkPaymentRowsToEntry): they are read by the correction's id, for
    // the invoice its original paid, and without one nothing is reverted.
    followsCorrection: true,
    // The collections rebook's storno leaves the collected payment rows
    // for the rebook to remove (ReversalHookContext.leaveCollectedPaymentRows).
    afterReversal: ({ supabase, companyId, entry, leaveCollectedPaymentRows, correctedOriginal }) =>
      correctedOriginal
        ? syncInvoiceStatusFromPaymentEntry(
            supabase,
            companyId,
            { id: entry.id, source_type: correctedOriginal.source_type, source_id: correctedOriginal.source_id },
            undefined,
            { requirePaymentRow: true },
          )
        : leaveCollectedPaymentRows
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
  // A kvittning voucher: refused while one of its invoices has been credited
  // or written off since (checked before a voucher number is spent); once
  // reversed, both invoices get the set-off amount back and their payment
  // rows go (lib/invoices/counterparty-setoff/reversal.ts).
  {
    id: 'counterparty-setoff',
    module: 'invoicing',
    sourceTypes: ['counterparty_setoff'],
    beforeReversal: ({ supabase, companyId, entry }) => assertCounterpartySetoffReversible(supabase, companyId, entry.id),
    afterReversal: ({ supabase, companyId, userId, entry, storno }) =>
      syncCounterpartySetoffAfterReversal(supabase, companyId, userId, entry.id, { id: storno.id }),
  },
  // A K3 component replacement voucher (source_type system, like a
  // disposal): refused once a later depreciation was planned without the
  // replaced component; once reversed, the component is active again
  // (lib/bokslut/assets/component-reversal.ts). Any other system voucher
  // finds no component and passes untouched.
  {
    id: 'asset-component-replacement',
    module: 'assets',
    sourceTypes: ['system'],
    // A nedskrivning or its reversal is a system voucher as well: refused
    // while a later depreciation, write-down or the disposal was planned from
    // the written-down value. Once reversed, its rows stop counting by
    // themselves (asset_value_adjustments counts posted vouchers only).
    beforeReversal: async ({ supabase, companyId, entry }) => {
      await assertComponentReplacementReversible(supabase, companyId, entry.id)
      await assertValueAdjustmentReversible(supabase, companyId, entry.id)
    },
    afterReversal: ({ supabase, companyId, entry }) =>
      releaseComponentsAfterReversal(supabase, companyId, entry.id),
  },
  // A supplier invoice's registration verifikat: refused while the invoice
  // is credited or has payments (checked before a voucher number is spent);
  // once reversed, the invoice no longer points at it, so it reads not booked
  // and Bokför books it again (lib/supplier-invoices/registration-reversal.ts).
  // A registration no invoice points at passes untouched. A correction of a
  // registration carries the invoice's pointer (relinkBookedRecordsToEntry),
  // so its storno is checked and released by its own id.
  {
    id: 'supplier-invoice-registration',
    module: 'supplier-invoices',
    sourceTypes: ['supplier_invoice_registered'],
    followsCorrection: true,
    beforeReversal: ({ supabase, companyId, entry }) =>
      assertSupplierInvoiceRegistrationReversible(supabase, companyId, entry.id),
    afterReversal: ({ supabase, companyId, entry }) =>
      releaseSupplierInvoiceRegistrationAfterReversal(supabase, companyId, entry.id),
  },
  // A customer invoice's verifikat: refused once the invoice is sent or
  // paid, which is withdrawn with Kreditera instead, and once it is credited
  // or written off, whose sale is out of the ledger already
  // (lib/invoices/invoice-verifikat-reversal.ts). A correction of it carries
  // the invoice's pointer (relinkBookedRecordsToEntry) and is checked by its
  // own id.
  {
    id: 'customer-invoice-verifikat',
    module: 'invoicing',
    sourceTypes: ['invoice_created'],
    followsCorrection: true,
    beforeReversal: ({ supabase, companyId, entry }) => assertInvoiceVerifikatReversible(supabase, companyId, entry.id),
  },
  // A booked salary run's verifikat: refused on its own, since Korrigera
  // lönekörning reverses all of them together
  // (lib/salary/run-verifikat-reversal.ts). Its own stornos carry
  // salaryRunCorrection and pass.
  {
    id: 'salary-run-verifikat',
    module: 'payroll',
    sourceTypes: ['salary_payment'],
    beforeReversal: async ({ supabase, companyId, entry, salaryRunCorrection }) => {
      if (salaryRunCorrection) return
      await assertSalaryRunVerifikatReversible(supabase, companyId, entry)
    },
  },
  // An expense claim's verifikat: refused while the claim stands, since Ta
  // bort on the claim reverses it and removes the claim together, and a paid
  // claim's is corrected instead (lib/expenses/claim-verifikat-reversal.ts).
  // Ta bort's own storno carries expenseClaimRemoval and passes. A correction
  // of it carries the claim's pointer (relinkBookedRecordsToEntry) and is
  // checked by its own id.
  {
    id: 'expense-claim-verifikat',
    module: 'expenses',
    sourceTypes: ['expense_claim'],
    followsCorrection: true,
    beforeReversal: async ({ supabase, companyId, entry, expenseClaimRemoval }) => {
      if (expenseClaimRemoval) return
      await assertExpenseClaimVerifikatReversible(supabase, companyId, entry.id)
    },
  },
])

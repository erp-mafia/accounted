import { equalOre, roundOre } from '@/lib/money'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { clearedSek } from '@/lib/bookkeeping/ledger-carried-sek'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import { FX_GAIN_ACCOUNT, FX_LOSS_ACCOUNT, bookedOreRounding, oreSettlementResidual } from '@/lib/bookkeeping/ore-rounding'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { payoutBankAmount, payoutFeeLines, payoutFeeTotal, type PayoutFee } from '@/lib/bookkeeping/payout-fee-lines'
import { supplierDebtLines, supplierDebtTotal, type SupplierDebt } from '@/lib/bookkeeping/supplier-debt-lines'
import { customerReceivableLines, type CustomerReceivable } from '@/lib/bookkeeping/customer-receivable-lines'

/**
 * The verifikat `match_batch_allocate` will post, computed from the same
 * inputs the RPC reads, before anything is staged or approved.
 *
 * Mirrors supabase/migrations/20260824120000_match_batch_allocate_ore_settlement.sql
 * line for line: the same allocation order (sorted by the invoice id text),
 * the same öresavrundning band (a sub-krona difference clears the whole
 * remaining off 1510/2440 and lands on 3740) and the same cross-currency legs
 * (booked SEK on 1510/2440, the difference on 7960/3960). The bank leg is the
 * caller's `bankAccount`: since 20260921180432 the RPC books it on
 * capture_bank_booking_context's settlement account (the transaction's own
 * cash account, else the only enabled one in its currency, else 1930), which
 * is resolveSettlementAccount's answer (lib/bookkeeping/settlement-account.ts).
 * This file used to hardcode 1930 after that patch and previewed a bank leg
 * the RPC no longer posts (issue #3097). Since 20260929015251 the RPC names a
 * single invoice in the header ("Utbetalning leverantörsfaktura <number>,
 * <supplier>", as the single-invoice match routes do) and keeps
 * "Samlingsbetalning <date>" for two or more. Since 20261028231700 the
 * request's fee rows follow the invoices' lines as debits, before the bank
 * leg, built by the RPC call's own builder (lib/bookkeeping/payout-fee-lines.ts).
 * Since 20261031100700 a kontantmetoden invoice with no verifikat books the
 * lines it is handed (p_cash_lines, lib/invoices/batch-cash-method-guard.ts) in
 * place of the 1510 clearing; the preview takes the same lines. Since
 * 20261101120200 the RPC refuses a foreign bank row (BATCH_FOREIGN_CURRENCY,
 * and so does matchTransactionBatch before it gets here), so every row here is
 * kronor, and a foreign invoice clears what the ledger carries (carried_sek,
 * read from the RPC's own document_carried_sek) or its remainder at the rate.
 * Since 20261119090000 a kronor customer invoice whose issue verifikat booked
 * the öresavrundning clears what 1510 carries on a settlement in full, and
 * 3740 takes only the rest of the öre (carried_sek, bookedOreRounding).
 * Since 20261120150000 a supplier batch's debt rows (the supplier debt from
 * before the company kept its books here, lib/bookkeeping/supplier-debt-lines.ts)
 * follow the fee rows as debits, the bank row carries them too, and a single
 * invoice with a debt row keeps the "Samlingsbetalning <date>" header.
 * Since 20261124100000 a customer batch's receivable rows (the customer
 * receivable from before, lib/bookkeeping/customer-receivable-lines.ts) follow
 * the fee rows as credits, the bank row carries them too, and a single invoice
 * with a receivable row keeps the "Samlingsinbetalning <date>" header.
 * When the RPC changes, this file changes with it; the pg-real suites (tests/pg/match-batch-allocate.pg.test.ts,
 * tests/pg/match-batch-preview-parity.pg.test.ts,
 * tests/pg/match-batch-allocate-series-description.pg.test.ts) are the
 * authority.
 *
 * Why a projection and not a dry run: the RPC posts inside one transaction
 * and has no read-only mode, and an API customer's review flow needs the
 * exact konto, debet, kredit and date before `approve_pending_operation`
 * runs, not after. Line descriptions here are neutral on purpose (GDPR
 * Art. 25, same posture as the rest of preview_data): the RPC writes invoice
 * numbers and supplier names on its own lines and on a single invoice's
 * header; the preview does not.
 */

export interface BatchAllocationPreviewTransaction {
  /** Signed amount in kronor: income > 0, expense < 0. */
  amount: number
  /** ISO date or timestamp; the first ten characters are the entry date. */
  date: string
}

export interface BatchAllocationPreviewAllocation {
  kind: 'customer_invoice' | 'supplier_invoice'
  invoice_id?: string | null
  supplier_invoice_id?: string | null
  /** Amount in kronor: for a foreign invoice, the SEK of the row it takes. */
  amount: number
}

/** The invoice columns the RPC reads. Missing rows fall back to the allocation amount. */
export interface BatchAllocationPreviewInvoice {
  currency?: string | null
  exchange_rate?: number | null
  remaining_amount?: number | null
  total?: number | null
  /**
   * What the ledger carries (carriedSekOf): for a foreign invoice, and for a
   * kronor customer invoice only when its issue verifikat booked the
   * öresavrundning. Null when it cannot say or there is nothing to read.
   */
  carried_sek?: number | null
}

export interface BatchAllocationPreviewLine {
  account_number: string
  description: string
  debit: number
  credit: number
}

export interface BatchAllocationPreview {
  entry_date: string
  /**
   * The verifikat header. Two or more invoices: exactly the RPC's text. One
   * invoice: the RPC's wording without the invoice number and counterparty it
   * appends ("Utbetalning leverantörsfaktura").
   */
  description: string
  lines: BatchAllocationPreviewLine[]
  /** Debits equal credits to the öre. Always true for a batch the RPC accepts. */
  balanced: boolean
  /**
   * none: every invoice is in kronor.
   * included: the 7960/3960 leg is in `lines`, computed from the invoice's booked rate.
   * computed_at_commit: a cross-currency invoice had no usable rate, so the
   * RPC will refuse or compute the leg at commit; the line shows the allocation.
   */
  fx: 'none' | 'included' | 'computed_at_commit'
}

const AR_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'accounts_receivable')
const AP_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'accounts_payable')
const ORE_ROUNDING_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'rounding')

/** `ORDER BY COALESCE(invoice_id, supplier_invoice_id, '')`: plain text order. */
function allocationSortKey(a: BatchAllocationPreviewAllocation): string {
  return a.invoice_id ?? a.supplier_invoice_id ?? ''
}

function usableRate(rate: number | null | undefined): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && rate < 100000
}

export function buildBatchAllocationPreview(input: {
  transaction: BatchAllocationPreviewTransaction
  /**
   * The ledger account of the bank leg: resolveSettlementAccount() for the
   * transaction's cash_account_id and currency, the account the RPC books.
   */
  bankAccount: string
  allocations: readonly BatchAllocationPreviewAllocation[]
  /** Keyed by invoice id or supplier invoice id. */
  invoices: ReadonlyMap<string, BatchAllocationPreviewInvoice> | Record<string, BatchAllocationPreviewInvoice>
  /** The payment service's fees on the row: one debit line each, no VAT. */
  fees?: readonly PayoutFee[] | null
  /**
   * Kontantmetoden: customer invoice id to the revenue, moms and
   * öresavrundning lines its sale books in place of the 1510 clearing, the
   * RPC's p_cash_lines exactly.
   */
  cashLines?: Readonly<Record<string, readonly { account_number: string; debit_amount: number; credit_amount: number }[]>>
  /** A supplier batch: the supplier debt from before the row also pays, one debit line each, no VAT. */
  supplierDebts?: readonly SupplierDebt[] | null
  /** A customer batch: the customer receivable from before the row also pays, one credit line each, no VAT. */
  customerReceivables?: readonly CustomerReceivable[] | null
}): BatchAllocationPreview {
  const { transaction, allocations, bankAccount } = input
  if (allocations.length === 0) throw new Error('allocations must not be empty')
  const lookup = (id: string): BatchAllocationPreviewInvoice | undefined =>
    input.invoices instanceof Map ? input.invoices.get(id) : (input.invoices as Record<string, BatchAllocationPreviewInvoice>)[id]

  const isCustomer = allocations[0].kind === 'customer_invoice'
  if (allocations.some((a) => (a.kind === 'customer_invoice') !== isCustomer)) {
    throw new Error('allocations must all be of one kind')
  }
  const txAbs = Math.abs(transaction.amount)
  const totalAllocated = roundOre(allocations.reduce((sum, a) => sum + a.amount, 0))
  const fees = payoutFeeLines(input.fees)
  // The rows from before go with their own side (BATCH_DEBT_SUPPLIER_ONLY,
  // BATCH_RECEIVABLE_CUSTOMER_ONLY): the RPC books them by the batch's side.
  if (isCustomer && (input.supplierDebts?.length ?? 0) > 0) throw new Error('supplier debt rows go with supplier invoices only')
  if (!isCustomer && (input.customerReceivables?.length ?? 0) > 0) {
    throw new Error('customer receivable rows go with customer invoices only')
  }
  const debts = isCustomer ? customerReceivableLines(input.customerReceivables) : supplierDebtLines(input.supplierDebts)
  const settled = payoutBankAmount(allocations[0].kind, totalAllocated, payoutFeeTotal(fees), supplierDebtTotal(debts))
  // The RPC refuses BATCH_AMOUNT_EXCEEDS_TX / BATCH_AMOUNT_BELOW_TX outside
  // this tolerance, so there is no verifikat to preview.
  if (Math.abs(settled - txAbs) > 0.005) {
    throw new Error(`allocations net of fees (${settled}) must equal the transaction amount (${txAbs})`)
  }

  const entryDate = transaction.date.slice(0, 10)
  const sorted = [...allocations].sort((a, b) => {
    const ka = allocationSortKey(a)
    const kb = allocationSortKey(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  const noun = isCustomer ? 'Kundfaktura' : 'Leverantörsfaktura'
  const settlementAccount = isCustomer ? AR_ACCOUNT : AP_ACCOUNT
  const lines: BatchAllocationPreviewLine[] = []
  let fx: BatchAllocationPreview['fx'] = 'none'

  // Customer: the receivable is credited. Supplier: the payable is debited.
  const settle = (amount: number, description: string) =>
    lines.push(
      isCustomer
        ? { account_number: settlementAccount, description, debit: 0, credit: amount }
        : { account_number: settlementAccount, description, debit: amount, credit: 0 },
    )

  sorted.forEach((alloc, index) => {
    const label = `${noun} ${index + 1} av ${sorted.length}`
    const cash = isCustomer && alloc.invoice_id ? input.cashLines?.[alloc.invoice_id] : undefined
    if (cash) {
      for (const line of cash) {
        lines.push({ account_number: line.account_number, description: label, debit: line.debit_amount, credit: line.credit_amount })
      }
      return
    }
    const invoice = lookup(allocationSortKey(alloc))
    const remaining = invoice?.remaining_amount ?? invoice?.total ?? null

    if (isKronorCurrency(invoice?.currency)) {
      if (remaining === null) {
        settle(alloc.amount, label)
        return
      }
      const oreDiff = oreSettlementResidual(remaining, alloc.amount)
      // The öre a customer invoice's issue verifikat already booked: a
      // settlement in full clears what 1510 carries and 3740 takes only the
      // rest, so the rounding is not booked twice. A part payment clears its
      // own kronor.
      const settlesInFull = oreDiff !== 0 || equalOre(alloc.amount, remaining)
      const issueOre = isCustomer && settlesInFull ? bookedOreRounding(remaining, invoice?.carried_sek) : 0
      if (oreDiff !== 0 || issueOre !== 0) {
        // Whole-krona settlement of an öre total: clear the full remaining and
        // let 3740 carry the residual. Customer short-paid = Dr 3740, over-paid
        // = Cr 3740; supplier is the mirror.
        settle(roundOre(remaining - issueOre), label)
        const residual = roundOre(oreDiff - issueOre)
        const debitSide = isCustomer ? residual > 0 : residual < 0
        if (residual !== 0) {
          lines.push({
            account_number: ORE_ROUNDING_ACCOUNT,
            description: 'Öresavrundning',
            debit: debitSide ? Math.abs(residual) : 0,
            credit: debitSide ? 0 : Math.abs(residual),
          })
        }
      } else {
        settle(alloc.amount, label)
      }
      return
    }

    // Cross-currency: the receivable/payable was booked at the invoice rate,
    // the bank settled in SEK; the difference is a kursvinst or kursförlust.
    const currencyLabel = `${label} (${invoice?.currency})`
    if (remaining === null || !usableRate(invoice?.exchange_rate)) {
      fx = 'computed_at_commit'
      settle(alloc.amount, currencyLabel)
      return
    }
    if (fx === 'none') fx = 'included'
    const bookedSek = clearedSek({ amount: remaining, remaining, carried: invoice?.carried_sek ?? null, rate: invoice.exchange_rate })
    const fxDiff = roundOre(bookedSek - alloc.amount)
    settle(bookedSek, currencyLabel)
    if (Math.abs(fxDiff) > 0.005) {
      // Customer: booked more than received = loss (Dr 7960), else gain (Cr 3960).
      // Supplier: booked more than paid = gain (Cr 3960), else loss (Dr 7960).
      const loss = isCustomer ? fxDiff > 0 : fxDiff < 0
      lines.push(
        loss
          ? { account_number: FX_LOSS_ACCOUNT, description: 'Valutakursförlust', debit: Math.abs(fxDiff), credit: 0 }
          : { account_number: FX_GAIN_ACCOUNT, description: 'Valutakursvinst', debit: 0, credit: Math.abs(fxDiff) },
      )
    }
  })

  // A fee is a cost on both sides: withheld from a payout, or added to a payment.
  for (const fee of fees) {
    lines.push({ account_number: fee.account, description: fee.description, debit: fee.amount, credit: 0 })
  }
  // The rows from before, after the fees: the supplier debt a debit on its
  // 244x skuld, the customer receivable a credit on its 151x fordran.
  for (const debt of debts) {
    lines.push(
      isCustomer
        ? { account_number: debt.account, description: debt.description, debit: 0, credit: debt.amount }
        : { account_number: debt.account, description: debt.description, debit: debt.amount, credit: 0 },
    )
  }

  lines.push(
    isCustomer
      ? { account_number: bankAccount, description: `Inbetalning ${entryDate}`, debit: txAbs, credit: 0 }
      : { account_number: bankAccount, description: `Utbetalning ${entryDate}`, debit: 0, credit: txAbs },
  )

  // One invoice: the RPC appends "<number>, <counterparty>" to this wording;
  // the preview leaves both out, like the neutral line descriptions. One
  // invoice with a row from before beside it is a samlingsbetalning or
  // samlingsinbetalning, as in the RPC.
  const singleInvoiceDescription = isCustomer ? 'Inbetalning kundfaktura' : 'Utbetalning leverantörsfaktura'
  const batchDescription = `${isCustomer ? 'Samlingsinbetalning' : 'Samlingsbetalning'} ${entryDate}`

  return {
    entry_date: entryDate,
    description: sorted.length === 1 && debts.length === 0 ? singleInvoiceDescription : batchDescription,
    lines,
    balanced: lineBalance(lines.map((l) => ({ debit_amount: l.debit, credit_amount: l.credit }))).difference === 0,
    fx,
  }
}

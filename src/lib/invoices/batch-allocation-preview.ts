import { roundOre } from '@/lib/money'

/**
 * The verifikat `match_batch_allocate` will post, computed from the same
 * inputs the RPC reads, before anything is staged or approved.
 *
 * Mirrors supabase/migrations/20260824120000_match_batch_allocate_ore_settlement.sql
 * line for line: the same allocation order (sorted by the invoice id text),
 * the same öresavrundning band (a sub-krona difference clears the whole
 * remaining off 1510/2440 and lands on 3740), the same cross-currency legs
 * (booked SEK on 1510/2440, the difference on 7960/3960) and the same bank
 * leg: the RPC books 1930 for every batch, whatever cash account the row
 * belongs to. When that migration changes, this file changes with it; the
 * pg-real suite (tests/pg/match-batch-allocate.pg.test.ts) is the authority.
 *
 * Why a projection and not a dry run: the RPC posts inside one transaction
 * and has no read-only mode, and an API customer's review flow needs the
 * exact konto, debet, kredit and date before `approve_pending_operation`
 * runs, not after. Line descriptions here are neutral on purpose (GDPR
 * Art. 25, same posture as the rest of preview_data): the RPC writes invoice
 * numbers and supplier names on its own lines, the preview does not.
 */

export interface BatchAllocationPreviewTransaction {
  /** Signed amount in the transaction currency: income > 0, expense < 0. */
  amount: number
  currency: string
  /** ISO date or timestamp; the first ten characters are the entry date. */
  date: string
}

export interface BatchAllocationPreviewAllocation {
  kind: 'customer_invoice' | 'supplier_invoice'
  invoice_id?: string | null
  supplier_invoice_id?: string | null
  /** Amount in the transaction currency (cross-currency: bank-credited SEK). */
  amount: number
}

/** The invoice columns the RPC reads. Missing rows fall back to the allocation amount. */
export interface BatchAllocationPreviewInvoice {
  currency?: string | null
  exchange_rate?: number | null
  remaining_amount?: number | null
  total?: number | null
}

export interface BatchAllocationPreviewLine {
  account_number: string
  description: string
  debit: number
  credit: number
}

export interface BatchAllocationPreview {
  entry_date: string
  description: string
  lines: BatchAllocationPreviewLine[]
  /** Debits equal credits to the öre. Always true for a batch the RPC accepts. */
  balanced: boolean
  /**
   * none: every invoice is in the transaction currency.
   * included: the 7960/3960 leg is in `lines`, computed from the invoice's booked rate.
   * computed_at_commit: a cross-currency invoice had no usable rate, so the
   * RPC will refuse or compute the leg at commit; the line shows the allocation.
   */
  fx: 'none' | 'included' | 'computed_at_commit'
}

const BANK_ACCOUNT = '1930'
const AR_ACCOUNT = '1510'
const AP_ACCOUNT = '2440'
const ORE_ROUNDING_ACCOUNT = '3740'
const FX_LOSS_ACCOUNT = '7960'
const FX_GAIN_ACCOUNT = '3960'

/** `ORDER BY COALESCE(invoice_id, supplier_invoice_id, '')`: plain text order. */
function allocationSortKey(a: BatchAllocationPreviewAllocation): string {
  return a.invoice_id ?? a.supplier_invoice_id ?? ''
}

function usableRate(rate: number | null | undefined): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && rate < 100000
}

export function buildBatchAllocationPreview(input: {
  transaction: BatchAllocationPreviewTransaction
  allocations: readonly BatchAllocationPreviewAllocation[]
  /** Keyed by invoice id or supplier invoice id. */
  invoices: ReadonlyMap<string, BatchAllocationPreviewInvoice> | Record<string, BatchAllocationPreviewInvoice>
}): BatchAllocationPreview {
  const { transaction, allocations } = input
  if (allocations.length === 0) throw new Error('allocations must not be empty')
  const lookup = (id: string): BatchAllocationPreviewInvoice | undefined =>
    input.invoices instanceof Map ? input.invoices.get(id) : (input.invoices as Record<string, BatchAllocationPreviewInvoice>)[id]

  const isCustomer = allocations[0].kind === 'customer_invoice'
  if (allocations.some((a) => (a.kind === 'customer_invoice') !== isCustomer)) {
    throw new Error('allocations must all be of one kind')
  }
  const txAbs = Math.abs(transaction.amount)
  const totalAllocated = roundOre(allocations.reduce((sum, a) => sum + a.amount, 0))
  // The RPC refuses BATCH_AMOUNT_EXCEEDS_TX / BATCH_AMOUNT_BELOW_TX outside
  // this tolerance, so there is no verifikat to preview.
  if (Math.abs(totalAllocated - txAbs) > 0.005) {
    throw new Error(`allocations sum (${totalAllocated}) must equal the transaction amount (${txAbs})`)
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
    const invoice = lookup(allocationSortKey(alloc))
    const remaining = invoice?.remaining_amount ?? invoice?.total ?? null
    const sameCurrency = !invoice?.currency || invoice.currency === transaction.currency

    if (sameCurrency) {
      if (remaining === null) {
        settle(alloc.amount, label)
        return
      }
      const oreDiff = roundOre(remaining - alloc.amount)
      if (oreDiff !== 0 && Math.abs(oreDiff) < 1.0) {
        // Whole-krona settlement of an öre total: clear the full remaining and
        // let 3740 carry the residual. Customer short-paid = Dr 3740, over-paid
        // = Cr 3740; supplier is the mirror.
        settle(roundOre(remaining), label)
        const debitSide = isCustomer ? oreDiff > 0 : oreDiff < 0
        lines.push({
          account_number: ORE_ROUNDING_ACCOUNT,
          description: 'Öresavrundning',
          debit: debitSide ? Math.abs(oreDiff) : 0,
          credit: debitSide ? 0 : Math.abs(oreDiff),
        })
      } else {
        settle(alloc.amount, label)
      }
      return
    }

    // Cross-currency: the receivable/payable was booked at the invoice rate,
    // the bank settled in SEK; the difference is a kursvinst or kursförlust.
    const currencyLabel = `${label} (${invoice.currency})`
    if (remaining === null || !usableRate(invoice.exchange_rate)) {
      fx = 'computed_at_commit'
      settle(alloc.amount, currencyLabel)
      return
    }
    if (fx === 'none') fx = 'included'
    const bookedSek = roundOre(remaining * invoice.exchange_rate)
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

  lines.push(
    isCustomer
      ? { account_number: BANK_ACCOUNT, description: `Inbetalning ${entryDate}`, debit: txAbs, credit: 0 }
      : { account_number: BANK_ACCOUNT, description: `Utbetalning ${entryDate}`, debit: 0, credit: txAbs },
  )

  const debits = roundOre(lines.reduce((sum, l) => sum + l.debit, 0))
  const credits = roundOre(lines.reduce((sum, l) => sum + l.credit, 0))

  return {
    entry_date: entryDate,
    description: `${isCustomer ? 'Samlingsinbetalning' : 'Samlingsbetalning'} ${entryDate}`,
    lines,
    balanced: Math.abs(debits - credits) < 0.005,
    fx,
  }
}

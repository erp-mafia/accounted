import { createJournalEntry, findFiscalPeriod } from './engine'
import { resolveSekAmount, buildCurrencyMetadata } from './currency-utils'
import { resolveBookingAccount } from './accruals/account-suggestions'
import {
  generateReverseChargeLines,
  generateReverseChargeBasisLines,
  isReverseChargeBasisAccount,
  resolveReverseChargeRate,
} from './vat-entries'
import {
  coerceDimensionsBag,
  dimensionsBagKey,
  mergeDimensionBags,
  type LineDimensions,
} from './dimension-resolver'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  JournalEntry,
  SupplierInvoice,
  SupplierInvoiceItem,
} from '@/types'

const log = createLogger('supplier-invoice-entries')

/**
 * Build a BFL-compliant verifikation description with event type, counterparty, and suffix.
 * Falls back to prefix + invoiceNumber + suffix if name is not provided (backward compat).
 */
function buildSupplierDescription(
  prefix: string, invoiceNumber: string, supplierName?: string, suffix?: string
): string {
  const base = supplierName
    ? `${prefix} ${invoiceNumber}, ${supplierName}`
    : `${prefix} ${invoiceNumber}`
  return suffix ? `${base} ${suffix}` : base
}

/**
 * Aggregate item amounts per (booking account, merged dimensions bag):
 * dimensions PR7. The merged bag (item.dimensions over the invoice's
 * default_dimensions) is part of the aggregation identity so two items on the
 * same account but different tags stay on separate journal lines instead of
 * collapsing. Insertion order is first-seen, matching the old per-account map.
 */
interface ExpenseBucket {
  account: string
  dimensions?: LineDimensions
  amount: number
}

function groupExpenseBuckets(
  items: SupplierInvoiceItem[],
  resolveAccount: (item: SupplierInvoiceItem) => string,
  toSek: (item: SupplierInvoiceItem) => number,
  defaultDimensions?: LineDimensions
): ExpenseBucket[] {
  const buckets = new Map<string, ExpenseBucket>()
  for (const item of items) {
    const account = resolveAccount(item)
    const dimensions = mergeDimensionBags(defaultDimensions, item.dimensions)
    const key = `${account}\u0000${dimensionsBagKey(dimensions)}`
    const bucket = buckets.get(key) ?? { account, dimensions, amount: 0 }
    bucket.amount += toSek(item)
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
}

/**
 * Create journal entry when a supplier invoice is registered (accrual method)
 *
 * Swedish domestic (25% VAT):
 *   Debit  5xxx/6xxx (per item's account_number)   [item line_total]
 *   Debit  2641 Ingående moms (per rate)            [VAT per rate group]
 *   Credit 2440 Leverantörsskulder                  [total incl VAT]
 *
 * EU/non-EU reverse charge (services):
 *   Debit  5xxx/6xxx (per item)                     [total]
 *   Debit  2645 Beräknad ingående moms (per rate)   [fiktiv VAT per rate]
 *   Credit 26x4 Utgående moms omvänd (per rate)     [fiktiv VAT per rate]
 *   Credit 2440 Leverantörsskulder                  [total]
 *
 * Note: Goods imports via Tullverket (customs) use a different accounting path
 * (2615/2645) and are not handled here: only services use reverse charge.
 */
export async function createSupplierInvoiceRegistrationEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: SupplierInvoice,
  items: SupplierInvoiceItem[],
  supplierType: string,
  supplierName?: string
): Promise<JournalEntry | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, invoice.invoice_date)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for invoice date:', invoice.invoice_date)
    return null
  }

  const lines: CreateJournalEntryLineInput[] = []
  const desc = buildSupplierDescription('Leverantörsfaktura', invoice.supplier_invoice_number, supplierName, `(ankomstnr ${invoice.arrival_number})`)
  const isForeign = invoice.currency !== 'SEK'
  // Dimensions PR7: expense lines carry item bags merged over the invoice
  // default; every other line (VAT, RC/basis, 2440) carries the default only.
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)

  // Aggregate expense amounts by (account, dimensions) and convert to SEK.
  // Periodiserade lines book their net to the 17xx interim account instead
  // of the cost account (resolveBookingAccount); VAT and 2440 are untouched:
  // moms is never deferred (redovisas på fakturadatum).
  const expenseBuckets = groupExpenseBuckets(
    items,
    (item) => resolveBookingAccount('expense', item, item.account_number),
    (item) => resolveSekAmount(item.line_total, null, invoice.currency, invoice.exchange_rate),
    defaultDimensions
  )

  // Debit: Expense accounts (in SEK)
  const debitLines: CreateJournalEntryLineInput[] = []
  for (const bucket of expenseBuckets) {
    debitLines.push({
      account_number: bucket.account,
      debit_amount: Math.round(bucket.amount * 100) / 100,
      credit_amount: 0,
      line_description: desc,
      dimensions: bucket.dimensions,
    })
  }
  lines.push(...debitLines)

  const isReverseCharge = (supplierType === 'eu_business' || supplierType === 'non_eu_business' || supplierType === 'swedish_business') && invoice.reverse_charge
  const isDomesticRC = supplierType === 'swedish_business' && invoice.reverse_charge

  if (isReverseCharge) {
    // Reverse charge: fiktiv moms entries per rate group
    // Domestic (byggtjänster etc.): 2647/26x4, EU/non-EU: 2645/26x4
    //
    // Also generate basbeloppsrader on 44xx/45xx + motkonto 4598 so SKV's
    // momsdeklaration ruta 20-24 reflects the underlying purchase amount.
    // Without these the fiktiv moms (2614/2624/2634) populates ruta 30-32
    // but ruta 20-24 stay at 0, which Skatteverket rejects with felkod
    // FK004 ("silent netting prohibited"; ML 13 kap kräver båda sidor).
    //
    // The basis-account check is done per (rate, account) bucket: if the user
    // booked an item directly to a 44xx/45xx basis account at a given rate,
    // that item's belopp already populates ruta 20-24 via the expense line:
    // we only emit basbeloppsrader for the portion of that rate's base that
    // went to NON-basis accounts. Mixed invoices (4535 + 6540 at 25%) used to
    // skip basis lines entirely under a per-invoice flag, leaving ruta 30
    // larger than ruta 21 by the 6540 portion, the exact FK004 pattern.
    //
    // Drive iteration off the basis (line_total per rate), not stored
    // vat_amount: fiktiv moms is always statutory base × rate. This keeps
    // RC immune to per-line manual VAT overrides (which only make sense for
    // domestic deductible-VAT adjustments).
    const baseByRate = groupBaseByRate(items, invoice.currency, invoice.exchange_rate)
    const nonBasisBaseByRate = groupNonBasisBaseByRate(items, invoice.currency, invoice.exchange_rate)
    const rcSupplierType = supplierType as 'eu_business' | 'non_eu_business' | 'swedish_business'
    for (const [rate, baseAmount] of baseByRate) {
      if (rate > 0 && baseAmount > 0) {
        const rcLines = generateReverseChargeLines(baseAmount, rate, isDomesticRC)
        lines.push(...rcLines.map((l) => ({ ...l, dimensions: defaultDimensions })))
        const nonBasisBase = nonBasisBaseByRate.get(rate) || 0
        if (nonBasisBase > 0) {
          const basisLines = generateReverseChargeBasisLines(nonBasisBase, rate, rcSupplierType)
          lines.push(...basisLines.map((l) => ({ ...l, dimensions: defaultDimensions })))
        }
      }
    }
  } else if (invoice.vat_amount > 0) {
    // Domestic standard: Debit ingående moms per rate group
    const vatByRate = groupVatByRate(items, invoice.currency, invoice.exchange_rate)
    for (const [rate, amount] of vatByRate) {
      if (amount > 0) {
        lines.push({
          account_number: '2641',
          debit_amount: Math.round(amount * 100) / 100,
          credit_amount: 0,
          line_description: `Ingående moms ${Math.round(rate * 100)}% ${desc}`,
          dimensions: defaultDimensions,
        })
      }
    }
  }

  // Credit: Leverantörsskulder, balance guarantee: ensures sum(debits) === sum(credits)
  // For reverse charge, intermediate credits (2614/2624/2634) already exist, so we subtract them
  const totalDebits = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredits = lines.reduce((sum, l) => sum + l.credit_amount, 0)
  lines.push({
    account_number: '2440',
    debit_amount: 0,
    credit_amount: Math.round((totalDebits - totalCredits) * 100) / 100,
    line_description: desc,
    dimensions: defaultDimensions,
    ...buildCurrencyMetadata(invoice.currency, isForeign ? invoice.total : undefined, invoice.exchange_rate),
  })

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: invoice.invoice_date,
    description: desc,
    source_type: 'supplier_invoice_registered',
    source_id: invoice.id,
    lines,
  }

  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Create journal entry when a supplier invoice is paid (accrual method)
 *
 *   Debit  2440 Leverantörsskulder   [payment amount]
 *   Credit 1930 Företagskonto        [payment amount]
 *
 * With exchange rate difference:
 *   Debit  2440 Leverantörsskulder   [original SEK amount]
 *   Credit 1930 Företagskonto        [actual SEK paid]
 *   Credit/Debit 3960/7960           [difference]
 */
export async function createSupplierInvoicePaymentEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: SupplierInvoice,
  paymentAmount: number,
  paymentDate: string,
  exchangeRateDifference?: number,
  supplierName?: string,
  paymentAccount?: string
): Promise<JournalEntry | null> {
  const creditAccount = paymentAccount || '1930'
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, paymentDate)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for payment date:', paymentDate)
    return null
  }

  const desc = buildSupplierDescription('Utbetalning leverantörsfaktura', invoice.supplier_invoice_number, supplierName, `(ankomstnr ${invoice.arrival_number})`)
  const lines: CreateJournalEntryLineInput[] = []
  // Dimensions PR7: the payment voucher re-propagates the linked invoice's
  // default bag onto every leg (incl. FX result lines), see the stamp below.
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)

  if (exchangeRateDifference && exchangeRateDifference !== 0) {
    // Foreign currency with exchange rate difference
    const originalSekAmount = paymentAmount
    const actualSekPaid = paymentAmount - exchangeRateDifference

    // Debit: Clear leverantörsskulder at original booked SEK amount
    lines.push({
      account_number: '2440',
      debit_amount: Math.round(originalSekAmount * 100) / 100,
      credit_amount: 0,
      line_description: desc,
    })

    // Credit: Bank at actual SEK paid
    lines.push({
      account_number: creditAccount,
      debit_amount: 0,
      credit_amount: Math.round(actualSekPaid * 100) / 100,
      line_description: desc,
    })

    // Exchange rate difference
    if (exchangeRateDifference > 0) {
      // Gain: Credit 3960
      lines.push({
        account_number: '3960',
        debit_amount: 0,
        credit_amount: Math.round(Math.abs(exchangeRateDifference) * 100) / 100,
        line_description: 'Valutakursvinst',
      })
    } else {
      // Loss: Debit 7960
      lines.push({
        account_number: '7960',
        debit_amount: Math.round(Math.abs(exchangeRateDifference) * 100) / 100,
        credit_amount: 0,
        line_description: 'Valutakursförlust',
      })
    }
  } else {
    // Standard SEK payment
    lines.push({
      account_number: '2440',
      debit_amount: Math.round(paymentAmount * 100) / 100,
      credit_amount: 0,
      line_description: desc,
    })

    lines.push({
      account_number: creditAccount,
      debit_amount: 0,
      credit_amount: Math.round(paymentAmount * 100) / 100,
      line_description: desc,
    })
  }

  if (defaultDimensions) {
    // Copy per line: a shared bag object would let one line's mutation
    // leak into every other line (same contract as proposal stamping).
    for (const line of lines) line.dimensions = { ...defaultDimensions }
  }

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: paymentDate,
    description: desc,
    source_type: 'supplier_invoice_paid',
    source_id: invoice.id,
    lines,
  }

  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Create journal entry for cash method (kontantmetoden)
 * Combined entry at payment time:
 *
 *   Debit  5xxx/6xxx (per item)      [line_total]
 *   Debit  2641 Ingående moms        [total VAT]
 *   Credit 1930 Företagskonto        [total incl VAT]
 */
export async function createSupplierInvoiceCashEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: SupplierInvoice,
  items: SupplierInvoiceItem[],
  paymentDate: string,
  supplierType: string,
  supplierName?: string,
  paymentAccount?: string,
  // SEK that actually settled the invoice (the amount that left the bank). For
  // a foreign-currency invoice this pins the whole entry to the PAYMENT-date
  // rate, see the kontantmetoden note below. Omit for SEK invoices and the
  // behaviour is byte-identical to before.
  settledBankSek?: number
): Promise<JournalEntry | null> {
  const creditAccount = paymentAccount || '1930'
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, paymentDate)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for payment date:', paymentDate)
    return null
  }

  // Under kontantmetoden the booked affärshändelse IS the payment (BFL 5 kap:
  // "bokföring vid betalningstillfället"), so the entire verifikat is translated
  // at the PAYMENT-date rate (ÅRL 4 kap 6 §). There is no kursvinst/kursförlust
  // because no leverantörsskuld was ever carried at a historical rate: that
  // only happens under faktureringsmetoden (handled by the 2440-clearing path
  // with 7960/3960). When the caller passes the SEK that actually settled the
  // invoice, we derive the implied payment-date rate from it so the payment-
  // account credit equals the bank movement to the öre. For SEK invoices, or
  // when no settlement SEK is supplied, we keep the invoice's stored rate.
  const isForeign = invoice.currency !== 'SEK'
  const useSettlementRate =
    settledBankSek != null && settledBankSek > 0 && isForeign && invoice.total > 0
  const effectiveRate = useSettlementRate
    ? settledBankSek / invoice.total
    : invoice.exchange_rate

  const desc = buildSupplierDescription('Kontantbetalning leverantörsfaktura', invoice.supplier_invoice_number, supplierName)
  const lines: CreateJournalEntryLineInput[] = []
  // Dimensions PR7: kontantmetoden books the expense at payment, same merge
  // rules as the registration entry.
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)
  // Expense debit lines tracked separately so a sub-öre translation residual
  // can be folded into the largest one (öresavrundning step below).
  const expenseLines: CreateJournalEntryLineInput[] = []

  // Aggregate expense amounts by (account, dimensions) and convert to SEK
  const expenseBuckets = groupExpenseBuckets(
    items,
    (item) => item.account_number,
    (item) => resolveSekAmount(item.line_total, null, invoice.currency, effectiveRate),
    defaultDimensions
  )

  // Debit: Expense accounts (in SEK)
  for (const bucket of expenseBuckets) {
    const line: CreateJournalEntryLineInput = {
      account_number: bucket.account,
      debit_amount: Math.round(bucket.amount * 100) / 100,
      credit_amount: 0,
      line_description: desc,
      dimensions: bucket.dimensions,
    }
    lines.push(line)
    expenseLines.push(line)
  }

  const isReverseCharge = (supplierType === 'eu_business' || supplierType === 'non_eu_business' || supplierType === 'swedish_business') && invoice.reverse_charge
  const isDomesticRC = supplierType === 'swedish_business' && invoice.reverse_charge

  if (isReverseCharge) {
    // Reverse charge: fiktiv moms entries per rate group
    // Domestic (byggtjänster etc.): 2647/26x4, EU/non-EU: 2645/26x4
    //
    // Also generate basbeloppsrader on 44xx/45xx + motkonto 4598 so SKV's
    // momsdeklaration ruta 20-24 reflects the underlying purchase amount.
    // Without these the fiktiv moms (2614/2624/2634) populates ruta 30-32
    // but ruta 20-24 stay at 0, which Skatteverket rejects with felkod
    // FK004 ("silent netting prohibited"; ML 13 kap kräver båda sidor).
    // Per-rate bucketing: see registration entry above for the FK004 rationale.
    // Drive iteration off the basis (line_total per rate): fiktiv moms is
    // always statutory base × rate; manual vat_amount overrides don't apply.
    // effectiveRate (payment-date rate under kontantmetoden) keeps the fiktiv
    // moms base consistent with the expense lines above.
    const baseByRate = groupBaseByRate(items, invoice.currency, effectiveRate)
    const nonBasisBaseByRate = groupNonBasisBaseByRate(items, invoice.currency, effectiveRate)
    const rcSupplierType = supplierType as 'eu_business' | 'non_eu_business' | 'swedish_business'
    for (const [rate, baseAmount] of baseByRate) {
      if (rate > 0 && baseAmount > 0) {
        const rcLines = generateReverseChargeLines(baseAmount, rate, isDomesticRC)
        lines.push(...rcLines.map((l) => ({ ...l, dimensions: defaultDimensions })))
        const nonBasisBase = nonBasisBaseByRate.get(rate) || 0
        if (nonBasisBase > 0) {
          const basisLines = generateReverseChargeBasisLines(nonBasisBase, rate, rcSupplierType)
          lines.push(...basisLines.map((l) => ({ ...l, dimensions: defaultDimensions })))
        }
      }
    }
  } else if (invoice.vat_amount > 0) {
    // Domestic standard: Debit ingående moms per rate group (at the payment-
    // date rate when settling a foreign invoice, see effectiveRate above).
    const vatByRate = groupVatByRate(items, invoice.currency, effectiveRate)
    for (const [rate, amount] of vatByRate) {
      if (amount > 0) {
        lines.push({
          account_number: '2641',
          debit_amount: Math.round(amount * 100) / 100,
          credit_amount: 0,
          line_description: `Ingående moms ${Math.round(rate * 100)}% ${desc}`,
          dimensions: defaultDimensions,
        })
      }
    }
  }

  // Öresavrundning: when translating a foreign invoice at the payment-date
  // rate, per-line rounding can drift the implied bank total by an öre or two.
  // Fold that residual into the largest expense line so the payment-account
  // credit lands exactly on the SEK that left the bank (1930 reconciles to the
  // bank transaction). Immaterial to the momsdeklaration: rutor are whole
  // kronor. The |residual| ≤ 1 guard ensures we only absorb rounding noise,
  // never a real shortfall (a partial settlement is blocked upstream).
  if (useSettlementRate && expenseLines.length > 0) {
    const debitSum = lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const creditSum = lines.reduce((sum, l) => sum + l.credit_amount, 0)
    const provisionalCredit = roundOre(debitSum - creditSum)
    const residual = roundOre(settledBankSek! - provisionalCredit)
    if (residual !== 0 && Math.abs(residual) <= 1) {
      const target = expenseLines.reduce((a, b) => (b.debit_amount >= a.debit_amount ? b : a))
      target.debit_amount = roundOre(target.debit_amount + residual)
    }
  }

  // Credit: payment account, balance guarantee: ensures sum(debits) === sum(credits)
  // For reverse charge, intermediate credits (2614/2624/2634) already exist, so we subtract them
  const totalDebits = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredits = lines.reduce((sum, l) => sum + l.credit_amount, 0)
  lines.push({
    account_number: creditAccount,
    debit_amount: 0,
    credit_amount: Math.round((totalDebits - totalCredits) * 100) / 100,
    line_description: desc,
    dimensions: defaultDimensions,
  })

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: paymentDate,
    description: desc,
    source_type: 'supplier_invoice_cash_payment',
    source_id: invoice.id,
    lines,
  }

  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Create journal entry for an invoice paid with the owner's private funds
 * (eget utlägg). The AP leg is bypassed entirely: instead of crediting 2440
 * and later debiting it on mark-paid, the expense lines book straight against
 * the owner's payable/equity account:
 *
 *   Debit  5xxx/6xxx (per item)      [line_total in SEK]
 *   Debit  2641 Ingående moms        [VAT per rate]
 *   Credit 2893 / 2018               [total incl VAT]
 *
 * Reverse charge is intentionally not supported here. RC invoices are
 * never "I paid this cash at a kiosk" cases: they're EU/byggtjänster from
 * registered businesses with formal invoices, which always go through AP.
 * The API route guards against this combo before calling us.
 */
export async function createSupplierInvoicePrivatelyPaidEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: SupplierInvoice,
  items: SupplierInvoiceItem[],
  entityType: 'aktiebolag' | 'enskild_firma',
  supplierName?: string
): Promise<JournalEntry | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, invoice.invoice_date)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for invoice date:', invoice.invoice_date)
    return null
  }

  const ownerAccount = entityType === 'aktiebolag' ? '2893' : '2018'
  const desc = buildSupplierDescription('Eget utlägg', invoice.supplier_invoice_number, supplierName, `(ankomstnr ${invoice.arrival_number})`)
  const lines: CreateJournalEntryLineInput[] = []
  // Dimensions PR7: this IS the utlägg path, billable-expense-to-project
  // tagging rides the same merge rules as the registration entry.
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)

  // Debit: Expense accounts (in SEK), aggregated per (account, dimensions)
  const expenseBuckets = groupExpenseBuckets(
    items,
    (item) => item.account_number,
    (item) => resolveSekAmount(item.line_total, null, invoice.currency, invoice.exchange_rate),
    defaultDimensions
  )
  for (const bucket of expenseBuckets) {
    lines.push({
      account_number: bucket.account,
      debit_amount: Math.round(bucket.amount * 100) / 100,
      credit_amount: 0,
      line_description: desc,
      dimensions: bucket.dimensions,
    })
  }

  // Debit: Ingående moms per rate group (mixed-rate kvitto support)
  if (invoice.vat_amount > 0) {
    const vatByRate = groupVatByRate(items, invoice.currency, invoice.exchange_rate)
    for (const [rate, amount] of vatByRate) {
      if (amount > 0) {
        lines.push({
          account_number: '2641',
          debit_amount: Math.round(amount * 100) / 100,
          credit_amount: 0,
          line_description: `Ingående moms ${Math.round(rate * 100)}% ${desc}`,
          dimensions: defaultDimensions,
        })
      }
    }
  }

  // Credit: Owner payable/equity, balance guarantee
  const totalDebits = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  lines.push({
    account_number: ownerAccount,
    debit_amount: 0,
    credit_amount: Math.round(totalDebits * 100) / 100,
    line_description: desc,
    dimensions: defaultDimensions,
  })

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: invoice.invoice_date,
    description: desc,
    source_type: 'supplier_invoice_privately_paid',
    source_id: invoice.id,
    lines,
  }

  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Create journal entry for a supplier credit note (reversal of registration)
 *
 *   Debit  2440 Leverantörsskulder                 [total]
 *   Credit 5xxx/6xxx (per item)                    [line_total]
 *   Credit 2641 Ingående moms                      [total VAT]
 */
export async function createSupplierCreditNoteEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  creditNote: SupplierInvoice,
  items: SupplierInvoiceItem[],
  supplierType: string,
  supplierName?: string
): Promise<JournalEntry | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, creditNote.invoice_date)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for credit note date:', creditNote.invoice_date)
    return null
  }

  const desc = buildSupplierDescription('Kreditfaktura leverantör', creditNote.supplier_invoice_number, supplierName, `(ankomstnr ${creditNote.arrival_number})`)
  const lines: CreateJournalEntryLineInput[] = []
  // Dimensions PR7: items are the ORIGINAL invoice's (see below), so their
  // bags reverse against the same dimension cells; the credit note's own
  // default (copied from the original at credit time) rides the other legs.
  const defaultDimensions = coerceDimensionsBag(creditNote.default_dimensions)

  // Credit: Expense accounts (reverse, in SEK). The caller passes the
  // ORIGINAL invoice's items so deferred lines reverse against the same 17xx
  // interim account they were registered on (the schedule's posted
  // dissolutions are stornoed separately by cancelSchedulesForSource).
  const creditLines: CreateJournalEntryLineInput[] = []
  const expenseBuckets = groupExpenseBuckets(
    items,
    (item) => resolveBookingAccount('expense', item, item.account_number),
    (item) => Math.abs(resolveSekAmount(item.line_total, null, creditNote.currency, creditNote.exchange_rate)),
    defaultDimensions
  )

  for (const bucket of expenseBuckets) {
    creditLines.push({
      account_number: bucket.account,
      debit_amount: 0,
      credit_amount: Math.round(bucket.amount * 100) / 100,
      line_description: desc,
      dimensions: bucket.dimensions,
    })
  }

  const isReverseCharge = (supplierType === 'eu_business' || supplierType === 'non_eu_business' || supplierType === 'swedish_business') && creditNote.reverse_charge
  const isDomesticRC = supplierType === 'swedish_business' && creditNote.reverse_charge

  if (isReverseCharge) {
    // Reverse the fiktiv moms per rate group (swap debit/credit from registration)
    // Input VAT account: 2647 for domestic RC, 2645 for EU/non-EU
    // Drive iteration off the basis: fiktiv moms is always statutory base × rate.
    const inputAccount = isDomesticRC ? '2647' : '2645'
    const baseByRate = groupBaseByRate(items, creditNote.currency, creditNote.exchange_rate, true)
    const nonBasisBaseByRate = groupNonBasisBaseByRate(items, creditNote.currency, creditNote.exchange_rate, true)
    const rcSupplierType = supplierType as 'eu_business' | 'non_eu_business' | 'swedish_business'
    // Only reverse basbeloppsraderna for the portion the registration would
    // have emitted them, namely the non-basis-account base per rate. Items
    // booked directly to 44xx/45xx had no parallel basis lines in registration
    // and so are reversed only via the expense credit line above.
    for (const [rate, baseAmount] of baseByRate) {
      if (rate > 0 && baseAmount > 0) {
        const fiktivVat = Math.round(baseAmount * rate * 100) / 100
        // Determine the output account for this rate
        let outputAccount: string
        switch (rate) {
          case 0.12: outputAccount = '2624'; break
          case 0.06: outputAccount = '2634'; break
          default: outputAccount = '2614'; break
        }
        creditLines.push({
          account_number: inputAccount,
          debit_amount: 0,
          credit_amount: fiktivVat,
          line_description: `Omvänd fiktiv ingående moms ${Math.round(rate * 100)}% ${desc}`,
          dimensions: defaultDimensions,
        })
        lines.push({
          account_number: outputAccount,
          debit_amount: fiktivVat,
          credit_amount: 0,
          line_description: `Omvänd fiktiv utgående moms ${Math.round(rate * 100)}% ${desc}`,
          dimensions: defaultDimensions,
        })
        const nonBasisBase = nonBasisBaseByRate.get(rate) || 0
        if (nonBasisBase > 0) {
          // Reverse the basbeloppsrader (44xx/45xx debit & 4598 credit on the
          // registration entry become credits & debits here). Without this the
          // credit note would only undo the VAT amounts (ruta 30-32 + 48) but
          // leave ruta 20-24 still showing the original basbelopp, exactly
          // the same FK004-style mismatch the registration fix prevents.
          const basisLines = generateReverseChargeBasisLines(nonBasisBase, rate, rcSupplierType)
          // Swap debit/credit on every basis line so the credit note nets
          // against the original registration verifikat.
          for (const line of basisLines) {
            lines.push({
              account_number: line.account_number,
              debit_amount: line.credit_amount,
              credit_amount: line.debit_amount,
              line_description: line.line_description,
              dimensions: defaultDimensions,
            })
          }
        }
      }
    }
  } else {
    // Domestic: Credit ingående moms per rate group (reverse)
    const vatByRate = groupVatByRate(items, creditNote.currency, creditNote.exchange_rate, true)
    for (const [rate, amount] of vatByRate) {
      if (amount > 0) {
        creditLines.push({
          account_number: '2641',
          debit_amount: 0,
          credit_amount: amount,
          line_description: `Ingående moms ${Math.round(rate * 100)}% ${desc}`,
          dimensions: defaultDimensions,
        })
      }
    }
  }

  lines.push(...creditLines)

  // Debit: Leverantörsskulder, balance guarantee: debit = sum of credits minus other debits
  const totalCredits = lines.reduce((sum, l) => sum + l.credit_amount, 0)
  const totalDebits = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  lines.unshift({
    account_number: '2440',
    debit_amount: Math.round((totalCredits - totalDebits) * 100) / 100,
    credit_amount: 0,
    line_description: desc,
    dimensions: defaultDimensions,
  })

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: creditNote.invoice_date,
    description: desc,
    source_type: 'supplier_credit_note',
    source_id: creditNote.id,
    lines,
  }

  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Group items by VAT rate and sum the stored VAT amount per rate.
 * Returns a Map<rate, totalVatAmount> in SEK for per-rate 2641 journal lines.
 *
 * Reads `item.vat_amount` directly: set by the API from the line's manual
 * override when present, else computed line_total × rate. This is the path
 * for partial-deductible cases (bilförmån 50%, representation 300 kr-tak),
 * foreign-currency rounding, and supplier POS rounding.
 *
 * Fallback to line_total × rate when vat_amount is null/0 but rate > 0:
 * legacy import paths (SIE, CSV, demo seed) sometimes leave vat_amount at
 * the column DEFAULT of 0. Silently dropping input VAT to 2641 would
 * understate ruta 48 in the momsdeklaration.
 *
 * Reverse-charge fiktiv moms doesn't use this: see groupBaseByRate, which
 * derives the basis directly so fiktiv VAT is always base × statutory rate.
 */
function groupVatByRate(
  items: SupplierInvoiceItem[],
  currency: string,
  exchangeRate: number | null,
  useAbsoluteValues = false
): Map<number, number> {
  const vatByRate = new Map<number, number>()
  for (const item of items) {
    const rate = item.vat_rate ?? 0.25
    const storedVat = item.vat_amount ?? 0
    const computedVat = rate > 0
      ? Math.round((item.line_total ?? 0) * rate * 100) / 100
      : 0
    const sourceVat = storedVat > 0 ? storedVat : computedVat
    let vatSek = resolveSekAmount(sourceVat, null, currency, exchangeRate)
    if (useAbsoluteValues) vatSek = Math.abs(vatSek)
    vatByRate.set(rate, (vatByRate.get(rate) || 0) + vatSek)
  }
  return vatByRate
}

/**
 * Group items by their self-assessed reverse-charge rate and sum the base
 * (line_total) per rate. Used by reverse-charge paths to compute fiktiv moms
 * from the basis, decoupled from any manual VAT override on the items.
 *
 * The grouping key is the *self-assessed* rate (resolveReverseChargeRate), not
 * the line's vat_rate: under omvänd skattskyldighet the supplier charges 0%, so
 * the line vat_rate is 0, but the buyer self-assesses at 25% (huvudregeln) or
 * the explicit per-item reverse_charge_rate. Without this a 0%-rate RC line
 * would key on rate 0 and the `rate > 0` guard below would skip its VAT lines.
 */
function groupBaseByRate(
  items: SupplierInvoiceItem[],
  currency: string,
  exchangeRate: number | null,
  useAbsoluteValues = false
): Map<number, number> {
  const baseByRate = new Map<number, number>()
  for (const item of items) {
    const rate = resolveReverseChargeRate(item)
    let baseSek = resolveSekAmount(item.line_total, null, currency, exchangeRate)
    if (useAbsoluteValues) baseSek = Math.abs(baseSek)
    baseByRate.set(rate, (baseByRate.get(rate) || 0) + baseSek)
  }
  return baseByRate
}

/**
 * Sum, per VAT rate, the base (line_total in SEK) of items booked to
 * non-basis expense accounts. Items already booked to a 44xx/45xx basis
 * account populate ruta 20-24 directly via the expense line, so they must be
 * excluded here to avoid double-counting in basbeloppsraderna.
 */
function groupNonBasisBaseByRate(
  items: SupplierInvoiceItem[],
  currency: string,
  exchangeRate: number | null,
  useAbsoluteValues = false
): Map<number, number> {
  const baseByRate = new Map<number, number>()
  for (const item of items) {
    if (isReverseChargeBasisAccount(item.account_number)) continue
    const rate = resolveReverseChargeRate(item)
    let itemSek = resolveSekAmount(item.line_total, null, currency, exchangeRate)
    if (useAbsoluteValues) itemSek = Math.abs(itemSek)
    baseByRate.set(rate, (baseByRate.get(rate) || 0) + itemSek)
  }
  return baseByRate
}

/**
 * Invoice-match intercept for categorizing a bank transaction ("Prong B").
 *
 * Categorizing a supplier payment straight onto leverantörsskulder (244x), or
 * an inbound payment straight onto kundfordringar (151x), while an open
 * invoice already covers the amount leaves that invoice unpaid and lures the
 * user into a second verifikat for the same affärshändelse later ("Markera
 * som betald"). The intercept refuses the plain categorization and names the
 * candidate invoices, so the caller matches the payment to the invoice
 * instead; `confirm_no_match: true` keeps the plain categorization.
 *
 * Shared by every categorize door that books from a resolved mapping (the
 * dashboard route POST /api/transactions/{id}/categorize and the v1
 * :categorize / batch-categorize routes) so they refuse the same bookings
 * with the same code (TX_CATEGORIZE_SUGGEST_SI_MATCH /
 * TX_CATEGORIZE_SUGGEST_CI_MATCH) and honour the same override. Read-only:
 * safe on a dry-run.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DUPLICATE_AMOUNT_TOLERANCE_PCT,
  DUPLICATE_DATE_WINDOW_DAYS,
  escapeLikePattern,
  normalizeOcrReference,
} from '@/lib/invoices/duplicate-payment-guard'
import { matchesNormalizedReference } from '@/lib/invoices/ocr-keys'
import {
  invoiceAmountSek,
  magnitudesWithinTolerance,
  normalizeCurrencyCode,
  planAmountSweeps,
  type ComparableAmount,
} from '@/lib/invoices/duplicate-guard-currency'
import { resolveTransactionAmountSek } from '@/lib/transactions/booking-duplicate-detection'
import type { Logger } from '@/lib/logger'

/** The `transactions` columns the intercept reads. */
export interface InvoiceMatchTransaction {
  date: string
  /** `transactions.amount`, denominated in `currency`: NOT necessarily SEK. */
  amount: number
  currency: string | null
  amount_sek?: number | null
  exchange_rate?: number | null
  merchant_name?: string | null
  description?: string | null
  reference?: string | null
}

export interface InvoiceMatchSuggestionInput {
  transaction: InvoiceMatchTransaction
  /** The resolved mapping's debit account (string, BAS). */
  debitAccount: string
  /** The resolved mapping's credit account (string, BAS). */
  creditAccount: string
  isBusiness: boolean
  /** The caller confirmed the plain categorization: skip the intercept. */
  confirmNoMatch?: boolean
}

export interface SupplierInvoiceMatchCandidate {
  supplier_invoice_id: string
  invoice_number: string | null
  invoice_date: string
  remaining_amount: number | null
  currency: string | null
  supplier_name: string | null
}

export interface CustomerInvoiceMatchCandidate {
  invoice_id: string
  invoice_number: string | null
  invoice_date: string
  remaining_amount: number | null
  currency: string | null
  customer_name: string | null
  match_reason: 'ocr_exact' | 'name_amount_fuzzy'
}

export type InvoiceMatchSuggestion =
  | {
      code: 'TX_CATEGORIZE_SUGGEST_SI_MATCH'
      details: { candidates: SupplierInvoiceMatchCandidate[] }
    }
  | {
      code: 'TX_CATEGORIZE_SUGGEST_CI_MATCH'
      details: { candidates: CustomerInvoiceMatchCandidate[] }
    }

/**
 * Returns the suggestion the caller must refuse with (the structured-error
 * code plus its `details`), or null when the categorization may proceed.
 */
export async function findInvoiceMatchSuggestion(
  supabase: SupabaseClient,
  companyId: string,
  input: InvoiceMatchSuggestionInput,
  log: Logger,
): Promise<InvoiceMatchSuggestion | null> {
  const { transaction, debitAccount, creditAccount, isBusiness, confirmNoMatch } = input

  if (confirmNoMatch && /^244\d$/.test(debitAccount)) {
    log.warn('supplier-invoice match suggestion bypassed', {
      reason: 'confirm_no_match=true',
      debitAccount,
      creditAccount,
    })
  }
  if (confirmNoMatch && /^151\d$/.test(creditAccount)) {
    log.warn('customer-invoice match suggestion bypassed', {
      reason: 'confirm_no_match=true',
      debitAccount,
      creditAccount,
    })
  }

  // Units for both invoice-suggestion prongs below. `transactions.amount` is
  // denominated in `transactions.currency`, while `remaining_amount` on
  // `supplier_invoices` / `invoices` is denominated in the INVOICE's
  // currency. A plus-minus 2 % band built around a EUR bank row and applied
  // to a kronor `remaining_amount` column is off by the whole exchange rate:
  // it either matches nothing or points the user at an unrelated invoice.
  // `planAmountSweeps` therefore issues one SQL sweep per currency (band and
  // column in the same unit) and `magnitudesWithinTolerance` re-checks every
  // returned row. A SEK transaction yields exactly one sweep with the band it
  // had before, so a SEK-only company runs the identical single query.
  const txReferenceAmount: ComparableAmount = {
    amount: transaction.amount,
    currency: normalizeCurrencyCode(transaction.currency),
    sek: resolveTransactionAmountSek({
      amount: transaction.amount,
      currency: transaction.currency,
      amount_sek: transaction.amount_sek,
      exchange_rate: transaction.exchange_rate,
    }),
  }

  /** A candidate invoice row as a comparable amount (pro-rates `total_sek`). */
  const invoiceRowAmount = (row: {
    remaining_amount: number | null
    total?: number | null
    currency: string | null
    total_sek?: number | null
    exchange_rate?: number | null
  }): ComparableAmount => {
    const remaining = row.remaining_amount ?? row.total ?? 0
    const currency = normalizeCurrencyCode(row.currency)
    return {
      amount: Number(remaining),
      currency,
      sek: invoiceAmountSek({
        amount: Number(remaining),
        currency,
        total: row.total,
        totalSek: row.total_sek,
        exchangeRate: row.exchange_rate,
      }),
    }
  }

  // Supplier side: intercept plain 244x categorization of supplier payments
  // when an open supplier invoice already covers this amount. Categorizing
  // direct to 244x leaves the invoice with status='approved' and lures the
  // user into a duplicate "Markera som betald" later. Credit must be a
  // bank/cash account (1xxx): 244x against a clearing account, equity, etc.
  // isn't a supplier payment and the suggestion would misdirect the user.
  if (
    !confirmNoMatch &&
    isBusiness &&
    transaction.amount < 0 &&
    /^244\d$/.test(debitAccount) &&
    /^1\d{3}$/.test(creditAccount)
  ) {
    const { sweeps, crossCurrencyUnverifiable } = planAmountSweeps(
      txReferenceAmount,
      DUPLICATE_AMOUNT_TOLERANCE_PCT,
    )
    if (crossCurrencyUnverifiable) {
      // A foreign bank row with neither amount_sek nor exchange_rate cannot
      // be stated in kronor, so kronor invoices are excluded rather than
      // compared raw. Logged: an unevaluated candidate set is not the same
      // thing as "no open invoice matches".
      log.warn('supplier-invoice suggestion: cross-currency candidates not evaluated', {
        reason: 'transaction_missing_sek_value',
        currency: txReferenceAmount.currency,
      })
    }

    let supplierIds: string[] = []
    if (transaction.merchant_name) {
      const escapedMerchant = escapeLikePattern(transaction.merchant_name)
      const { data: matchedSuppliers } = await supabase
        .from('suppliers')
        .select('id')
        .eq('company_id', companyId)
        .ilike('name', `%${escapedMerchant}%`)
        .limit(10)
      supplierIds = ((matchedSuppliers || []) as Array<{ id: string }>).map((s) => s.id)
    }

    if (supplierIds.length > 0) {
      // Restrict candidates to invoices within the date window relative to
      // the bank tx date. Without this, an open invoice from years back can
      // surface as a match and misdirect the user (swedish-compliance bot).
      const txDateMs = new Date(transaction.date).getTime()
      const invoiceDateLow = new Date(txDateMs - DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
        .toISOString()
        .split('T')[0]
      const invoiceDateHigh = new Date(txDateMs + DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
        .toISOString()
        .split('T')[0]

      type SupplierCandidateRow = {
        id: string
        supplier_invoice_number: string | null
        invoice_date: string
        remaining_amount: number | null
        total: number | null
        currency: string | null
        total_sek: number | null
        exchange_rate: number | null
        supplier: { name?: string } | null
      }

      const sweepResults = await Promise.all(
        sweeps.map((sweep) =>
          supabase
            .from('supplier_invoices')
            .select(
              'id, supplier_invoice_number, invoice_date, remaining_amount, total, currency, total_sek, exchange_rate, supplier:suppliers(name)',
            )
            .eq('company_id', companyId)
            .in('supplier_id', supplierIds)
            .in('status', ['registered', 'approved', 'partially_paid', 'overdue'])
            .or(sweep.currencyFilter)
            .gte('remaining_amount', sweep.low)
            .lte('remaining_amount', sweep.high)
            .gte('invoice_date', invoiceDateLow)
            .lte('invoice_date', invoiceDateHigh)
            .order('invoice_date', { ascending: false })
            .limit(5),
        ),
      )

      const byId = new Map<string, SupplierCandidateRow>()
      for (const res of sweepResults) {
        for (const row of (res.data ?? []) as unknown as SupplierCandidateRow[]) {
          if (!byId.has(row.id)) byId.set(row.id, row)
        }
      }
      const openInvoices = Array.from(byId.values())
        .filter((inv) =>
          magnitudesWithinTolerance(
            txReferenceAmount,
            invoiceRowAmount(inv),
            DUPLICATE_AMOUNT_TOLERANCE_PCT,
          ),
        )
        .sort((a, b) => (a.invoice_date < b.invoice_date ? 1 : a.invoice_date > b.invoice_date ? -1 : 0))
        .slice(0, 5)

      if (openInvoices.length > 0) {
        return {
          code: 'TX_CATEGORIZE_SUGGEST_SI_MATCH',
          details: {
            candidates: openInvoices.map((inv) => ({
              supplier_invoice_id: inv.id,
              invoice_number: inv.supplier_invoice_number,
              invoice_date: inv.invoice_date,
              remaining_amount: inv.remaining_amount,
              currency: inv.currency,
              supplier_name: (inv.supplier as { name?: string } | null)?.name ?? null,
            })),
          },
        }
      }
    }
  }

  // Customer side: intercept plain 151x categorization of an inbound payment
  // when an unpaid customer invoice already covers this amount. Symmetric
  // with the supplier-side intercept above. The debit must be a bank/cash
  // account (^19\d{2}$, BAS class 19): a 1xxx debit outside class 19 isn't a
  // payment receipt and the suggestion would misdirect the user.
  if (
    !confirmNoMatch &&
    isBusiness &&
    transaction.amount > 0 &&
    /^19\d{2}$/.test(debitAccount) &&
    /^151\d$/.test(creditAccount)
  ) {
    const { sweeps, crossCurrencyUnverifiable } = planAmountSweeps(
      txReferenceAmount,
      DUPLICATE_AMOUNT_TOLERANCE_PCT,
    )
    if (crossCurrencyUnverifiable) {
      log.warn('customer-invoice suggestion: cross-currency candidates not evaluated', {
        reason: 'transaction_missing_sek_value',
        currency: txReferenceAmount.currency,
      })
    }

    // Resolve candidate customer(s) by name. Inbound bank txs are typically
    // described by payer name in EITHER merchant_name OR description, so
    // search both. OCR-direct lookup is below.
    let customerIds: string[] = []
    const searchTerms: string[] = []
    if (transaction.merchant_name) searchTerms.push(transaction.merchant_name)
    if (transaction.description) searchTerms.push(transaction.description)
    const collected = new Set<string>()
    for (const term of searchTerms) {
      const escaped = escapeLikePattern(term)
      const { data: matched } = await supabase
        .from('customers')
        .select('id')
        .eq('company_id', companyId)
        .ilike('name', `%${escaped}%`)
        .limit(10)
      for (const c of (matched ?? []) as Array<{ id: string }>) collected.add(c.id)
    }
    customerIds = Array.from(collected)

    // Date window anchored on `due_date`, NOT `invoice_date`. Customer
    // payments arrive close to (or after) the due date; for an invoice
    // with 60-90 day terms, anchoring on invoice_date would push the
    // expected payment outside a ±60-day window and the guard would miss
    // genuine matches. due_date is the better proxy for "around when the
    // payment is expected."
    const txDateMs = new Date(transaction.date).getTime()
    const dueDateLow = new Date(txDateMs - DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
      .toISOString()
      .split('T')[0]
    const dueDateHigh = new Date(txDateMs + DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
      .toISOString()
      .split('T')[0]

    type CandidateRow = {
      id: string
      invoice_number: string | null
      invoice_date: string
      due_date: string | null
      remaining_amount: number | null
      total: number
      currency: string | null
      total_sek: number | null
      exchange_rate: number | null
      customer: { name?: string } | null
    }
    const CANDIDATE_COLUMNS =
      'id, invoice_number, invoice_date, due_date, remaining_amount, total, currency, total_sek, exchange_rate, customer:customers(name)'
    const openInvoiceCandidates: CandidateRow[] = []
    /** Same-unit re-check: drops any row the SQL sweep let through. */
    const comparable = (row: CandidateRow) =>
      magnitudesWithinTolerance(
        txReferenceAmount,
        invoiceRowAmount(row),
        DUPLICATE_AMOUNT_TOLERANCE_PCT,
      )

    if (customerIds.length > 0) {
      const sweepResults = await Promise.all(
        sweeps.map((sweep) =>
          supabase
            .from('invoices')
            .select(CANDIDATE_COLUMNS)
            .eq('company_id', companyId)
            .in('customer_id', customerIds)
            .in('status', ['sent', 'overdue', 'partially_paid'])
            .or(sweep.currencyFilter)
            .gte('remaining_amount', sweep.low)
            .lte('remaining_amount', sweep.high)
            .gte('due_date', dueDateLow)
            .lte('due_date', dueDateHigh)
            .order('due_date', { ascending: false })
            .limit(5),
        ),
      )
      for (const res of sweepResults) {
        for (const row of (res.data ?? []) as unknown as CandidateRow[]) {
          if (!comparable(row)) continue
          if (!openInvoiceCandidates.some((existing) => existing.id === row.id)) {
            openInvoiceCandidates.push(row)
          }
        }
      }
    }

    // OCR pass: if the bank-tx reference matches an open invoice's reference
    // keys (its invoice_number, or the OCR the invoice printed: same digits
    // plus a Luhn check digit), surface it regardless of customer-name
    // match. This catches the common case where the bank populated
    // `reference` but neither merchant_name nor description carried the
    // customer name.
    const normalizedTxRef = normalizeOcrReference(transaction.reference ?? null)
    if (normalizedTxRef) {
      const refSweepResults = await Promise.all(
        sweeps.map((sweep) =>
          supabase
            .from('invoices')
            .select(CANDIDATE_COLUMNS)
            .eq('company_id', companyId)
            .in('status', ['sent', 'overdue', 'partially_paid'])
            .or(sweep.currencyFilter)
            .gte('remaining_amount', sweep.low)
            .lte('remaining_amount', sweep.high)
            .gte('due_date', dueDateLow)
            .lte('due_date', dueDateHigh)
            .order('due_date', { ascending: false })
            .limit(20),
        ),
      )
      for (const res of refSweepResults) {
        for (const row of (res.data ?? []) as unknown as CandidateRow[]) {
          if (!matchesNormalizedReference(row.invoice_number, normalizedTxRef)) continue
          if (!comparable(row)) continue
          if (!openInvoiceCandidates.some((existing) => existing.id === row.id)) {
            openInvoiceCandidates.unshift(row)
          }
        }
      }
    }

    if (openInvoiceCandidates.length > 0) {
      return {
        code: 'TX_CATEGORIZE_SUGGEST_CI_MATCH',
        details: {
          candidates: openInvoiceCandidates.slice(0, 5).map((inv) => {
            const reasonOcr = matchesNormalizedReference(inv.invoice_number, normalizedTxRef)
            return {
              invoice_id: inv.id,
              invoice_number: inv.invoice_number,
              invoice_date: inv.invoice_date,
              remaining_amount: inv.remaining_amount ?? inv.total,
              currency: inv.currency,
              customer_name: inv.customer?.name ?? null,
              match_reason: reasonOcr ? ('ocr_exact' as const) : ('name_amount_fuzzy' as const),
            }
          }),
        },
      }
    }
  }

  return null
}

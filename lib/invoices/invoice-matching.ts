import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice, Transaction, Customer } from '@/types'

export interface InvoiceMatch {
  invoice: Invoice & { customer?: Customer }
  confidence: number
  matchReason: string
}

/**
 * Confidence thresholds for invoice matching
 */
const CONFIDENCE = {
  OCR_REFERENCE_MATCH: 0.99,
  EXACT_AMOUNT_CUSTOMER: 0.95,
  EXACT_AMOUNT_ONLY: 0.80,
  FUZZY_AMOUNT_CUSTOMER: 0.70,
  FUZZY_AMOUNT_ONLY: 0.50,
  MIN_THRESHOLD: 0.50,
}

/**
 * Fuzzy amount tolerance (±1% for FX fees)
 */
const FUZZY_TOLERANCE = 0.01

/**
 * Check if two amounts match exactly (within rounding)
 */
export function amountsMatchExact(transactionAmount: number, invoiceTotal: number): boolean {
  // Round to 2 decimal places for comparison
  const txRounded = Math.round(transactionAmount * 100) / 100
  const invRounded = Math.round(invoiceTotal * 100) / 100
  return txRounded === invRounded
}

/**
 * Check if two amounts match within fuzzy tolerance (±1%)
 */
export function amountsMatchFuzzy(transactionAmount: number, invoiceTotal: number): boolean {
  if (invoiceTotal === 0) return false
  const diff = Math.abs(transactionAmount - invoiceTotal)
  // Cap fuzzy tolerance at 500 SEK to prevent false positives on large invoices
  const tolerance = Math.min(invoiceTotal * FUZZY_TOLERANCE, 500)
  return diff <= tolerance
}

/**
 * Check if customer name appears in transaction counterparty
 */
export function customerNameMatches(
  customerName: string | undefined,
  transactionDescription: string,
  merchantName: string | null
): boolean {
  if (!customerName) return false

  const searchTerms = customerName.toLowerCase().split(/\s+/).filter(term => term.length > 2)
  const searchText = `${transactionDescription} ${merchantName || ''}`.toLowerCase()

  // Check if any significant word from customer name appears in transaction
  return searchTerms.some(term => searchText.includes(term))
}

/**
 * Calculate confidence score and match reason for an invoice match
 */
export function calculateMatchScore(
  transaction: Transaction,
  invoice: Invoice & { customer?: Customer }
): { confidence: number; matchReason: string } {
  const transactionAmount = transaction.amount
  const invoiceTotal = invoice.total

  const exactAmount = amountsMatchExact(transactionAmount, invoiceTotal)
  const fuzzyAmount = !exactAmount && amountsMatchFuzzy(transactionAmount, invoiceTotal)
  const customerMatch = customerNameMatches(
    invoice.customer?.name,
    transaction.description,
    transaction.merchant_name
  )

  if (exactAmount && customerMatch) {
    return {
      confidence: CONFIDENCE.EXACT_AMOUNT_CUSTOMER,
      matchReason: `Exakt belopp (${invoiceTotal} ${invoice.currency}) och kundnamn matchar`,
    }
  }

  if (exactAmount) {
    return {
      confidence: CONFIDENCE.EXACT_AMOUNT_ONLY,
      matchReason: `Exakt belopp (${invoiceTotal} ${invoice.currency})`,
    }
  }

  if (fuzzyAmount && customerMatch) {
    return {
      confidence: CONFIDENCE.FUZZY_AMOUNT_CUSTOMER,
      matchReason: `Belopp nära (±1%) och kundnamn matchar`,
    }
  }

  if (fuzzyAmount) {
    return {
      confidence: CONFIDENCE.FUZZY_AMOUNT_ONLY,
      matchReason: `Belopp nära (±1%)`,
    }
  }

  return { confidence: 0, matchReason: '' }
}

/**
 * Find invoices that potentially match a bank transaction
 *
 * Only matches income transactions (amount > 0) against unpaid invoices
 * Returns matches sorted by confidence, filtered to >= 50% confidence
 */
export async function findMatchingInvoices(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction
): Promise<InvoiceMatch[]> {
  // Only match income transactions
  if (transaction.amount <= 0) {
    return []
  }

  // Query unpaid invoices (sent or overdue) with customer info
  const { data: invoices, error } = await supabase
    .from('invoices')
    .select(`
      *,
      customer:customers(*)
    `)
    .eq('company_id', companyId)
    .in('status', ['sent', 'overdue', 'partially_paid'])
    .order('due_date', { ascending: true })

  if (error || !invoices) {
    // Failed to fetch invoices — return empty matches
    return []
  }

  // Defensive filter: exclude invoices that already have a payment voucher
  // attached but whose status leaked (still 'sent'/'overdue'). Partially-paid
  // invoices can legitimately take more payments, so they pass through.
  // Without this, a status leak would double-book the receipt.
  const fullCandidateIds = invoices
    .filter((inv) => inv.status === 'sent' || inv.status === 'overdue')
    .map((inv) => inv.id as string)
  const paidIds = new Set<string>()
  if (fullCandidateIds.length > 0) {
    const { data: paymentRows } = await supabase
      .from('invoice_payments')
      .select('invoice_id')
      .eq('company_id', companyId)
      .in('invoice_id', fullCandidateIds)
      .not('journal_entry_id', 'is', null)
    for (const row of paymentRows ?? []) {
      paidIds.add((row as { invoice_id: string }).invoice_id)
    }
  }
  const filteredInvoices = invoices.filter((inv) => !paidIds.has(inv.id as string))
  if (filteredInvoices.length === 0) {
    return []
  }

  const matches: InvoiceMatch[] = []

  // OCR/Bankgiro reference matching — highest confidence
  // Swedish standard: match transaction reference to invoice OCR number
  const txReference = (transaction as Transaction & { reference?: string | null }).reference
  if (txReference) {
    const normalizedRef = txReference.replace(/\s+/g, '')
    for (const invoice of filteredInvoices) {
      // Match against invoice_number (used as OCR reference in Swedish payments)
      const invoiceRef = invoice.invoice_number?.replace(/\s+/g, '')
      if (invoiceRef && normalizedRef === invoiceRef) {
        matches.push({
          invoice: invoice as Invoice & { customer?: Customer },
          confidence: CONFIDENCE.OCR_REFERENCE_MATCH,
          matchReason: `OCR-referens matchar fakturanummer ${invoice.invoice_number}`,
        })
      }
    }

    // If we found an OCR match, return immediately (highest possible confidence)
    if (matches.length > 0) {
      return matches
    }
  }

  for (const invoice of filteredInvoices) {
    // Currency filter - must match or be SEK equivalent
    const currencyMatch =
      invoice.currency === transaction.currency ||
      (transaction.currency === 'SEK' && invoice.total_sek != null)

    if (!currencyMatch) continue

    // Use remaining_amount for partially paid invoices, otherwise total
    const invoiceAmount = invoice.remaining_amount ?? invoice.total

    // Use SEK amount for comparison if currencies differ
    const compareAmount =
      invoice.currency === transaction.currency
        ? invoiceAmount
        : (() => {
            if (invoice.total_sek && invoice.total) {
              return Math.round((invoiceAmount / invoice.total) * invoice.total_sek * 100) / 100
            }
            return invoiceAmount
          })()

    const transactionAmount = transaction.amount

    // Check if amounts are close enough to consider
    const amountDiff = Math.abs(transactionAmount - compareAmount)
    const tolerance = compareAmount * FUZZY_TOLERANCE
    if (amountDiff > tolerance && transactionAmount !== compareAmount) {
      continue
    }

    // Calculate score
    const invoiceWithAdjustedTotal = {
      ...invoice,
      total: compareAmount, // Use the comparable amount
    }

    const { confidence, matchReason } = calculateMatchScore(
      transaction,
      invoiceWithAdjustedTotal as Invoice & { customer?: Customer }
    )

    if (confidence >= CONFIDENCE.MIN_THRESHOLD) {
      matches.push({
        invoice: invoice as Invoice & { customer?: Customer },
        confidence,
        matchReason,
      })
    }
  }

  // Sort by confidence descending
  matches.sort((a, b) => b.confidence - a.confidence)

  return matches
}

/**
 * Get the best matching invoice for a transaction
 * Returns the highest confidence match if it meets the threshold
 */
export async function getBestInvoiceMatch(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction,
  minConfidence: number = 0.80
): Promise<InvoiceMatch | null> {
  const matches = await findMatchingInvoices(supabase, companyId, transaction)

  if (matches.length > 0 && matches[0].confidence >= minConfidence) {
    return matches[0]
  }

  return null
}

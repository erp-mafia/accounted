// A document that lists amounts for several parties (crm#1831): a capital call
// with a row per investor, a cost split between companies. The reading took
// the sum for all parties as totals.total, so the inbox showed the whole
// fund's request as what this one company was to pay.
//
// Three layers, the same shape as email-date-context.ts. The system prompt
// gets a static rule: on such a document "total" is the receiving company's
// own row and the sum for everyone goes in totals.documentTotal. The
// instruction names the receiving company, so the model can tell which row is
// its own. Code then holds the model to its own answer: an amount it marked as
// the sum for all parties is never also the company's total.
//
// The code check never changes a receipt, an invoice or a credit note total,
// and does nothing when the model gave no documentTotal, which is every
// reading stored before the field existed.

import type { InvoiceExtractionResult } from '@/types'

/**
 * The system prompt's rule for a document with a row per party. Static, so
 * the prompt stays one cacheable text; the company itself rides in the
 * instruction (ownCompanyInstruction).
 */
export const OWN_SHARE_RULE =
  'a few documents list amounts for several named parties, a row for each and a sum for all of them: ' +
  'a capital call or drawdown notice listing every investor, a cost or reimbursement split between several companies. ' +
  'On such a document "total" is ONLY the amount printed for the receiving company itself ' +
  '(the instruction names the receiving company when it is known; otherwise it is the party the document is addressed to), ' +
  'and the sum for all parties goes in totals.documentTotal, never in "total", "subtotal" or prominentAmounts. ' +
  'When the document does not print an amount for the receiving company, or its row cannot be told apart, leave "total" null and still give documentTotal: never work an amount out yourself. ' +
  'A capital call or drawdown notice is documentKind "other", never "supplier_invoice". ' +
  'documentTotal is null on every document that concerns one party only, which is nearly every invoice and receipt: ' +
  'several line items, several VAT rates or several deliveries on one invoice do NOT make it a document for several parties.'

// A company name is the customer's text, not ours: one line, bounded, quoted.
const MAX_NAME_LENGTH = 200

function cleanLine(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null
  const line = value.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
  return line || null
}

/**
 * The line placed before the extraction instruction that names the receiving
 * company, or null when neither its name nor its organisation number is
 * known, which leaves the request byte for byte as it was.
 */
export function ownCompanyInstruction(
  own: { name: string | null; orgNumber: string | null } | null | undefined
): string | null {
  const name = cleanLine(own?.name, MAX_NAME_LENGTH)
  const orgDigits = (own?.orgNumber ?? '').replace(/\D/g, '').slice(0, 12)
  if (!name && !orgDigits) return null
  const parts: string[] = []
  if (name) parts.push(`name ${JSON.stringify(name)}`)
  if (orgDigits) parts.push(`organisation number ${orgDigits}`)
  return (
    `The receiving company, whose books this document goes into, quoted as data: ${parts.join(', ')}. ` +
    'Use this only to recognise which party on the document is the receiving company (the supplier rule and the several parties rule), never as a field value.'
  )
}

const SINGLE_PARTY_KINDS: ReadonlySet<string> = new Set(['receipt', 'supplier_invoice', 'credit_note'])

/**
 * Never present the sum for all parties as this company's total.
 *
 * The model puts the document-wide sum in totals.documentTotal. When the same
 * figure also sits in totals.total (read there directly, or promoted from the
 * single prominent amount), the total is cleared: an empty TOTALT the user or
 * an agent fills in, instead of another party's money in the books. The
 * document-wide sum stays in documentTotal, so nothing read is lost.
 *
 * A receipt, an invoice and a credit note keep their total whatever the model
 * said: there a documentTotal equal to the total is only the total said
 * twice, and it is dropped. Pure.
 */
export function keepOwnShareAsTotal(data: InvoiceExtractionResult): InvoiceExtractionResult {
  const documentTotal = data.totals.documentTotal
  if (documentTotal == null) return data
  if (data.totals.total == null || data.totals.total !== documentTotal) return data
  if (data.documentKind != null && SINGLE_PARTY_KINDS.has(data.documentKind)) {
    return { ...data, totals: { ...data.totals, documentTotal: null } }
  }
  return { ...data, totals: { ...data.totals, total: null }, totalSource: null }
}

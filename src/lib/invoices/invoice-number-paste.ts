/**
 * Picking the invoices one bank row pays by pasting their numbers (#75, the
 * crm#1297 follow-up). A payer that settles hundreds of invoices in one
 * transfer (a Skatteverket ROT/RUT payout of several begäran, a customer
 * paying a statement) comes with a list of the numbers it paid: a beslut, a
 * bank specification, a spreadsheet. Ticking hundreds of rows one by one is
 * not a workflow, so the batch allocation dialog (MatchAllocationDialog)
 * takes the list as pasted text, or as Skatteverket's beslutsfil
 * (beslutFileToPaste), and picks what it names.
 *
 * Pure: the parse and the resolution live here and are unit tested; the
 * database reads that feed the resolution live in open-invoice-search.ts
 * (loadInvoicesForPaste) and the dialog only wires the two together.
 *
 * Nothing pasted is dropped. Every reference that is not picked comes back
 * with a reason (not found, already paid, not open, ambiguous, another
 * currency, amount above what the invoice owes, named twice, unreadable,
 * refused by Skatteverket, no invoice number in the beslut), so the person
 * can check it against the list they pasted from.
 */
import { ORE_ROUNDING_SETTLEMENT_MAX, parseSwedishAmount, roundOre, sumOre } from '@/lib/money'
import { invoiceReferenceKeys } from './ocr-keys'
import type { RotRutBeslutFile } from './rot-rut-beslut-file'

/**
 * Most references one paste reads. Far above what one bank row may settle
 * (MAX_BANK_ROW_SPLIT), so a real list is never cut; the bound only keeps a
 * mistaken paste (a whole ledger) from freezing the page.
 */
export const MAX_PASTED_REFERENCES = 5000

/** One invoice reference read from the pasted text. */
export interface PastedReference {
  /** As pasted, trimmed and unquoted: what the not-picked list shows. */
  text: string
  /** The amount column, when the line carried one; null otherwise. */
  amount: number | null
}

export interface ParsedInvoicePaste {
  /** Each reference once, in paste order. */
  references: PastedReference[]
  /** Cells that name no invoice (a header, a word, an amount that is not positive). */
  unreadable: string[]
  /** References pasted twice with different amounts: neither amount is guessed. */
  conflicting: string[]
  /** Repeats of an earlier reference (same text, same amount), collapsed. */
  duplicates: number
  /** The paste held more than MAX_PASTED_REFERENCES; the rest was not read. */
  truncated: boolean
  /** What the source itself rules out (a beslut's refused and unnumbered ärenden), listed as given. */
  sourceSkips?: PasteSkip[]
}

const LINE_BREAK = /\r\n|\r|\n/
/** A spreadsheet row: cells copied from Excel are tab separated, a Swedish CSV semicolon separated. */
const CELL_SEPARATOR = /[\t;]/
/** Free text: numbers separated by spaces or commas. */
const TOKEN_SEPARATOR = /[\s,]+/
const QUOTES = /^["'“”‘’]+|["'“”‘’]+$/g

function unquote(cell: string): string {
  return cell.trim().replace(QUOTES, '').trim()
}

/** The identity two pasted texts share when they are the same reference: case and spacing aside. */
export function pastedReferenceKey(text: string): string {
  return text.replace(/\s/g, '').toUpperCase()
}

/**
 * Pasted text to invoice references. One reference per line, or several on a
 * line separated by spaces, commas, tabs or semicolons. A line of exactly two
 * spreadsheet cells (tab or semicolon) whose second cell is an amount is a
 * reference with the amount it was paid with ("1042<TAB>1 250,00"); an
 * amount that is zero or negative makes the line unreadable rather than a
 * reference at the wrong amount. A cell without a digit names no invoice
 * (every invoice number carries one) and comes back as unreadable.
 */
export function parseInvoicePaste(text: string): ParsedInvoicePaste {
  const byKey = new Map<string, { reference: PastedReference; conflicting: boolean }>()
  const unreadable: string[] = []
  let duplicates = 0
  let truncated = false

  const add = (rawText: string, amount: number | null) => {
    const cleaned = unquote(rawText)
    if (!cleaned) return
    if (!/\d/.test(cleaned)) {
      unreadable.push(cleaned)
      return
    }
    const key = pastedReferenceKey(cleaned)
    const seen = byKey.get(key)
    if (seen) {
      if (seen.reference.amount === amount) duplicates += 1
      else seen.conflicting = true
      return
    }
    if (byKey.size >= MAX_PASTED_REFERENCES) {
      truncated = true
      return
    }
    byKey.set(key, { reference: { text: cleaned, amount }, conflicting: false })
  }

  for (const rawLine of text.split(LINE_BREAK)) {
    if (truncated) break
    const line = rawLine.trim()
    if (!line) continue
    if (CELL_SEPARATOR.test(line)) {
      const cells = line.split(CELL_SEPARATOR).map(unquote).filter(Boolean)
      const amount = cells.length === 2 ? parseSwedishAmount(cells[1]) : null
      if (cells.length === 2 && amount !== null && !TOKEN_SEPARATOR.test(cells[0])) {
        if (amount > 0) add(cells[0], amount)
        else unreadable.push(line)
        continue
      }
      for (const cell of cells) for (const token of cell.split(TOKEN_SEPARATOR)) add(token, null)
      continue
    }
    for (const token of line.split(TOKEN_SEPARATOR)) add(token, null)
  }

  const references: PastedReference[] = []
  const conflicting: string[] = []
  for (const { reference, conflicting: isConflicting } of byKey.values()) {
    if (isConflicting) conflicting.push(reference.text)
    else references.push(reference)
  }
  return { references, unreadable, conflicting, duplicates, truncated }
}

/**
 * Skatteverket's beslutsfil as the references a paste would carry: every
 * invoice its ärenden name, at what Skatteverket approved for it. Only the
 * invoice numbers and amounts are read; the buyers' personnummer stay in the
 * file.
 *
 * One invoice can be named by two ärenden, its ROT and its RUT share filed
 * as two begäran and decided in the same file, so the approved amounts add
 * up. An invoice approved 0 kr in all is refused rather than picked: the
 * buyer owes that share, not this payout. An ärende without an invoice
 * number cannot be resolved here and comes back with its begäran and amount,
 * to be picked by hand.
 */
export function beslutFileToPaste(file: RotRutBeslutFile): ParsedInvoicePaste {
  const byKey = new Map<string, PastedReference>()
  const sourceSkips: PasteSkip[] = []
  for (const beslut of file.beslut) {
    for (const arende of beslut.arenden) {
      const number = arende.fakturanummer?.trim()
      if (!number) {
        sourceSkips.push({ text: beslut.namn, reason: 'no_invoice_number', amount: arende.godkantBelopp })
        continue
      }
      const seen = byKey.get(pastedReferenceKey(number))
      if (seen) seen.amount = (seen.amount ?? 0) + arende.godkantBelopp
      else byKey.set(pastedReferenceKey(number), { text: number, amount: arende.godkantBelopp })
    }
  }
  const references: PastedReference[] = []
  for (const reference of byKey.values()) {
    if (reference.amount === 0) sourceSkips.push({ text: reference.text, reason: 'refused' })
    else references.push(reference)
  }
  return { references, unreadable: [], conflicting: [], duplicates: 0, truncated: false, sourceSkips }
}

export type PasteInvoiceKind = 'customer' | 'supplier'

/**
 * Where an invoice a paste may name stands: open (the batch can pay it),
 * already paid, or otherwise not open (a draft, a credited or cancelled one).
 */
export type PasteInvoiceState = 'open' | 'paid' | 'not_open'

/** What the resolution reads of an invoice. */
export interface PasteInvoice {
  id: string
  /** invoice_number (customer) or supplier_invoice_number (supplier). */
  number: string | null
  /** The supplier's OCR or other payment reference; customer invoices derive theirs from the number. */
  paymentReference?: string | null
  state: PasteInvoiceState
  currency: string | null
  /** What the invoice still owes, in its own currency. */
  remaining: number
}

const digitsOf = (value: string | null | undefined): string => (value ?? '').replace(/\D/g, '')
const withoutLeadingZeros = (digits: string): string => digits.replace(/^0+/, '')

/** One way a reference can name an invoice; the tiers are read strongest first. */
interface Tier<T> {
  /** The keys an invoice is named by in this tier. */
  invoiceKeys: (invoice: T) => string[]
  /** The key a pasted reference is looked up by. */
  referenceKey: (text: string) => string
}

/**
 * The tiers, strongest first. The number as written wins over its digits,
 * the digits over the OCR built from them, and the OCR over a match that
 * ignores leading zeros (a spreadsheet drops them from a number column), so
 * a pasted 3164 is invoice 3164 and never invoice 316 by its OCR 3164.
 * Supplier invoice numbers are the supplier's own, so they have no derived
 * OCR; the supplier's payment reference is read instead.
 */
function tiersFor<T extends PasteInvoice>(kind: PasteInvoiceKind): Tier<T>[] {
  const exact: Tier<T> = {
    invoiceKeys: (inv) => (inv.number ? [pastedReferenceKey(inv.number)] : []),
    referenceKey: pastedReferenceKey,
  }
  const numberDigits: Tier<T> = {
    invoiceKeys: (inv) => [digitsOf(inv.number)],
    referenceKey: digitsOf,
  }
  if (kind === 'customer') {
    const keysOf = (inv: T, form: 'invoice_number' | 'ocr' | 'ocr_length') =>
      invoiceReferenceKeys(inv.number)
        .filter((k) => k.form === form)
        .map((k) => k.key)
    return [
      exact,
      numberDigits,
      { invoiceKeys: (inv) => keysOf(inv, 'ocr'), referenceKey: digitsOf },
      {
        invoiceKeys: (inv) => [...keysOf(inv, 'invoice_number'), ...keysOf(inv, 'ocr')].map(withoutLeadingZeros),
        referenceKey: (text) => withoutLeadingZeros(digitsOf(text)),
      },
      { invoiceKeys: (inv) => keysOf(inv, 'ocr_length'), referenceKey: digitsOf },
    ]
  }
  return [
    exact,
    numberDigits,
    { invoiceKeys: (inv) => [digitsOf(inv.paymentReference)], referenceKey: digitsOf },
    {
      invoiceKeys: (inv) => [digitsOf(inv.number), digitsOf(inv.paymentReference)].map(withoutLeadingZeros),
      referenceKey: (text) => withoutLeadingZeros(digitsOf(text)),
    },
  ]
}

function indexTier<T extends PasteInvoice>(tier: Tier<T>, invoices: readonly T[]): Map<string, T[]> {
  const index = new Map<string, T[]>()
  for (const invoice of invoices) {
    for (const key of new Set(tier.invoiceKeys(invoice))) {
      if (!key) continue
      const list = index.get(key)
      if (list) list.push(invoice)
      else index.set(key, [invoice])
    }
  }
  return index
}

/** How one reference resolves against the loaded invoices. */
export type ReferenceResolution<T> =
  | { kind: 'one'; invoice: T }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'none' }

/**
 * Resolve every reference against the invoices: the strongest tier that
 * names any invoice decides. One invoice there is the match (open or not),
 * two or more is ambiguous (two suppliers' invoices with the same number),
 * never a guess. Indexes are built once, so a paste of thousands of
 * references against a ledger of thousands of invoices stays linear.
 */
export function resolvePastedReferences<T extends PasteInvoice>(
  references: readonly PastedReference[],
  invoices: readonly T[],
  kind: PasteInvoiceKind,
): ReferenceResolution<T>[] {
  const tiers = tiersFor<T>(kind).map((tier) => ({ tier, index: indexTier(tier, invoices) }))
  return references.map((reference) => {
    for (const { tier, index } of tiers) {
      const key = tier.referenceKey(reference.text)
      if (!key) continue
      const hits = index.get(key)
      if (!hits || hits.length === 0) continue
      const unique = [...new Map(hits.map((inv) => [inv.id, inv])).values()]
      return unique.length === 1 ? { kind: 'one', invoice: unique[0] } : { kind: 'ambiguous', count: unique.length }
    }
    return { kind: 'none' }
  })
}

/**
 * Invoice numbers to look up among invoices that are not open, so a pasted
 * number of a paid invoice is reported as paid instead of not found, and
 * cannot fall through to a weaker tier that names an open invoice by its OCR.
 * The reference as written and its digits; for a customer invoice also the
 * number an OCR or length-digit OCR was built from. Only plain characters
 * travel: the values go into an `.in()` filter.
 */
export function closedLookupNumbers(references: readonly PastedReference[], kind: PasteInvoiceKind): string[] {
  const out = new Set<string>()
  const addSafe = (value: string) => {
    if (value && /^[\p{L}\p{N}._/-]+$/u.test(value)) out.add(value)
  }
  for (const { text } of references) {
    addSafe(text)
    const digits = digitsOf(text)
    addSafe(digits)
    if (kind !== 'customer') continue
    const ocrBase = digits.slice(0, -1)
    if (ocrBase && invoiceReferenceKeys(ocrBase).some((k) => k.form === 'ocr' && k.key === digits)) addSafe(ocrBase)
    const lengthBase = digits.slice(0, -2)
    if (lengthBase && invoiceReferenceKeys(lengthBase).some((k) => k.form === 'ocr_length' && k.key === digits)) {
      addSafe(lengthBase)
    }
  }
  return [...out]
}

/** Why a pasted reference was not picked. */
export type PasteSkipReason =
  | 'not_found'
  | 'already_paid'
  | 'not_open'
  | 'ambiguous'
  | 'other_currency'
  | 'amount_above_remaining'
  | 'same_invoice'
  | 'conflicting_amounts'
  | 'unreadable'
  | 'refused'
  | 'no_invoice_number'

export interface PasteSkip {
  text: string
  reason: PasteSkipReason
  /** The invoice's number, when the reference named one. */
  invoiceNumber?: string | null
  /** same_invoice: the earlier reference that already picked it. */
  earlier?: string
  /** ambiguous: how many invoices the reference names. */
  count?: number
  /** no_invoice_number: what Skatteverket approved for the ärende, in whole kronor. */
  amount?: number
}

export interface PastePick<T> {
  invoice: T
  /** In the bank row's currency: the pasted amount, or what the invoice still owes. */
  amount: number
  text: string
}

export interface InvoicePasteResult<T> {
  picks: PastePick<T>[]
  pickedTotal: number
  /** Every reference not picked, in paste order, then what the source ruled out, then the unreadable cells. */
  skipped: PasteSkip[]
  counts: Record<PasteSkipReason, number>
  /** Repeats the parse collapsed (same reference, same amount). */
  duplicates: number
  truncated: boolean
}

const normalizeCurrency = (currency: string | null | undefined) => (currency || 'SEK').toUpperCase()

/**
 * The picks a paste makes for one bank row, and why the rest are not made.
 * Only open invoices in the row's currency are picked, as the picker's
 * ticking does: a foreign invoice's share is the kronor the bank took, which
 * a paste does not carry. Each pick is the pasted amount, or else what the
 * invoice owes; never the row's leftover budget, which over hundreds of
 * picks would quietly shorten the last ones. A pasted amount a krona or more
 * above what the invoice owes is refused here, as the batch RPC would refuse
 * it (BATCH_OVERSHOOT). Whether the picks add up to the row is the dialog's
 * tally to show; nothing here bends an amount to fit.
 */
export function planInvoicePaste<T extends PasteInvoice>(
  parsed: ParsedInvoicePaste,
  invoices: readonly T[],
  options: { kind: PasteInvoiceKind; currency: string | null },
): InvoicePasteResult<T> {
  const rowCurrency = normalizeCurrency(options.currency)
  const resolutions = resolvePastedReferences(parsed.references, invoices, options.kind)
  const picks: PastePick<T>[] = []
  const skipped: PasteSkip[] = []
  const pickedBy = new Map<string, string>()

  parsed.references.forEach((reference, i) => {
    const skip = (reason: PasteSkipReason, extra: Omit<PasteSkip, 'text' | 'reason'> = {}) =>
      skipped.push({ text: reference.text, reason, ...extra })
    const resolution = resolutions[i]
    if (resolution.kind === 'none') {
      skip('not_found')
      return
    }
    if (resolution.kind === 'ambiguous') {
      skip('ambiguous', { count: resolution.count })
      return
    }
    const { invoice } = resolution
    const invoiceNumber = invoice.number
    const earlier = pickedBy.get(invoice.id)
    const remaining = roundOre(invoice.remaining)
    if (invoice.state === 'paid') skip('already_paid', { invoiceNumber })
    else if (invoice.state === 'not_open') skip('not_open', { invoiceNumber })
    else if (earlier !== undefined) skip('same_invoice', { invoiceNumber, earlier })
    else if (normalizeCurrency(invoice.currency) !== rowCurrency) skip('other_currency', { invoiceNumber })
    else if (reference.amount !== null && roundOre(reference.amount - remaining) >= ORE_ROUNDING_SETTLEMENT_MAX) {
      skip('amount_above_remaining', { invoiceNumber })
    } else {
      pickedBy.set(invoice.id, reference.text)
      picks.push({ invoice, amount: reference.amount ?? remaining, text: reference.text })
    }
  })
  skipped.push(...(parsed.sourceSkips ?? []))
  for (const text of parsed.conflicting) skipped.push({ text, reason: 'conflicting_amounts' })
  for (const text of parsed.unreadable) skipped.push({ text, reason: 'unreadable' })

  const counts = {
    not_found: 0,
    already_paid: 0,
    not_open: 0,
    ambiguous: 0,
    other_currency: 0,
    amount_above_remaining: 0,
    same_invoice: 0,
    conflicting_amounts: 0,
    unreadable: 0,
    refused: 0,
    no_invoice_number: 0,
  } satisfies Record<PasteSkipReason, number>
  for (const skip of skipped) counts[skip.reason] += 1

  return {
    picks,
    pickedTotal: sumOre(picks.map((p) => p.amount)),
    skipped,
    counts,
    duplicates: parsed.duplicates,
    truncated: parsed.truncated,
  }
}

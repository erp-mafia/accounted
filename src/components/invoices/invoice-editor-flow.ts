import { addDays, differenceInCalendarDays, format, isValid, parseISO } from 'date-fns'
import { foldText } from '@/lib/bookkeeping/account-search'

/**
 * Pure derivations behind the invoice editor's snabbflöde shell:
 *
 *   - deriveNextStep: the single dynamic "Nästa steg" line (the page's only
 *     ochre sentence) and the focus-routing target for an invalid submit.
 *   - deriveForvalChips: the Förval chip line summarizing collapsed settings,
 *     surfacing every value that deviates from its default so edit/copy mode
 *     never round-trips values the user cannot see.
 *   - planDueDateSync: keeps förfallodatum on the same payment term when the
 *     user moves fakturadatum, instead of leaving them to count days by hand.
 *   - planCustomerTermsFill: the same term, filled from the picked customer's
 *     default and counted from the invoice date on the form.
 *   - filterArticleSuggestions: the unified row entry's autocomplete filter
 *     (diacritics-folded, matches name and article number, same folding as
 *     ArticleCombobox).
 *
 * Kept in a plain module (no JSX, no hooks) so the rules are unit-testable:
 * the repo does not render components in tests.
 */

export interface NextStepItem {
  line_type?: 'product' | 'text' | null
  description?: string
  quantity?: number | null
  unit?: string
  unit_price?: number | null
}

export type NextStepRowField = 'description' | 'quantity' | 'unit' | 'unit_price'

export type NextStep =
  | { kind: 'customer' }
  | { kind: 'invoice_date' }
  | { kind: 'due_date' }
  | { kind: 'rows_empty' }
  | { kind: 'row_incomplete'; index: number; field: NextStepRowField }
  | { kind: 'payment_link' }
  | { kind: 'personnummer' }
  | { kind: 'housing' }
  | { kind: 'external_number' }
  | { kind: 'received_date' }
  | { kind: 'ready' }

export interface NextStepInput {
  isSelfBilled: boolean
  customerSelected: boolean
  invoiceDate: string
  dueDate: string
  receivedDate: string
  externalInvoiceNumber: string
  items: NextStepItem[]
  /** True when the payment link field carries a validation error. */
  paymentLinkInvalid: boolean
  /** A deduction is claimed and neither draft last4 nor kundkort covers it. */
  requiresPersonnummer: boolean
  personnummer: string
  /**
   * A ROT line exists AND a deduction amount is claimed (fastighetsbeteckning
   * is then required). Derive via deriveRequiresHousing so the gate provably
   * matches the ROT/RUT claim card's mount condition.
   */
  requiresHousing: boolean
  housingDesignation: string
}

/**
 * The housing (fastighetsbeteckning) requirement behind NextStepInput. A ROT
 * line alone is not enough: the claim card only mounts while a deduction
 * amount is claimed (deductionTotal > 0), so a ROT-flagged line whose amount
 * is still zero (transient state while typing) must not produce a housing
 * step, or the next-step link would try to focus an unmounted field.
 */
export function deriveRequiresHousing(input: {
  hasRotLine: boolean
  deductionTotal: number
}): boolean {
  return input.hasRotLine && input.deductionTotal > 0
}

/**
 * Priority order (the same order the invalid-submit focus routing walks):
 * customer -> dates -> first incomplete line -> payment link -> ROT/RUT claim
 * fields -> self-billed extras -> ready.
 */
export function deriveNextStep(input: NextStepInput): NextStep {
  if (!input.customerSelected) return { kind: 'customer' }
  if (!input.invoiceDate) return { kind: 'invoice_date' }
  if (!input.dueDate) return { kind: 'due_date' }

  const productRows = input.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.line_type !== 'text')
  if (productRows.length === 0) return { kind: 'rows_empty' }
  for (const { item, index } of productRows) {
    if (!item.description?.trim()) return { kind: 'row_incomplete', index, field: 'description' }
    // Mirrors the schema: quantity >= 0.01 (NaN fails the comparison too).
    if (!((item.quantity ?? 0) >= 0.01)) return { kind: 'row_incomplete', index, field: 'quantity' }
    if (!item.unit?.trim()) return { kind: 'row_incomplete', index, field: 'unit' }
    // Negative prices are lawful discount lines; only a non-number blocks.
    if (!Number.isFinite(item.unit_price ?? 0)) {
      return { kind: 'row_incomplete', index, field: 'unit_price' }
    }
  }

  if (input.paymentLinkInvalid) return { kind: 'payment_link' }
  if (input.requiresPersonnummer && !input.personnummer.trim()) return { kind: 'personnummer' }
  if (input.requiresHousing && !input.housingDesignation.trim()) return { kind: 'housing' }

  if (input.isSelfBilled) {
    if (!input.externalInvoiceNumber.trim()) return { kind: 'external_number' }
    if (!input.receivedDate) return { kind: 'received_date' }
  }
  return { kind: 'ready' }
}

export type ForvalChip =
  | { kind: 'doc_type'; documentType: 'proforma' | 'delivery_note' | 'quote' }
  | { kind: 'currency'; currency: string }
  | { kind: 'invoice_date'; date: string }
  | { kind: 'due_days'; days: number; date: string }
  | { kind: 'due_date'; date: string }
  | { kind: 'valid_until'; date: string }
  | { kind: 'received'; date: string }
  | { kind: 'delivery'; date: string }
  | { kind: 'your_reference'; reference: string }
  | { kind: 'invoice_marking'; marking: string }
  | { kind: 'payment_link'; mode: 'auto' | 'manual' }
  | { kind: 'ore_off' }
  | { kind: 'dims'; dims: string }

export interface ForvalChipsInput {
  isSelfBilled: boolean
  documentType: 'invoice' | 'proforma' | 'delivery_note' | 'quote'
  currency: string
  invoiceDate: string
  dueDate: string
  /** Quotes only: the expiry date ("Giltig till"). Replaces the due chips. */
  validUntil?: string
  receivedDate: string
  deliveryDate: string
  yourReference: string
  invoiceMarking: string
  paymentLink: 'auto' | 'manual' | null
  oreRounding: boolean
  /** Compact display of the invoice-level default dims, or null when none. */
  dims: string | null
}

/**
 * The chip line renders the always-relevant defaults (currency, due terms)
 * plus every collapsed setting whose value deviates from its default. A
 * deviating value MUST surface here: in edit/copy mode the draft may carry a
 * proforma type, an EUR currency, a payment link or dimension defaults that
 * would otherwise round-trip invisibly through PATCH.
 */
export function deriveForvalChips(input: ForvalChipsInput): ForvalChip[] {
  const chips: ForvalChip[] = []
  if (!input.isSelfBilled && input.documentType !== 'invoice') {
    chips.push({ kind: 'doc_type', documentType: input.documentType })
  }
  chips.push({ kind: 'currency', currency: input.currency })
  // The invoice date always surfaces: it silently defaults to today inside
  // the collapsed panel, and especially in self-billed mode (where the
  // counterparty's issue date must be transcribed) an invisible default
  // registers wrong invoices (issue #1820).
  if (input.invoiceDate) {
    chips.push({ kind: 'invoice_date', date: input.invoiceDate })
  }
  if (input.documentType === 'quote' && !input.isSelfBilled) {
    // A quote has no due date, only an expiry: the due chips would describe
    // a payment term the document does not carry.
    if (input.validUntil) chips.push({ kind: 'valid_until', date: input.validUntil })
  } else if (input.dueDate) {
    const days = dueDays(input.invoiceDate, input.dueDate)
    if (days !== null && days >= 0) chips.push({ kind: 'due_days', days, date: input.dueDate })
    else chips.push({ kind: 'due_date', date: input.dueDate })
  }
  if (input.isSelfBilled && input.receivedDate) {
    chips.push({ kind: 'received', date: input.receivedDate })
  }
  if (!input.isSelfBilled && input.deliveryDate) {
    chips.push({ kind: 'delivery', date: input.deliveryDate })
  }
  if (!input.isSelfBilled && input.yourReference.trim()) {
    chips.push({ kind: 'your_reference', reference: input.yourReference.trim() })
  }
  if (!input.isSelfBilled && input.invoiceMarking.trim()) {
    chips.push({ kind: 'invoice_marking', marking: input.invoiceMarking.trim() })
  }
  if (!input.isSelfBilled && input.paymentLink) {
    chips.push({ kind: 'payment_link', mode: input.paymentLink })
  }
  if (!input.isSelfBilled && !input.oreRounding && input.currency === 'SEK') {
    chips.push({ kind: 'ore_off' })
  }
  if (!input.isSelfBilled && input.dims) {
    chips.push({ kind: 'dims', dims: input.dims })
  }
  return chips
}

function dueDays(invoiceDate: string, dueDate: string): number | null {
  if (!invoiceDate || !dueDate) return null
  const from = parseISO(invoiceDate)
  const to = parseISO(dueDate)
  if (!isValid(from) || !isValid(to)) return null
  return differenceInCalendarDays(to, from)
}

export interface DueDateSyncInput {
  /** Fakturadatum as the form holds it now (yyyy-MM-dd, may be empty). */
  invoiceDate: string
  /** Förfallodatum as the form holds it now (yyyy-MM-dd, may be empty). */
  dueDate: string
  /** The invoice date the previous sync settled on; null before the first. */
  previousInvoiceDate: string | null
  /** Payment term in days carried over from the previous sync. */
  terms: number
}

export interface DueDateSyncResult {
  /** The due date to write, or null to leave the field alone. */
  dueDate: string | null
  /** Term to carry into the next sync. */
  terms: number
  /** Invoice date to carry into the next sync. */
  previousInvoiceDate: string | null
}

/**
 * Betalningsvillkoret, not the due DATE, is what the user actually decided:
 * moving fakturadatum to the end of the month must carry "30 dagar netto"
 * with it rather than leave förfallodatum stranded four days out (issue: the
 * user had to count 30 days by hand).
 *
 * The term is never stored on the draft, so it is read back off the current
 * date pair: whatever the customer default, the loaded draft or the user's own
 * hand-picked due date put there. That makes a manual due date a NEW term
 * instead of something the next invoice-date edit would clobber.
 *
 * Only a change of fakturadatum moves förfallodatum; a due date the user edits
 * on its own is authoritative. A half-typed or cleared invoice date holds the
 * previous baseline: `<input type="date">` reports empty mid-edit, and treating
 * that as a change would rewrite the due date off a garbage anchor.
 */
export function planDueDateSync(input: DueDateSyncInput): DueDateSyncResult {
  const { invoiceDate, dueDate, previousInvoiceDate, terms } = input
  const anchor = parseISO(invoiceDate)
  if (!invoiceDate || !isValid(anchor)) {
    return { dueDate: null, terms, previousInvoiceDate }
  }
  if (previousInvoiceDate === null || previousInvoiceDate === invoiceDate) {
    // Same anchor: the pair on screen defines the term. A due date BEFORE the
    // invoice date is not a term at all (the chip line treats it as a fixed
    // date too), so it is ignored rather than carried forward as negative.
    const observed = dueDays(invoiceDate, dueDate)
    return {
      dueDate: null,
      terms: observed !== null && observed >= 0 ? observed : terms,
      previousInvoiceDate: invoiceDate,
    }
  }
  return {
    dueDate: format(addDays(anchor, terms), 'yyyy-MM-dd'),
    terms,
    previousInvoiceDate: invoiceDate,
  }
}

export interface CustomerTermsFillInput {
  /** Fakturadatum as the form holds it now (yyyy-MM-dd, may be empty). */
  invoiceDate: string
  /** The picked customer's default_payment_terms, in days. */
  terms: number
  /** Today as yyyy-MM-dd: the anchor of last resort. */
  today: string
}

export interface CustomerTermsFillResult {
  /** The due date to write. */
  dueDate: string
  /** The term planDueDateSync must carry from here on. */
  terms: number
}

/**
 * Picking a customer fills förfallodatum from that customer's payment term,
 * counted from the invoice date the form is actually on: choosing a customer
 * after setting fakturadatum to the 31st must give the 31st + terms, not
 * today + terms. Today is the anchor only while fakturadatum is empty or
 * half-typed, which is also why the term comes back out of here: the sync
 * baseline reads a term off the date pair on screen, and with no valid invoice
 * date there is no pair to read, so this fill is the only thing that knows it.
 * Without that, a 14 day customer picked on a cleared fakturadatum would be
 * overwritten by the previous 30 day term on the next date the user types.
 */
export function planCustomerTermsFill(input: CustomerTermsFillInput): CustomerTermsFillResult {
  const { invoiceDate, terms, today } = input
  const anchor = parseISO(invoiceDate)
  const base = invoiceDate && isValid(anchor) ? anchor : parseISO(today)
  return { dueDate: format(addDays(base, terms), 'yyyy-MM-dd'), terms }
}

export interface ArticleSuggestion {
  id: string
  article_number: string | null
  name: string
}

/**
 * Filter for the unified row entry: empty query browses everything, a query
 * matches name and article number, diacritics-folded (same folding as
 * ArticleCombobox so the two article surfaces agree on what matches).
 */
export function filterArticleSuggestions<T extends ArticleSuggestion>(
  articles: T[],
  query: string,
): T[] {
  const q = foldText(query.trim())
  if (!q) return articles
  return articles.filter((a) => foldText(`${a.article_number ?? ''} ${a.name}`).includes(q))
}

/** The cells of a committed product row that the entry row's ghost cells stand in for. */
export type EntryGhostCell = 'quantity' | 'unit' | 'unit_price' | 'vat_rate'

export interface EntryKeyInput {
  key: string
  /** Shift held: Shift+Tab navigates backwards and never commits. */
  shiftKey?: boolean
  /**
   * An IME composition is open (issue #2447). Android keyboards (Gboard
   * autocorrecting a free-text description) report every keydown during a
   * composition as keyCode 229 / key 'Unidentified', including the action
   * key: acting on one would commit the row with the pre-correction text.
   * Derive it with isComposingKey so every caller reads the event the same
   * way.
   */
  composing?: boolean
  query: string
  /** The suggestion popover is open. */
  open: boolean
  /** Index of the highlighted suggestion, -1 for none. */
  activeIdx: number
  matchCount: number
}

export type EntryKeyAction =
  | { kind: 'article'; index: number }
  | { kind: 'free_text'; text: string }
  | { kind: 'none' }

/**
 * Whether a key event is an IME composition artefact rather than a real key
 * press. `isComposing` is the standard signal; `keyCode === 229` is the
 * legacy one Android/Chrome still sends (and the only one some Gboard
 * versions send), and a key of 'Unidentified' is what comes with it.
 */
export function isComposingKey(event: {
  isComposing?: boolean
  keyCode?: number
  key?: string
}): boolean {
  return Boolean(event.isComposing) || event.keyCode === 229 || event.key === 'Unidentified'
}

/**
 * What Enter and Tab do in the unified entry row. Both commit: a highlighted
 * article wins, otherwise the typed text becomes a free-text row. With nothing
 * typed neither commits: Enter is swallowed by the caller (never submits the
 * form) and Tab passes through so the row is not a focus trap.
 *
 * A composing key never commits. Touch keyboards have no Tab at all, so the
 * keyboard is only one way into a row: the ghost cells, the suggestion list
 * and the "Lägg till rad" button commit without one (issue #2447).
 */
export function resolveEntryKey(input: EntryKeyInput): EntryKeyAction {
  if (input.composing) return { kind: 'none' }
  if (input.key !== 'Enter' && input.key !== 'Tab') return { kind: 'none' }
  if (input.key === 'Tab' && input.shiftKey) return { kind: 'none' }
  if (input.open && input.activeIdx >= 0 && input.activeIdx < input.matchCount) {
    return { kind: 'article', index: input.activeIdx }
  }
  const text = input.query.trim()
  if (text) return { kind: 'free_text', text }
  return { kind: 'none' }
}

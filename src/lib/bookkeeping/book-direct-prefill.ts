/**
 * Prefill lines for "Bokför direkt" (inbox receipt → verifikat).
 *
 * A SEK receipt with extracted VAT is three generated legs: cost, input VAT,
 * settlement. Choosing a bank transaction used to drop the VAT leg and then
 * copy accounts and dimension bags by array index, so 2641 and its tags slid
 * onto the settlement credit while the VAT amount disappeared. The voucher
 * still balanced, which is why the balance check could not see it.
 *
 * Generated rows carry a stable role. Manual and template rows do not, and
 * nothing here guesses a role from an account number or a row position.
 * Reconciliation copies accounts and dimension bags only within the same
 * role. An untouched settlement account follows the resolved cash account;
 * `generated_account` plus `account_edited` tell that placeholder apart from
 * an explicit selection of the same number.
 *
 * Booking amounts are SEK. A selected transaction supplies the canonical
 * total (already converted by the caller). Extracted VAT is kept as öre on
 * the document; it is not scaled and no rate is derived. Foreign-currency
 * documents still get no automatic VAT row. Client-only role and provenance
 * fields stay off the book-direct request: `toBookDirectPayloadLine` is the
 * payload mapping.
 *
 * No VAT row is generated for a company that is not VAT-registered: it has
 * no avdragsrätt (13 kap. ML 2023:200), so the seller's VAT is part of the
 * cost (`sellerVatIsCost`, the rule the bank and inbox paths already apply).
 * A generated row the user deleted stays deleted for the rest of the dialog
 * session; a deleted VAT row leaves the whole total on cost.
 */

import type { InvoiceExtractionResult } from '@/types'
import { roundOre } from '@/lib/money'
import { sellerVatIsCost, type VatRegistration } from '@/lib/bookkeeping/vat-registration'

export type BookDirectLineRole = 'cost' | 'vat' | 'settlement'

/** Form row for the book-direct dialog. Role and provenance never go to the API. */
export interface BookDirectFormLine {
  account_number: string
  debit_amount: string
  credit_amount: string
  /** Kostnadsställe/projekt bag. A defined bag (possibly empty) means the picker row is open. */
  dimensions?: Record<string, string>
  /** Present only on rows the prefill generator owns. */
  role?: BookDirectLineRole
  /**
   * Account last written by the generator. Equal to `account_number` while
   * the leg still shows that default. Absent means the row is manual.
   */
  generated_account?: string
  /**
   * Set when the user commits an account, including a commit of the same
   * number as the current default. Untouched settlement defaults follow the
   * resolved cash account; an explicit commit does not.
   */
  account_edited?: boolean
}

export interface BookDirectPrefillOptions {
  /**
   * company_settings.vat_registered as loaded. Only an explicit false changes
   * the prefill (no VAT row, the full total on cost); null or undefined, as
   * while settings load, prefills as for a registered company.
   */
  vatRegistered?: VatRegistration
  /**
   * Generated roles the user deleted in this dialog session. They are never
   * generated again. A suppressed VAT role also keeps the VAT amount on cost,
   * so the refreshed rows still balance without the deleted row.
   */
  suppressedRoles?: Iterable<BookDirectLineRole>
}

export interface BookDirectPayloadLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  dimensions?: Record<string, string>
}

const DEFAULT_SETTLEMENT_ACCOUNT = '1930'
/** Ingående moms, the same default the dialog seeded before this module existed. */
const INPUT_VAT_ACCOUNT = '2641'

function isGeneratedRole(role: BookDirectLineRole | undefined): role is BookDirectLineRole {
  return role === 'cost' || role === 'vat' || role === 'settlement'
}

/**
 * Same default as the dialog's `targetCurrency`: missing currency is SEK,
 * and 'sek' / 'Sek' match SEK. Any other code is a foreign document.
 */
function documentCurrency(extracted: InvoiceExtractionResult | null): string {
  return (extracted?.invoice?.currency ?? 'SEK').toUpperCase()
}

/** Positive öre, or null when the figure cannot be a canonical total or a VAT amount. */
function positiveOre(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const rounded = roundOre(value)
  if (!Number.isFinite(rounded) || rounded <= 0) return null
  return rounded
}

function oreString(amount: number): string {
  return String(amount)
}

function generatedLine(
  role: BookDirectLineRole,
  account: string,
  debit: string,
  credit: string,
): BookDirectFormLine {
  return {
    role,
    account_number: account,
    debit_amount: debit,
    credit_amount: credit,
    generated_account: account,
  }
}

/**
 * Two generated legs with no amounts. Used when the canonical total is
 * missing, non-finite, or not positive, so a later valid total can still
 * find the cost and settlement rows by role. Accounts stay blank: there is
 * no figure to settle yet.
 */
function unresolvedPair(): BookDirectFormLine[] {
  return [
    generatedLine('cost', '', '', ''),
    generatedLine('settlement', '', '', ''),
  ]
}

function canonicalTotal(
  extracted: InvoiceExtractionResult | null,
  selectedTransactionAmount: number | null,
): number | null {
  // A chosen transaction replaces the document total even when the figure
  // itself is unusable. Falling through to the document would hide that.
  if (selectedTransactionAmount != null) {
    if (typeof selectedTransactionAmount !== 'number' || !Number.isFinite(selectedTransactionAmount)) {
      return null
    }
    return positiveOre(Math.abs(selectedTransactionAmount))
  }
  return positiveOre(extracted?.totals?.total ?? null)
}

/**
 * Extracted input VAT for a SEK document, in öre. Foreign documents return
 * null (reverse charge is the common case; the user adds that row). The
 * amount is the extracted figure, never a share of a different total.
 */
function sekDocumentVat(
  extracted: InvoiceExtractionResult | null,
  currency: string,
): number | null {
  if (currency !== 'SEK') return null
  return positiveOre(extracted?.totals?.vatAmount ?? null)
}

/**
 * Generated cost, VAT and settlement rows for one document and one optional
 * canonical SEK total (the selected transaction's kronor amount).
 */
export function buildBookDirectPrefillLines(
  extracted: InvoiceExtractionResult | null,
  selectedTransactionAmount: number | null = null,
  bankAccount: string = DEFAULT_SETTLEMENT_ACCOUNT,
  options: BookDirectPrefillOptions = {},
): BookDirectFormLine[] {
  const suppressed = new Set<BookDirectLineRole>(options.suppressedRoles ?? [])
  // Seller VAT is cost for a non-registered company (reverse charge never
  // reaches this prefill: a foreign document gets no VAT row anyway), and a
  // VAT row the user deleted is not split out again.
  const splitVat = !sellerVatIsCost(options.vatRegistered, false) && !suppressed.has('vat')
  const lines = generatedPrefillLines(
    extracted,
    canonicalTotal(extracted, selectedTransactionAmount),
    bankAccount,
    splitVat,
  )
  if (suppressed.size === 0) return lines
  return lines.filter((line) => !isGeneratedRole(line.role) || !suppressed.has(line.role))
}

function generatedPrefillLines(
  extracted: InvoiceExtractionResult | null,
  total: number | null,
  bankAccount: string,
  splitVat: boolean,
): BookDirectFormLine[] {
  if (total == null) return unresolvedPair()

  const vat = splitVat ? sekDocumentVat(extracted, documentCurrency(extracted)) : null
  const settlement = generatedLine('settlement', bankAccount, '', oreString(total))

  // VAT above the total cannot produce a cost debit. Leave the cost amount
  // empty so the entry stays unbalanced and the dialog's submit check stops
  // it, instead of dropping the VAT row to force a balance.
  if (vat != null && vat > total) {
    return [
      generatedLine('cost', '', '', ''),
      generatedLine('vat', INPUT_VAT_ACCOUNT, oreString(vat), ''),
      settlement,
    ]
  }

  const vatAmount = vat ?? 0
  const net = roundOre(total - vatAmount)
  if (!Number.isFinite(net) || net < 0) {
    return [
      generatedLine('cost', '', '', ''),
      ...(vat != null ? [generatedLine('vat', INPUT_VAT_ACCOUNT, oreString(vat), '')] : []),
      settlement,
    ]
  }

  const lines: BookDirectFormLine[] = [
    generatedLine('cost', '', oreString(net), ''),
  ]
  if (vat != null) {
    lines.push(generatedLine('vat', INPUT_VAT_ACCOUNT, oreString(vat), ''))
  }
  lines.push(settlement)
  return lines
}

function copyDimensions(line: BookDirectFormLine): Pick<BookDirectFormLine, 'dimensions'> {
  if (line.dimensions === undefined) return {}
  return { dimensions: { ...line.dimensions } }
}

function cloneManual(line: BookDirectFormLine): BookDirectFormLine {
  return {
    account_number: line.account_number,
    debit_amount: line.debit_amount,
    credit_amount: line.credit_amount,
    ...copyDimensions(line),
  }
}

function cloneGeneratedDefault(line: BookDirectFormLine): BookDirectFormLine {
  return {
    role: line.role,
    account_number: line.account_number,
    debit_amount: line.debit_amount,
    credit_amount: line.credit_amount,
    ...(line.generated_account !== undefined ? { generated_account: line.generated_account } : {}),
    ...copyDimensions(line),
  }
}

/** True while the row still shows the account the generator wrote. */
function followsGeneratedAccount(line: BookDirectFormLine): boolean {
  return line.account_edited !== true
    && line.generated_account !== undefined
    && line.account_number === line.generated_account
}

function mergeGenerated(existing: BookDirectFormLine, next: BookDirectFormLine): BookDirectFormLine {
  const follow = followsGeneratedAccount(existing)
  const merged: BookDirectFormLine = {
    role: next.role,
    account_number: follow ? next.account_number : existing.account_number,
    debit_amount: next.debit_amount,
    credit_amount: next.credit_amount,
    ...(follow
      ? (next.generated_account !== undefined ? { generated_account: next.generated_account } : {})
      : (existing.generated_account !== undefined ? { generated_account: existing.generated_account } : {})),
    ...copyDimensions(existing),
  }
  if (existing.account_edited === true) merged.account_edited = true
  return merged
}

/**
 * Apply a newly computed prefill onto the rows the user is editing.
 *
 * Generated legs match by role. A role the current rows do not have gets
 * the new default, not the account or dimensions of a neighbour. A role the
 * new prefill does not have is dropped, and its account and dimensions go
 * with it. Manual rows (no role) stay after the generated legs, unchanged.
 * A row the user deleted must not come back as a missing role: build `next`
 * with that role in `suppressedRoles`.
 *
 * A line set with no generated roles at all is user-owned: an applied
 * template, or every generated row deleted and only manual rows left. The
 * receipt prefill does not replace it and does not invent roles from 2641
 * or a 19xx account.
 */
export function reconcileBookDirectLines(
  current: BookDirectFormLine[],
  next: BookDirectFormLine[],
): BookDirectFormLine[] {
  const manual: BookDirectFormLine[] = []
  const byRole = new Map<BookDirectLineRole, BookDirectFormLine>()
  for (const line of current) {
    if (isGeneratedRole(line.role)) {
      if (!byRole.has(line.role)) byRole.set(line.role, line)
      continue
    }
    manual.push(line)
  }

  if (byRole.size === 0 && manual.length > 0) return current

  const generated = next.map((line) => {
    if (!isGeneratedRole(line.role)) return cloneManual(line)
    const existing = byRole.get(line.role)
    if (!existing) return cloneGeneratedDefault(line)
    return mergeGenerated(existing, line)
  })
  return [...generated, ...manual.map(cloneManual)]
}

/**
 * Record an edit from the account/amount inputs. An account commit sets
 * `account_edited` even when the committed number equals the generated
 * default, so a later cash-account resolution cannot replace it.
 */
export function withExplicitAccountEdit(
  line: BookDirectFormLine,
  patch: Partial<Pick<BookDirectFormLine, 'account_number' | 'debit_amount' | 'credit_amount'>>,
): BookDirectFormLine {
  const next: BookDirectFormLine = { ...line }
  if (patch.debit_amount !== undefined) next.debit_amount = patch.debit_amount
  if (patch.credit_amount !== undefined) next.credit_amount = patch.credit_amount
  if (patch.account_number !== undefined) {
    next.account_number = patch.account_number
    next.account_edited = true
  }
  return next
}

/**
 * History suggestion for the empty generated cost leg. Manual, template and
 * already-filled cost rows are left alone, including a cost the user cleared.
 */
export function applyCostAccountSuggestion(
  lines: BookDirectFormLine[],
  account: string,
): BookDirectFormLine[] {
  const trimmed = account.trim()
  if (!trimmed) return lines
  const idx = lines.findIndex(
    (line) => line.role === 'cost' && line.account_edited !== true && line.account_number.trim() === '',
  )
  if (idx < 0) return lines
  return lines.map((line, index) => (index === idx ? { ...line, account_number: trimmed } : line))
}

/** Template rows are manual: no role, no generated account, no provenance. */
export function manualBookDirectLines(
  rows: ReadonlyArray<Pick<BookDirectFormLine, 'account_number' | 'debit_amount' | 'credit_amount'>>,
): BookDirectFormLine[] {
  return rows.map((row) => ({
    account_number: row.account_number,
    debit_amount: row.debit_amount,
    credit_amount: row.credit_amount,
  }))
}

/** Account, amounts and dimensions only. Role and provenance stay in the client. */
export function toBookDirectPayloadLine(line: BookDirectFormLine): BookDirectPayloadLine {
  const payload: BookDirectPayloadLine = {
    account_number: line.account_number.trim(),
    debit_amount: parseFloat(line.debit_amount) || 0,
    credit_amount: parseFloat(line.credit_amount) || 0,
  }
  if (line.dimensions && Object.keys(line.dimensions).length > 0) {
    payload.dimensions = line.dimensions
  }
  return payload
}

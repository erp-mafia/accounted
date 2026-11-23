import type { CreateJournalEntryLineInput, VatDeclarationRutor } from '@/types'
import {
  generateReverseChargePurchaseLines,
  isReverseChargeBasisAccount,
  isReverseChargeKind,
  reverseChargeKindForBasisAccount,
  reverseChargeKindRuta,
  RC_BASIS_BOXES,
  RC_BASIS_OFFSET_ACCOUNT,
  REVERSE_CHARGE_KINDS,
  REVERSE_CHARGE_TREATMENT_KINDS,
  type ChartVatTreatments,
  type ReverseChargeKind,
} from './vat-entries'
import type { FieldIssue } from '@/lib/errors/refusal'
import {
  defaultRateForVatTreatment,
  isAccountVatTreatment,
  resolveVatTreatmentRuta,
  type AccountVatTreatment,
} from '@/lib/vat/account-vat-treatment'
import { getBoxForAccount } from '@/lib/vat/moms-box-mapping'
import { rcBasisAccountRate } from '@/lib/reports/vat-filing-gate'
import { roundOre } from '@/lib/money'

/**
 * The momskod of a konteringsrad in the manual verifikat form (crm#1096).
 *
 * The momsdeklaration reads account numbers, never a per-line tag
 * (ACCOUNT_RUTA in lib/reports/vat-declaration.ts plus the chart's own
 * momskoder; journal_entry_lines.tax_code is read by nothing). So a momskod on
 * a line cannot be stored and honoured later: it has to become the lines that
 * put the purchase in its rutor. Every other booking surface already does that
 * for a reverse-charge purchase through generateReverseChargePurchaseLines
 * (bank categorisation, supplier invoices, booking templates, mapping rules):
 * the fiktiv-moms pair (2645|2647 D / 26x4 K, rutor 30-32 and 48) plus the
 * basis pair (44xx|45xx D / 4598 K, rutor 20-24). This module wires that one
 * producer to a form line; no VAT formula lives here.
 *
 * The line's account decides what a momskod may be (vatCodeRuleForAccount),
 * read from the chart row exactly as the declaration reads it: an account that
 * reports its own ruta 20-24 fixes the box and the rate, so the momskod only
 * adds the fiktiv moms beside it; an ordinary cost account takes any kind and
 * rate, and the basis pair books the box.
 *
 * Only reverse-charge purchases are offered. Their generated lines net to zero
 * inside the verifikat (2645 = 26x4, 45xx = 4598), so a momskod never changes
 * an amount the user typed or the balance. An ordinary domestic purchase has
 * no base ruta (its 2641 line is its whole declaration effect) and its moms
 * line changes what the verifikat pays, so it stays a line the user types,
 * as before.
 *
 * The v1 voucher API and the MCP tool create_voucher take the same momskod
 * as a line's vat_code, expanded here by expandVoucherLineVatCodes.
 */

/** The self-assessed rates the producer has basis accounts for. */
export const VOUCHER_LINE_VAT_RATES = [0.25, 0.12, 0.06] as const
export type VoucherLineVatRate = (typeof VOUCHER_LINE_VAT_RATES)[number]

/** Huvudregeln: what a newly chosen momskod starts on (resolveReverseChargeRate's default). */
export const DEFAULT_VOUCHER_LINE_VAT_RATE: VoucherLineVatRate = 0.25

/** The purchase types offered, in momsdeklaration order (ruta 20, 21, 22, 24). */
export const VOUCHER_LINE_VAT_KINDS: readonly ReverseChargeKind[] = REVERSE_CHARGE_KINDS

export interface VoucherLineVatCode {
  kind: ReverseChargeKind
  rate: VoucherLineVatRate
}

export function isVoucherLineVatRate(value: unknown): value is VoucherLineVatRate {
  return (VOUCHER_LINE_VAT_RATES as readonly unknown[]).includes(value)
}

/**
 * The part of a form line this module reads. Amounts are the form's input
 * strings. `vat_code` is what the user chose: a code, null for switched off,
 * undefined for no choice (the line follows its account, see
 * groupVoucherLinesWithVatCodes).
 */
export interface VoucherVatCodeLine {
  account_number: string
  debit_amount: string
  credit_amount: string
  vat_code?: VoucherLineVatCode | null
}

/** The chart_of_accounts columns the rule reads. */
export interface VoucherVatCodeAccountRow {
  default_vat_treatment?: string | null
  default_vat_rate?: number | string | null
}

/** Chart row per account number; undefined for an account the chart does not hold. */
export type VoucherVatCodeRowLookup = (accountNumber: string) => VoucherVatCodeAccountRow | null | undefined

/** A generated line, in the form's string shape so it renders and submits like a typed one. */
export interface GeneratedVoucherLine {
  account_number: string
  debit_amount: string
  credit_amount: string
  line_description: string
}

/** The momsdeklaration boxes of a reverse-charge basis (ruta 20-24, RC_BASIS_BOXES). */
export type RcBasisBox = 'ruta20' | 'ruta21' | 'ruta22' | 'ruta23' | 'ruta24'

/** A purchase cost account: BAS class 4-6, the 4598 offset included. */
const COST_ACCOUNT = /^[4-6]\d{3}$/

/**
 * The accounts a purchase is paid or owed on: 19xx bank and cash, 20xx owner
 * accounts (egna insättningar), 24xx-25xx and 27xx-29xx liabilities
 * (leverantörsskulder, a card or an owner's account in 28xx).
 */
const PURCHASE_SETTLEMENT_ACCOUNT = /^(19|20|24|25|27|28|29)\d{2}$/

/**
 * What a momskod may be on a line, decided by its account:
 *  - none: no momskod. Not a purchase cost account (BAS class 4-6), the 4598
 *    offset itself, an account that reports another purchase box (trepartshandel
 *    ruta 37, the import basis ruta 50), or one whose own reverse-charge
 *    momskod carries no self-assessment rate.
 *  - fixed: the account reports its own ruta 20-24: a BAS basis account (4531
 *    is tjänster utanför EU at 25 %) or a class 4-6 account whose kontoplan
 *    momskod is a reverse-charge purchase. Box and rate are the account's
 *    (`code`, `box`): the momskod only adds the fiktiv moms beside it. Another
 *    kind would leave the base in the account's box, and another rate would
 *    break the per-rate basis/moms identity the declaration checks.
 *  - free: an ordinary cost account. Any kind and rate; the basis pair books the box.
 */
export type VoucherLineVatCodeRule =
  | { mode: 'none' }
  | { mode: 'free' }
  | { mode: 'fixed'; code: VoucherLineVatCode; box: RcBasisBox }

const NO_VAT_CODE: VoucherLineVatCodeRule = { mode: 'none' }
const ANY_VAT_CODE: VoucherLineVatCodeRule = { mode: 'free' }

/**
 * The account momskoder that name a reverse-charge purchase, as the kind the
 * producer books. reverse_charge_domestic maps to domestic_services: on such
 * an account the kind only picks the 2647 input leg, since the account
 * reports its own ruta 23/24.
 */
const PURCHASE_KIND_BY_TREATMENT: Partial<Record<AccountVatTreatment, ReverseChargeKind>> = {
  ...REVERSE_CHARGE_TREATMENT_KINDS,
  reverse_charge_domestic: 'domestic_services',
}

/**
 * The box a debit on the account reports, as the declaration resolves it: a
 * configured momskod decides (resolveVatTreatmentRuta), otherwise the fixed
 * BAS map (ACCOUNT_TO_BOX; ACCOUNT_RUTA reads the same VAT_ACCOUNT_TABLE).
 */
function purchaseBox(accountNumber: string, treatment: string | null): keyof VatDeclarationRutor | null {
  if (isAccountVatTreatment(treatment)) {
    return resolveVatTreatmentRuta(treatment, Number(accountNumber.charAt(0)), accountNumber)?.box ?? null
  }
  const box = getBoxForAccount(accountNumber)
  return box ? (`ruta${box}` as keyof VatDeclarationRutor) : null
}

/**
 * The momskod an account with its own ruta 20-24 stands for: a configured
 * reverse-charge purchase code at the rate the declaration buckets the
 * account's basis at (the configured momssats, else the treatment's default,
 * as resolveEffectiveVatRate resolves it), or an unconfigured BAS basis
 * account read by its number.
 */
function ownVatCode(accountNumber: string, row: VoucherVatCodeAccountRow | null | undefined): VoucherLineVatCode | null {
  const treatment = row?.default_vat_treatment ?? null
  if (isAccountVatTreatment(treatment)) {
    const kind = PURCHASE_KIND_BY_TREATMENT[treatment]
    if (!kind) return null
    const configured = row?.default_vat_rate == null ? null : Number(row.default_vat_rate)
    const rate = configured ?? defaultRateForVatTreatment(treatment, Number(accountNumber.charAt(0)))
    return isVoucherLineVatRate(rate) ? { kind, rate } : null
  }
  const basis = reverseChargeKindForBasisAccount(accountNumber)
  if (basis && isVoucherLineVatRate(basis.rate)) return { kind: basis.kind, rate: basis.rate }
  // The basis accounts left are domestic goods (4415-4417, ruta 23): no
  // producer kind of their own, and 2647 is still their input leg.
  const goodsRate = rcBasisAccountRate(accountNumber)
  return goodsRate ? { kind: 'domestic_services', rate: goodsRate } : null
}

/** See VoucherLineVatCodeRule. `row` is the account's chart row; null or undefined when the chart holds none. */
export function vatCodeRuleForAccount(
  accountNumber: string,
  row: VoucherVatCodeAccountRow | null | undefined,
): VoucherLineVatCodeRule {
  if (!COST_ACCOUNT.test(accountNumber) || accountNumber === RC_BASIS_OFFSET_ACCOUNT) return NO_VAT_CODE
  const box = purchaseBox(accountNumber, row?.default_vat_treatment ?? null)
  if (box === null) return ANY_VAT_CODE
  if (!RC_BASIS_BOXES.has(box)) return NO_VAT_CODE
  const code = ownVatCode(accountNumber, row)
  return code ? { mode: 'fixed', code, box: box as RcBasisBox } : NO_VAT_CODE
}

/**
 * Why a reverse-charge purchase cannot have its cost booked on `account`, or
 * null when it can. The utlägg and bank categorization ask this, read from
 * the account's chart row as vatCodeRuleForAccount reads it. A purchase cost
 * account (BAS class 4-6) that takes no momskod would get the basis pair
 * beside a box of its own, declaring the purchase a second time:
 *
 *  - basis_offset: 4598, the basis pair's own offset, is no cost account.
 *  - other_box: the account reports a box outside ruta 20-24 itself (`box`):
 *    trepartshandel ruta 37 or the import basis ruta 50, by its number or
 *    its momskod. Such a purchase is no omvänd betalningsskyldighet at all.
 *  - no_rate: the account's reverse-charge momskod has no momssats of 25, 12
 *    or 6 %, so the declaration buckets its basis at none.
 *
 * And one with its own ruta 20-24 can carry only that box:
 *
 *  - other_kind: the account reports its own ruta 20-24 (`box`) for another
 *    purchase (`kind`) than the one stated, so the purchase would land in a
 *    box other than the one asked. Only a `statedKind` is compared: without
 *    one the account's own box is the purchase's.
 *
 * Any other account takes the purchase: an ordinary cost account, or one
 * outside class 4-6, with the basis pair; one with its own box without it.
 */
export type ReverseChargeAccountConflict =
  | { reason: 'basis_offset' }
  | { reason: 'other_box'; box: keyof VatDeclarationRutor }
  | { reason: 'no_rate' }
  | { reason: 'other_kind'; box: RcBasisBox; kind: ReverseChargeKind }

/** See ReverseChargeAccountConflict. `row` is the account's chart row; null or undefined when the chart holds none. */
export function reverseChargeAccountConflict(
  account: string,
  row: VoucherVatCodeAccountRow | null | undefined,
  statedKind?: ReverseChargeKind,
): ReverseChargeAccountConflict | null {
  const rule = vatCodeRuleForAccount(account, row)
  if (rule.mode === 'fixed') {
    return statedKind && statedKind !== rule.code.kind ? { reason: 'other_kind', box: rule.box, kind: rule.code.kind } : null
  }
  if (rule.mode === 'free' || !COST_ACCOUNT.test(account)) return null
  if (account === RC_BASIS_OFFSET_ACCOUNT) return { reason: 'basis_offset' }
  // vatCodeRuleForAccount's two other ways to none: a box outside 20-24, or
  // one inside them with no own code (its momskod has no Swedish rate).
  const box = purchaseBox(account, row?.default_vat_treatment ?? null)
  return box && !RC_BASIS_BOXES.has(box) ? { reason: 'other_box', box } : { reason: 'no_rate' }
}

/** The box the purchase's base lands in: the account's own on a fixed account, the kind's basis box otherwise. */
export function vatCodeBasisBox(rule: VoucherLineVatCodeRule, code: VoucherLineVatCode): RcBasisBox {
  return rule.mode === 'fixed' ? rule.box : reverseChargeKindRuta(code.kind)
}

/**
 * The code a line keeps when its account changes: a code chosen on an
 * ordinary cost account stays when the new account is one too (correcting
 * 6540 to 6541 must not drop the self-assessment), otherwise the line follows
 * the new account again.
 */
export function vatCodeAfterAccountChange(
  current: VoucherLineVatCode | null | undefined,
  next: VoucherLineVatCodeRule,
): VoucherLineVatCode | undefined {
  return next.mode === 'free' && current ? current : undefined
}

function parseAmount(value: string): number {
  return roundOre(parseFloat(value) || 0)
}

/**
 * The lines `code` generates on a line, in the engine's shape: the producer
 * run on the line's amount, which IS the beskattningsunderlag (the seller
 * charged no VAT, and the form's amounts are SEK). No basis pair on a fixed
 * account: it reports the base itself. A credit-side line, a credit note,
 * mirrors every generated line, reversing the self-assessment as a supplier
 * credit note does. Empty without a positive amount or on a 'none' account.
 */
export function vatCodeLinesForLine(
  line: Pick<VoucherVatCodeLine, 'debit_amount' | 'credit_amount'>,
  rule: VoucherLineVatCodeRule,
  code: VoucherLineVatCode,
): CreateJournalEntryLineInput[] {
  if (rule.mode === 'none') return []
  const debit = parseAmount(line.debit_amount)
  const credit = parseAmount(line.credit_amount)
  const base = debit > 0 ? debit : credit
  if (!(base > 0)) return []
  const generated = generateReverseChargePurchaseLines({
    base,
    rate: code.rate,
    kind: code.kind,
    basisBase: rule.mode === 'fixed' ? 0 : base,
  })
  if (debit > 0) return generated
  return generated.map((l) => ({ ...l, debit_amount: l.credit_amount, credit_amount: l.debit_amount }))
}

function toFormShape(line: CreateJournalEntryLineInput): GeneratedVoucherLine {
  return {
    account_number: line.account_number,
    debit_amount: line.debit_amount > 0 ? String(line.debit_amount) : '',
    credit_amount: line.credit_amount > 0 ? String(line.credit_amount) : '',
    line_description: line.line_description ?? '',
  }
}

export interface VoucherLineGroup<T extends VoucherVatCodeLine> {
  line: T
  rule: VoucherLineVatCodeRule
  /** The momskod that applies to the line, null when none does. */
  code: VoucherLineVatCode | null
  generated: GeneratedVoucherLine[]
  /**
   * Accounts the line's chosen momskod generates that another line also books
   * by hand: the purchase would be declared twice, so the form refuses to save.
   */
  conflicts: string[]
}

/**
 * Whether the typed lines book a purchase themselves, the condition for an
 * account's own code to switch on by itself: some line credits an account the
 * purchase is paid or owed on (PURCHASE_SETTLEMENT_ACCOUNT) and no line
 * credits a class 4-6 account, 4598 included. An omföring between boxes or
 * cost accounts (4535 D / 4531 K, 4531 D / 5420 K), a basis-only correction
 * (4535 D / 4598 K) and an accrual release (4531 D / 1790 K) book no
 * purchase: the purchase and its fiktiv moms sit in another verifikat, so the
 * account's own code there would declare rutor 30 and 48 a second time. A
 * purchase with a typed 45xx / 4598 pair counts as none either: by its lines
 * it cannot be told from a basis-only correction beside a payment (a copied
 * supplier invoice whose fiktiv pair folded into another line's code).
 *
 * A rule on the shape of the lines, not on what they are for: an upplupen
 * kostnad booked on 4531 against 2990 has the shape of a purchase.
 */
function linesBookPurchase(lines: readonly VoucherVatCodeLine[]): boolean {
  let settled = false
  for (const line of lines) {
    if (!(parseAmount(line.credit_amount) > 0)) continue
    if (COST_ACCOUNT.test(line.account_number)) return false
    if (PURCHASE_SETTLEMENT_ACCOUNT.test(line.account_number)) settled = true
  }
  return settled
}

/**
 * Every form line with the lines its momskod generates. The generated lines
 * are derived on each render, never stored, so they follow the line's amount,
 * account and momskod and cannot go stale or be added twice. The verifikat
 * that is reviewed and posted is the groups flattened in order: each generated
 * set directly under the line it belongs to.
 *
 * A momskod chosen in the menu applies as chosen (on a fixed account only its
 * on/off counts), whatever else the verifikat books. With no choice made, a
 * fixed account switches itself on (crm#1096): picking 4531, or an account
 * whose kontoplan momskod is reverse charge, adds its fiktiv moms under the
 * debit, but only when the typed lines book the purchase themselves
 * (linesBookPurchase), so omföringar, basis-only corrections and accrual
 * releases stay without it. Lines handed in (the bank picker, a proposal,
 * Kopiera) are judged by the same rule as typed ones. It also stays off on a
 * credit, and while another line books one of the accounts it would generate
 * by hand (a hand-built verifikat, a proposal's own fiktiv lines). Wherever it
 * stays off, the menu still switches it on.
 *
 * `rowOf` null: the chart is not known yet, and no line takes a momskod.
 */
export function groupVoucherLinesWithVatCodes<T extends VoucherVatCodeLine>(
  lines: readonly T[],
  rowOf: VoucherVatCodeRowLookup | null,
): Array<VoucherLineGroup<T>> {
  const typedCount = new Map<string, number>()
  for (const line of lines) {
    if (line.account_number) typedCount.set(line.account_number, (typedCount.get(line.account_number) ?? 0) + 1)
  }
  const booksPurchase = linesBookPurchase(lines)

  return lines.map((line) => {
    const rule = rowOf ? vatCodeRuleForAccount(line.account_number, rowOf(line.account_number)) : NO_VAT_CODE
    const none: VoucherLineGroup<T> = { line, rule, code: null, generated: [], conflicts: [] }
    if (rule.mode === 'none' || line.vat_code === null) return none

    const bookedByHand = (account: string) =>
      (typedCount.get(account) ?? 0) - (account === line.account_number ? 1 : 0) > 0

    if (line.vat_code) {
      const code = rule.mode === 'fixed' ? rule.code : line.vat_code
      if (!isReverseChargeKind(code.kind) || !isVoucherLineVatRate(code.rate)) return none
      const generated = vatCodeLinesForLine(line, rule, code)
      const conflicts = [...new Set(generated.map((l) => l.account_number).filter(bookedByHand))]
      return { line, rule, code, generated: generated.map(toFormShape), conflicts }
    }

    // No choice made: a fixed account's own code on a purchase, before the
    // line's amount too, so it shows from the moment the account is picked.
    if (rule.mode !== 'fixed' || parseAmount(line.credit_amount) > 0 || !booksPurchase) return none
    if (vatCodeAccounts(rule, rule.code).some(bookedByHand)) return none
    const generated = vatCodeLinesForLine(line, rule, rule.code)
    return { line, rule, code: rule.code, generated: generated.map(toFormShape), conflicts: [] }
  })
}

/** The accounts a code generates on a line of this rule, whatever its amount. */
function vatCodeAccounts(rule: VoucherLineVatCodeRule, code: VoucherLineVatCode): string[] {
  return vatCodeLinesForLine({ debit_amount: '1', credit_amount: '' }, rule, code).map((l) => l.account_number)
}

/** Every account a chosen momskod generates while another line books it by hand. */
export function vatCodeConflictAccounts(groups: ReadonlyArray<{ conflicts: readonly string[] }>): string[] {
  return [...new Set(groups.flatMap((group) => group.conflicts))].sort()
}

/** The extra fields a stored line can carry that a generated line never has. */
export interface FoldableVoucherLine extends VoucherVatCodeLine {
  line_description?: string
  tax_code?: string | null
  currency?: string
  dimensions?: Record<string, string>
}

function isGeneratedCopy(typed: FoldableVoucherLine, generated: CreateJournalEntryLineInput): boolean {
  return typed.account_number === generated.account_number
    && parseAmount(typed.debit_amount) === generated.debit_amount
    && parseAmount(typed.credit_amount) === generated.credit_amount
    && (typed.line_description ?? '') === (generated.line_description ?? '')
    && typed.vat_code === undefined
    && !typed.tax_code
    && !typed.currency
    && (!typed.dimensions || Object.keys(typed.dimensions).length === 0)
}

/**
 * A saved draft, or a Kopiera copy of a verifikat this form posted, carries
 * what a momskod generated as ordinary lines, since the code itself is never
 * stored. Folds each such set back into its line's momskod so it follows the
 * line again: a line followed directly by exactly the lines vatCodeLinesForLine
 * gives for one code (accounts, amounts and the producer's descriptions, no
 * dimensions) takes that code and loses those lines. The verifikat it posts
 * is unchanged. Anything else stays as typed, which in practice includes the
 * reverse-charge lines other producers hand in: a bank proposal puts them
 * after the bank leg with blank descriptions, and a categorised verifikat
 * (and the inbox proposal built the same way) has them above its cost line.
 *
 * `stored`: the lines are a saved draft being edited, which keeps its shape:
 * an account with its own box that the draft booked without its fiktiv moms
 * stays without it instead of switching itself on.
 *
 * Returns `lines` itself when nothing changes.
 */
export function foldGeneratedVatLines<T extends FoldableVoucherLine>(
  lines: T[],
  rowOf: VoucherVatCodeRowLookup,
  options: { stored?: boolean } = {},
): T[] {
  const out: T[] = []
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const rule = vatCodeRuleForAccount(line.account_number, rowOf(line.account_number))
    if (rule.mode === 'none' || line.vat_code !== undefined) {
      out.push(line)
      continue
    }
    const candidates: VoucherLineVatCode[] = rule.mode === 'fixed'
      ? [rule.code]
      : VOUCHER_LINE_VAT_KINDS.flatMap((kind) => VOUCHER_LINE_VAT_RATES.map((rate) => ({ kind, rate })))
    const match = candidates
      .map((code) => ({ code, expected: vatCodeLinesForLine(line, rule, code) }))
      .find(({ expected }) =>
        expected.length > 0
        && i + expected.length < lines.length
        && expected.every((g, k) => isGeneratedCopy(lines[i + 1 + k], g)))
    if (match) {
      out.push({ ...line, vat_code: match.code })
      i += match.expected.length
      changed = true
    } else if (options.stored && rule.mode === 'fixed') {
      out.push({ ...line, vat_code: null })
      changed = true
    } else {
      out.push(line)
    }
  }
  return changed ? out : lines
}

/**
 * A voucher line as the v1 voucher API and the MCP tool create_voucher take
 * it: the engine's line plus an optional momskod (crm#1096).
 */
export interface VatCodedVoucherLine extends CreateJournalEntryLineInput {
  vat_code?: VoucherLineVatCode | null
}

/** The verifikat expandVoucherLineVatCodes posts, or why a line's momskod cannot post as asked. */
export type ExpandedVoucherLines =
  | { ok: true; lines: CreateJournalEntryLineInput[] }
  | { ok: false; refusals: FieldIssue[] }

function withoutVatCode({ vat_code: _vatCode, ...line }: VatCodedVoucherLine): CreateJournalEntryLineInput {
  return line
}

/** A generated line in the engine's shape again, parsed as the form's submit parses it. */
function toEngineShape(line: GeneratedVoucherLine): CreateJournalEntryLineInput {
  return {
    account_number: line.account_number,
    debit_amount: parseAmount(line.debit_amount),
    credit_amount: parseAmount(line.credit_amount),
    line_description: line.line_description,
  }
}

const vatCodeText = (code: VoucherLineVatCode) => `{"kind":"${code.kind}","rate":${code.rate}}`

/**
 * Why a requested momskod cannot post as asked, in both languages, or null
 * when it can. The form needs none of this: its menu offers no code on an
 * account that takes none and only on or off on an account with its own box,
 * and it shows a conflict instead of posting it.
 */
function vatCodeRefusal(
  account: string,
  group: VoucherLineGroup<VoucherVatCodeLine>,
  requested: VoucherLineVatCode,
): Omit<FieldIssue, 'field'> | null {
  if (!isReverseChargeKind(requested.kind) || !isVoucherLineVatRate(requested.rate)) {
    const shape = `{"kind": ${VOUCHER_LINE_VAT_KINDS.join(' | ')}, "rate": ${VOUCHER_LINE_VAT_RATES.join(' | ')}}`
    return { en: `vat_code must be ${shape}.`, sv: `Momskoden måste vara ${shape}.` }
  }
  const { rule } = group
  if (rule.mode === 'none') {
    return COST_ACCOUNT.test(account) && account !== RC_BASIS_OFFSET_ACCOUNT
      ? {
          en: `Account ${account} takes no vat_code: it reports a momsruta outside 20-24 (trepartshandel, import), or its reverse-charge momskod in the kontoplan has no momssats of 25, 12 or 6 %.`,
          sv: `Konto ${account} kan inte ha en momskod: det redovisar en momsruta utanför 20-24 (trepartshandel, import), eller så har dess momskod för omvänd moms ingen momssats på 25, 12 eller 6 % i kontoplanen.`,
        }
      : {
          en: `Account ${account} takes no vat_code: reverse charge (omvänd moms) goes on the purchase's cost account (BAS class 4-6, never 4598).`,
          sv: `Konto ${account} kan inte ha en momskod: omvänd moms anges på inköpets kostnadskonto (BAS-klass 4-6, aldrig 4598).`,
        }
  }
  if (rule.mode === 'fixed' && (requested.kind !== rule.code.kind || requested.rate !== rule.code.rate)) {
    const box = rule.box.replace('ruta', '')
    const rate = Math.round(rule.code.rate * 100)
    return {
      en: `Account ${account} reports ruta ${box} at ${rate} % itself, so its only vat_code is ${vatCodeText(rule.code)}. Send that, or book the purchase on an ordinary cost account to choose another.`,
      sv: `Konto ${account} redovisar själv ruta ${box} med ${rate} %, så dess enda momskod är ${vatCodeText(rule.code)}. Ange den, eller bokför inköpet på ett vanligt kostnadskonto för att välja en annan.`,
    }
  }
  if (group.generated.length === 0) {
    return {
      en: 'A vat_code needs a debit or credit amount on its line: that amount is the beskattningsunderlag.',
      sv: 'En momskod kräver ett belopp i debet eller kredit på raden: beloppet är beskattningsunderlaget.',
    }
  }
  if (group.conflicts.length > 0) {
    const accounts = vatCodeConflictAccounts([group]).join(', ')
    return {
      en: `The vat_code creates ${accounts} itself and the voucher also books ${accounts} on lines of its own: the purchase would be counted twice. Remove the vat_code or those lines; if they are another purchase, book it in a voucher of its own.`,
      sv: `Momskoden skapar ${accounts} själv och verifikatet bokför också ${accounts} på egna rader: köpet skulle räknas två gånger. Ta bort momskoden eller de raderna; är de ett annat inköp bokförs det i ett eget verifikat.`,
    }
  }
  return null
}

const rutaAtRate = (box: string, rate: number) => {
  const text = `ruta ${box.replace('ruta', '')}`
  const percent = Math.round(rate * 100)
  return { en: `${text} at ${percent} %`, sv: `${text} med ${percent} %` }
}

/**
 * Why the basis pair of a requested code would not declare what was asked, or
 * null when it does. The producer books the pair on the BAS basis account of
 * the kind and rate (4426 for domestic services at 12 %), and the declaration
 * and its basis check read that account as they read every account: by its
 * kontoplan momskod and momssats when it has them, by its number otherwise
 * (fetchDynamicVatAccounts). So where a company has set the basis account to
 * another box or sats, the basis would land there, away from the fiktiv moms
 * the same code books, and the verifikat would be one the momsdeklaration
 * flags (rutor 30-32 without their basis). The form and the bank doors share
 * the producer and still post it; a request that names its ruta is refused.
 */
function basisAccountRefusal(
  group: VoucherLineGroup<VoucherVatCodeLine>,
  requested: VoucherLineVatCode,
  rowOf: VoucherVatCodeRowLookup,
): Omit<FieldIssue, 'field'> | null {
  const account = group.generated.find((line) => isReverseChargeBasisAccount(line.account_number))?.account_number
  if (!account) return null
  const reports = vatCodeRuleForAccount(account, rowOf(account))
  const box = vatCodeBasisBox(group.rule, requested)
  if (reports.mode === 'fixed' && reports.box === box && reports.code.rate === requested.rate) return null
  const asked = rutaAtRate(box, requested.rate)
  const actual = reports.mode === 'fixed'
    ? rutaAtRate(reports.box, reports.code.rate)
    : { en: 'no ruta 20-24 at 25, 12 or 6 %', sv: 'ingen ruta 20-24 med 25, 12 eller 6 %' }
  return {
    en: `The vat_code books its basis on ${account}, which the kontoplan sets to report ${actual.en}, not ${asked.en}: the purchase would be declared in another ruta or momssats than asked. Correct the momskod and momssats of ${account} in the kontoplan, or book the purchase on an account that reports ${asked.en} itself.`,
    sv: `Momskoden bokför underlaget på ${account}, som enligt kontoplanen redovisar ${actual.sv}, inte ${asked.sv}: inköpet skulle deklareras i en annan ruta eller momssats än den begärda. Rätta momskod och momssats på ${account} i kontoplanen, eller bokför inköpet på ett konto som självt redovisar ${asked.sv}.`,
  }
}

/**
 * The verifikat a voucher request posts (crm#1096): each line followed by the
 * lines its vat_code generates, derived by groupVoucherLinesWithVatCodes, the
 * derivation the manual verifikat form posts, so the form, the v1 voucher
 * routes and the MCP tool create_voucher cannot book one momskod differently.
 *
 * Explicit only: a line without a vat_code generates nothing, also on an
 * account with its own box (4531), where the form switches the account's code
 * on by itself. An integration posts the lines it sends unless it asks for
 * more, as it always has.
 *
 * A code that cannot post as asked is refused per line (field
 * `lines.N.vat_code`), never adjusted: a code on an account that takes none;
 * on an account with its own box, any code but the account's own (the form
 * books the account's code whatever was chosen, an API caller is told which
 * one would post); a code on a line without an amount; the form's conflict
 * rule, a code beside lines that book the accounts it creates by hand; and a
 * code whose basis account the kontoplan sets to another box or sats
 * (basisAccountRefusal). With `loadNames`, a basis account the company renamed
 * to something else takes the company's own basis account, or is refused
 * (renamedBasisAccounts, crm#1453).
 *
 * `loadChart` (chartVatTreatmentsLoader on the server) runs only when a line
 * carries a code: the kontoplan's momskoder decide each account's rule, read
 * as the momsdeklaration reads them.
 */
/**
 * Words a reverse-charge basis account's name carries in every chart we have
 * seen (BAS, Fortnox, Visma, English and truncated imports): the region or the
 * reverse charge itself. A name without any of them ("Förråd - studio och
 * location", "Säkerhet") is the company's own account that reuses the BAS
 * number for something else (crm#1453).
 */
const BASIS_NAME_VOCABULARY =
  /\b(?:eu|eg)\b|eu-|utanf|utom|import|impo\b|omv|reverse|countr|sverige|\bsv\b|byggmoms|ueu|fr(?:å|a)n (?:ett|annat)|\bfr annat|förvärv|forvarv/i

/** Whether a kontoplan name reads as a reverse-charge basis account (BASIS_NAME_VOCABULARY). */
export function namesReverseChargeBasis(accountName: string): boolean {
  return BASIS_NAME_VOCABULARY.test(accountName)
}

/** Account names by number for the accounts asked, as the kontoplan holds them (absent: not in the chart). */
export type AccountNamesLoader = (accounts: readonly string[]) => Promise<ReadonlyMap<string, string>>

/**
 * Where the basis pair of each line goes when the BAS basis account is one
 * the company renamed to something else (crm#1453): the company's own basis
 * account for the same box and rate (a class 4-6 account whose momskod
 * reports it and whose name reads as a basis account), or a refusal when it
 * has none. An unconfigured account is read by its number in the
 * momsdeklaration either way; this only stops the producer from posting the
 * basis onto an account the company uses for something else.
 */
async function renamedBasisAccounts(
  groups: ReadonlyArray<VoucherLineGroup<VoucherVatCodeLine>>,
  chart: ChartVatTreatments,
  loadNames: AccountNamesLoader,
): Promise<{ substitutes: Map<string, string>; refusals: FieldIssue[] }> {
  const substitutes = new Map<string, string>()
  const refusals: FieldIssue[] = []
  const basisAccounts = [...new Set(groups.flatMap((group) =>
    group.generated.map((line) => line.account_number).filter((account) =>
      isReverseChargeBasisAccount(account) && !chart.has(account))))]
  if (basisAccounts.length === 0) return { substitutes, refusals }

  const candidates = [...chart.keys()].filter((account) =>
    COST_ACCOUNT.test(account) && account !== RC_BASIS_OFFSET_ACCOUNT && !isReverseChargeBasisAccount(account) &&
    vatCodeRuleForAccount(account, chart.get(account)).mode === 'fixed')
  const names = await loadNames([...basisAccounts, ...candidates])
  const renamed = new Set<string>()
  for (const account of basisAccounts) {
    const name = names.get(account)
    // Not in the chart: the booking activates it from BAS, with its BAS meaning.
    if (name === undefined || namesReverseChargeBasis(name)) continue
    const reports = vatCodeRuleForAccount(account, undefined)
    const own = reports.mode === 'fixed'
      ? candidates.find((candidate) => {
          const rule = vatCodeRuleForAccount(candidate, chart.get(candidate))
          return rule.mode === 'fixed' && rule.box === reports.box && rule.code.rate === reports.code.rate &&
            namesReverseChargeBasis(names.get(candidate) ?? '')
        })
      : undefined
    if (own) substitutes.set(account, own)
    else renamed.add(account)
  }
  groups.forEach((group, index) => {
    const account = group.generated.find((line) => renamed.has(line.account_number))?.account_number
    if (!account) return
    const box = (vatCodeRuleForAccount(account, undefined) as { box?: string }).box?.replace('ruta', '') ?? '20-24'
    const name = names.get(account) ?? ''
    refusals.push({
      field: `lines.${index}.vat_code`,
      en: `The vat_code books its basis (ruta ${box}) on ${account}, but the kontoplan names ${account} "${name}", not a reverse-charge basis account, and no other account reports ruta ${box}: the basis would land on an account used for something else. If ${account} is not used for anything else, rename it to its BAS meaning; otherwise give an account of your own the reverse-charge momskod for ruta ${box} in the kontoplan and book the purchase on it.`,
      sv: `Momskoden bokför underlaget (ruta ${box}) på ${account}, men i kontoplanen heter ${account} "${name}" och är inget konto för underlag vid omvänd moms, och inget annat konto redovisar ruta ${box}: underlaget skulle hamna på ett konto som används till annat. Används ${account} inte till något annat, byt tillbaka namnet till BAS-betydelsen; annars ge ett eget konto momskoden för omvänd moms i ruta ${box} i kontoplanen och bokför inköpet på det.`,
    })
  })
  return { substitutes, refusals }
}

export async function expandVoucherLineVatCodes(
  lines: readonly VatCodedVoucherLine[],
  loadChart: () => Promise<ChartVatTreatments>,
  loadNames?: AccountNamesLoader,
): Promise<ExpandedVoucherLines> {
  const typed = lines.map(withoutVatCode)
  if (!lines.some((line) => line.vat_code)) return { ok: true, lines: typed }

  const chart = await loadChart()
  const rowOf: VoucherVatCodeRowLookup = (account) => chart.get(account)
  const groups = groupVoucherLinesWithVatCodes<VoucherVatCodeLine>(
    lines.map((line) => ({
      account_number: line.account_number,
      debit_amount: String(line.debit_amount || 0),
      credit_amount: String(line.credit_amount || 0),
      // A line without a code is switched off: never the account's own code by itself.
      vat_code: line.vat_code ?? null,
    })),
    rowOf,
  )

  const refusals: FieldIssue[] = []
  groups.forEach((group, index) => {
    const requested = lines[index].vat_code
    const refusal = requested
      ? vatCodeRefusal(lines[index].account_number, group, requested) ?? basisAccountRefusal(group, requested, rowOf)
      : null
    if (refusal) refusals.push({ field: `lines.${index}.vat_code`, ...refusal })
  })
  if (refusals.length > 0) return { ok: false, refusals }

  const renamed = loadNames ? await renamedBasisAccounts(groups, chart, loadNames) : null
  if (renamed && renamed.refusals.length > 0) return { ok: false, refusals: renamed.refusals }
  const basisOn = (account: string) => renamed?.substitutes.get(account) ?? account

  return {
    ok: true,
    lines: groups.flatMap((group, index) => [
      typed[index],
      ...group.generated.map((line) => toEngineShape({ ...line, account_number: basisOn(line.account_number) })),
    ]),
  }
}

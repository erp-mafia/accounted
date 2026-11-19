import type { SupabaseClient } from '@supabase/supabase-js'
import type { BookingTemplateLibrary, BookingTemplateLibraryLine, VatTreatment } from '@/types'
import type { BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import {
  isReverseChargeBasisLeg,
  isReverseChargeVatAccount,
  RC_BASIS_OFFSET_ACCOUNT,
} from '@/lib/bookkeeping/vat-entries'
import { rcBasisAccountRate } from '@/lib/reports/vat-filing-gate'
import { isCashLedger } from '@/lib/bookkeeping/bank-leg'
import { mergeDimensionBags } from '@/lib/bookkeeping/dimension-resolver'
import { formatAmountInput, roundOre } from '@/lib/money'
import { grossVat, netVat, treatmentForRate } from '@/lib/bookkeeping/gross-split'
import {
  resolveSkattekontoAccount,
  templateSkattekontoAccount,
  templateTouchesSkattekonto,
  type SkattekontoLedgerAccount,
} from '@/lib/skatteverket/skattekonto-account'

/**
 * Prefix for library template ids when they are mapped into the
 * static BookingTemplate shape used by the transaction picker.
 */
export const LIBRARY_TEMPLATE_PREFIX = 'library:'
export function isLibraryTemplateId(id: string): boolean { return id.startsWith(LIBRARY_TEMPLATE_PREFIX) }

/** Whether a library template's lines name the skattekonto (1630). */
export function libraryLinesTouchSkattekonto(lines: ReadonlyArray<BookingTemplateLibraryLine> | null | undefined): boolean {
  return templateTouchesSkattekonto((lines ?? []).map((l) => l.account))
}

/**
 * A system library template (a pack: "Insättning skattekonto", "Momsbetalning
 * via skattekonto", F-skatt, AGI) names the skattekonto as 1630; for a
 * company that runs its skattekonto on 2012 it books 2012 (PH 175). Applied
 * where a company reads or books a system template; a company's own template
 * keeps the accounts its author wrote.
 */
export function libraryLinesForSkattekonto(
  lines: BookingTemplateLibraryLine[],
  skattekontoAccount: SkattekontoLedgerAccount | undefined,
): BookingTemplateLibraryLine[] {
  if (!skattekontoAccount || !libraryLinesTouchSkattekonto(lines)) return lines
  return lines.map((l) => ({ ...l, account: templateSkattekontoAccount(l.account, skattekontoAccount) }))
}

/**
 * libraryLinesForSkattekonto with this company's skattekonto account, read
 * (resolveSkattekontoAccount, which throws when it cannot be read) only when
 * the lines name the skattekonto; any other lines come back as they are.
 */
export async function libraryLinesForCompanySkattekonto(
  supabase: SupabaseClient,
  companyId: string,
  lines: BookingTemplateLibraryLine[],
): Promise<BookingTemplateLibraryLine[]> {
  return libraryLinesTouchSkattekonto(lines)
    ? libraryLinesForSkattekonto(lines, await resolveSkattekontoAccount(supabase, companyId))
    : lines
}

/**
 * Convert a template's line pattern + total amount into form lines
 * ready for the JournalEntryForm.
 *
 * The algorithm:
 *   1. VAT lines on ordinary accounts: amount = totalAmount × vat_rate / (1 + vat_rate)
 *      (the total is VAT-inclusive; the VAT is extracted out of it)
 *   2. VAT lines on fiktiv-moms accounts (reverse charge/import, 2614 etc.):
 *      amount = totalAmount × vat_rate. Under omvänd skattskyldighet the
 *      supplier charged no VAT, so the total IS the beskattningsunderlag and
 *      the self-assessed VAT goes on top, netting to zero across the
 *      offsetting 2645/2614 pair. Extracting rate/(1+rate) here understates
 *      Ruta 30-32 and Ruta 48 by rate/(1+rate) (25% became 20%).
 *   3. Settlement lines: amount = totalAmount (the full payment)
 *   4. Business lines: amount = totalAmount × ratio (cost/revenue net of VAT handled separately)
 *   5. Business lines: the line's dimensions bag, when it has one, is copied
 *      onto the form line. A settlement or VAT line never gets one.
 *
 * For simple two-line templates (no VAT), the ratio is typically 1.0
 * on both sides and totalAmount is used directly.
 */
export function applyTemplate(
  lines: BookingTemplateLibraryLine[],
  totalAmount: number,
): FormLine[] {
  const result: FormLine[] = []

  for (const line of lines) {
    let amount = 0

    if (line.type === 'vat' && line.vat_rate) {
      amount = isReverseChargeVatAccount(line.account)
        ? // Self-assessed VAT on top of the base (the total)
          netVat(totalAmount, line.vat_rate)
        : // VAT extracted from the total inclusive amount
          grossVat(totalAmount, line.vat_rate)
    } else if (line.type === 'settlement') {
      amount = roundOre(totalAmount * (line.ratio ?? 1))
    } else {
      // Business lines: use ratio (default 1.0)
      amount = roundOre(totalAmount * (line.ratio ?? 1))
    }

    const formLine: FormLine = {
      account_number: line.account,
      debit_amount: line.side === 'debit' ? formatAmountInput(amount, '.') : '',
      credit_amount: line.side === 'credit' ? formatAmountInput(amount, '.') : '',
      line_description: line.label,
    }
    const dimensions = line.type === 'business' ? mergeDimensionBags(null, line.dimensions) : undefined
    result.push(dimensions ? { ...formLine, dimensions } : formLine)
  }

  return result
}

/**
 * Scope label for displaying where a template comes from.
 */
export function getTemplateScope(template: {
  is_system: boolean
  team_id: string | null
  company_id: string | null
}): 'system' | 'team' | 'company' {
  if (template.is_system) return 'system'
  if (template.team_id) return 'team'
  return 'company'
}

/**
 * The lines without their dimensions: how a team template is stored and
 * edited. A dimension tag is one company's own cost centre or project code,
 * and a team template is booked by every company of the team, so it carries
 * none.
 */
export function linesWithoutDimensions<L extends { dimensions?: unknown }>(
  lines: readonly L[],
): Array<Omit<L, 'dimensions'>> {
  return lines.map(({ dimensions: _dimensions, ...line }) => line)
}

/**
 * Convert a user-created library template to the BookingTemplate shape the
 * transaction TemplatePicker consumes.
 *
 * Only simple shapes (one business line + one settlement line, optionally
 * one VAT line) are returned: complex multi-account templates cannot be
 * expressed as a single debit/credit pair and must be applied via the full
 * journal entry form instead.
 *
 * The id is prefixed with "library:" so downstream code can recognise a
 * library template and look it up through the library APIs rather than the
 * static registry.
 */
export function convertLibraryToBookingTemplate(
  lib: BookingTemplateLibrary,
): BookingTemplate | null {
  if (!Array.isArray(lib.lines)) return null

  const business = lib.lines.filter((l) => l.type === 'business')
  const settlement = lib.lines.filter((l) => l.type === 'settlement')
  const vat = lib.lines.filter((l) => l.type === 'vat')

  if (business.length !== 1 || settlement.length !== 1) return null
  if (business[0].side === settlement[0].side) return null

  const debitLine = business[0].side === 'debit' ? business[0] : settlement[0]
  const creditLine = business[0].side === 'credit' ? business[0] : settlement[0]

  const direction: 'expense' | 'income' = business[0].side === 'debit' ? 'expense' : 'income'

  let vatTreatment: VatTreatment | null = null
  let vatRate = 0
  if (vat.length > 0) {
    const inputVat = vat.find((v) => v.side === 'debit' && v.vat_rate)
      ?? vat.find((v) => v.vat_rate)
    if (inputVat?.vat_rate) {
      const treatment = treatmentForRate(inputVat.vat_rate)
      if (treatment) {
        vatTreatment = treatment
        vatRate = inputVat.vat_rate
      }
    }
    // Reverse-charge is recognised by the presence of 2614/2624/2634 (fictitious output VAT)
    if (vat.some((v) => v.account === '2614' || v.account === '2624' || v.account === '2634')) {
      vatTreatment = 'reverse_charge'
    }
  }

  return {
    id: `${LIBRARY_TEMPLATE_PREFIX}${lib.id}`,
    name_sv: lib.name,
    name_en: lib.name,
    group: 'financial',
    direction,
    entity_applicability: lib.entity_type ?? 'all',
    debit_account: debitLine.account,
    credit_account: creditLine.account,
    vat_treatment: vatTreatment,
    vat_rate: vatRate,
    deductibility: 'full',
    special_rules_sv: lib.description || undefined,
    mcc_codes: [],
    keywords: [],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 0,
    auto_match_confidence: 0,
    default_private: false,
    fallback_category: direction === 'expense' ? 'expense_other' : 'income_services',
    description_sv: lib.description || '',
    common: false,
  }
}

// ---------------------------------------------------------------------------
// Deriving a template from a concrete booking
// ---------------------------------------------------------------------------

/** A single concrete booking row, as produced by the manual-booking forms
 *  (BookDirectlyDialog / JournalEntryForm). Amounts are strings straight from
 *  the inputs; either debit or credit is set, not both. */
export interface BookingRowInput {
  account_number: string
  debit_amount: string
  credit_amount: string
  /** The row's dimensions bag; kept on derived business lines only. */
  dimensions?: Record<string, string>
}

/**
 * The legs of a reverse-charge basis pair booked beside the user's own cost
 * line (45xx D / 4598 K, as a momskod generates it, crm#1096). The pair nets
 * to zero and is no part of the payment: never the total, the settlement leg
 * or one of the shares the cost is split by. Only beside the 4598 offset:
 * without it a 45xx line is the cost line itself.
 */
export function reverseChargeBasisPairLegs(accounts: readonly string[]): (account: string) => boolean {
  const hasOffset = accounts.includes(RC_BASIS_OFFSET_ACCOUNT)
  return (account) => hasOffset && isReverseChargeBasisLeg(account)
}

/**
 * The cost/revenue lines whose ratios split a template's total, as the
 * template editor shows and checks them: the business lines without a
 * basis pair's legs.
 */
export function templateShareLines(lines: BookingTemplateLibraryLine[]): BookingTemplateLibraryLine[] {
  const isBasisPairLeg = reverseChargeBasisPairLegs(lines.map((l) => l.account))
  return lines.filter((l) => l.type === 'business' && !isBasisPairLeg(l.account))
}

/** Standard Swedish VAT rates a template line can carry (matches the rate
 *  selector in the template editor). 0 = no/foreign VAT. */
const STANDARD_VAT_RATES = [0.25, 0.12, 0.06, 0] as const

/**
 * Snap a VAT line's implied rate to the nearest standard rate. For an ordinary
 * VAT line the implied rate is vatAmount / net where net = total − vatAmount
 * (the same relationship applyTemplate inverts: vat = total × rate / (1 + rate)).
 * For a fiktiv-moms line (reverse charge/import) the total IS the base, so the
 * implied rate is vatAmount / total (applyTemplate inverts: vat = total × rate).
 */
function snapVatRate(vatAmount: number, total: number, isReverseCharge: boolean): number {
  const base = isReverseCharge ? total : total - vatAmount
  const implied = base > 0 ? vatAmount / base : 0
  return STANDARD_VAT_RATES.reduce<number>(
    (best, rate) => (Math.abs(rate - implied) < Math.abs(best - implied) ? rate : best),
    0.25,
  )
}

/**
 * The rate of a fiktiv-moms leg read from the basis it was self-assessed on:
 * a reverse-charge basis line (a 45xx/44xx pair leg, or a cost line on 4531
 * and its siblings) whose amount at the account's own rate is the leg's
 * amount, to the öre. A split verifikat books the fiktiv moms on one cost
 * line's share, which the whole total misreads (150 on a 600 share of 1000
 * snapped to 12 %). Null without such a line: the caller snaps against the
 * total.
 */
function fiktivRateFromBasis(
  vatAmount: number,
  rows: ReadonlyArray<{ account: string; amount: number }>,
): number | null {
  for (const row of rows) {
    const rate = rcBasisAccountRate(row.account)
    if (rate !== null && Math.abs(Math.round(netVat(row.amount, rate) * 100) - Math.round(vatAmount * 100)) <= 1) {
      return rate
    }
  }
  return null
}

/**
 * Account number to name for the labels of a template derived from a booking:
 * the company's own chart first, the BAS catalogue for a standard account the
 * company has not activated yet. A company's own account (one that is not in
 * BAS) is only in its chart; read from the catalogue alone its line was
 * labelled with the bare number (crm#1821).
 */
export function templateAccountNames(
  chart: ReadonlyArray<{ account_number: string; account_name: string }>,
  catalog: ReadonlyArray<{ account_number: string; account_name: string }>,
): Record<string, string> {
  const names: Record<string, string> = {}
  for (const a of catalog) names[a.account_number] = a.account_name
  for (const a of chart) {
    if (a.account_name?.trim()) names[a.account_number] = a.account_name
  }
  return names
}

/**
 * Derive amount-parameterised template lines from a concrete, balanced set of
 * booking rows - the inverse of {@link applyTemplate}, used by "Spara som mall".
 *
 * A booking stores literal debit/credit amounts; a template stores ratios of a
 * total plus VAT rates. The mapping:
 *   - total = the larger of Σdebit / Σcredit (equal when the entry balances),
 *     excluding fiktiv-moms legs (reverse charge/import) and a 45xx/4598 basis
 *     pair: they net to zero and are no part of the payment, so counting them
 *     would inflate the total and shrink every derived business ratio
 *   - a 26xx line → a VAT line, its rate snapped to the nearest standard rate;
 *     a fiktiv-moms leg takes the rate of the basis line it was self-assessed
 *     on when the booking has one (fiktivRateFromBasis), else the total's
 *   - the non-VAT line closest to the total → the settlement leg (the bank /
 *     counter account), ratio 1; on a tie the bank or cash line (BAS 19xx)
 *   - every other non-VAT line → a business (cost/revenue) line, ratio = amount/total,
 *     with the row's dimensions bag when it has one; a VAT or settlement
 *     line carries none
 *
 * Which non-VAT leg is tagged settlement vs business does not change the
 * accounts: a template books its literal accounts regardless of the tag (see
 * the "blind to business/settlement tagging" regression), and on a bank
 * transaction only its bank line moves to the transaction's ledger
 * (templateBankLeg). The classification is a best-effort starting point that
 * the user reviews and can re-tag in the editor before saving.
 *
 * Rows without a 4-digit account or with no amount are dropped. Returns [] when
 * fewer than two usable lines remain or the total is non-positive.
 */
export function deriveTemplateLinesFromBooking(
  rows: BookingRowInput[],
  accountNames: Record<string, string> = {},
): BookingTemplateLibraryLine[] {
  const parsed = rows
    .map((row) => {
      const account = row.account_number.trim()
      const debit = Math.abs(parseFloat(row.debit_amount) || 0)
      const credit = Math.abs(parseFloat(row.credit_amount) || 0)
      const side: 'debit' | 'credit' = debit >= credit ? 'debit' : 'credit'
      return { account, side, amount: Math.max(debit, credit), dimensions: mergeDimensionBags(null, row.dimensions) }
    })
    .filter((row) => /^\d{4}$/.test(row.account) && row.amount > 0)

  if (parsed.length < 2) return []

  // A basis pair nets to zero as well: counted, it doubled the total and
  // halved every ratio (crm#1096).
  const isBasisPairLeg = reverseChargeBasisPairLegs(parsed.map((r) => r.account))
  const countsTowardTotal = (r: { account: string }) =>
    !isReverseChargeVatAccount(r.account) && !isBasisPairLeg(r.account)
  const sumDebit = parsed.reduce((s, r) => (r.side === 'debit' && countsTowardTotal(r) ? s + r.amount : s), 0)
  const sumCredit = parsed.reduce((s, r) => (r.side === 'credit' && countsTowardTotal(r) ? s + r.amount : s), 0)
  const total = roundOre(Math.max(sumDebit, sumCredit))
  if (total <= 0) return []

  const isVat = (account: string) => account.startsWith('26')

  // Pick the settlement leg among the non-VAT lines: the one closest to the
  // total, which it takes in full (ratio 1). Equal distances prefer a bank or
  // cash line (BAS 19xx), where the money moved, then a credit leg, then the
  // later row. Without the bank preference 1930 D / 1580 K at one amount
  // tagged the receivable "Betalning" (crm#1321).
  let settlementIndex = -1
  let bestDistance = Infinity
  let bestIsCredit = false
  let bestIsCash = false
  parsed.forEach((row, index) => {
    if (isVat(row.account) || isBasisPairLeg(row.account)) return
    const distance = Math.abs(row.amount - total)
    const isCash = isCashLedger(row.account)
    const isCredit = row.side === 'credit'
    const closer = distance < bestDistance - 0.005
    const tie = Math.abs(distance - bestDistance) <= 0.005
    const tieWins = tie && (isCash !== bestIsCash ? isCash : isCredit || !bestIsCredit)
    if (settlementIndex === -1 || closer || tieWins) {
      settlementIndex = index
      bestDistance = distance
      bestIsCredit = isCredit
      bestIsCash = isCash
    }
  })

  const label = (account: string) => accountNames[account]?.trim() || account

  return parsed.map((row, index) => {
    if (isVat(row.account)) {
      const isFiktiv = isReverseChargeVatAccount(row.account)
      return {
        account: row.account,
        label: label(row.account),
        side: row.side,
        type: 'vat',
        vat_rate: (isFiktiv ? fiktivRateFromBasis(row.amount, parsed) : null)
          ?? snapVatRate(row.amount, total, isFiktiv),
      }
    }
    if (index === settlementIndex) {
      return { account: row.account, label: label(row.account), side: row.side, type: 'settlement', ratio: 1 }
    }
    return {
      account: row.account,
      label: label(row.account),
      side: row.side,
      type: 'business',
      ratio: Math.round((row.amount / total) * 10000) / 10000,
      ...(row.dimensions ? { dimensions: row.dimensions } : {}),
    }
  })
}

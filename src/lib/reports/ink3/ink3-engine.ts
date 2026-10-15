import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { sumOre, truncateToWholeKronor, wholeKronaPercentage } from '@/lib/money'
import {
  SIGN_RECLASSIFICATION_RULES,
  selectReclassifiedAccounts,
  type SignReclassificationId,
} from '@/lib/reports/sign-reclassification'
import {
  filesIncomeReturn,
  resolveCompanyEntityType,
  resultClosingAccounts,
} from '@/lib/company/entity-type'
import {
  listExistingPeriodiseringsfonder,
  resolveSchablonintaktRate,
  SchablonintaktRateNotConfiguredError,
  type ExistingFond,
} from '@/lib/bokslut/reserves/periodiseringsfond-service'
import type { TrialBalanceRow } from '@/types'
import { resolveInk3FieldTable, type Ink3FieldTable } from './field-table'
import { ink3AccountTarget } from './account-mapping'
import {
  ink3Layout,
  INK3_DERIVED_CODES,
  INK3_EXCLUSIVE_PAIRS,
  INK3R_BOOKKEEPING_RESULT,
  INK3R_TAXABLE_RESULT,
  INK3S_CARRIED_RESULT,
  INK3S_PFOND_SCHABLON,
  INK3S_SURPLUS,
} from './layout'
import { loadInk3Inputs } from './inputs'
import type {
  Ink3AccountLine,
  Ink3ClassifiableAccount,
  Ink3Field,
  Ink3FieldSource,
  Ink3FieldValue,
  Ink3Inputs,
  Ink3NeedsInputReason,
  Ink3Treatment,
  Ink3Underlag,
} from './types'

/**
 * INK3 underlag (Inkomstdeklaration 3, ideell förening): per-ruta values for
 * INK3R (balance sheet and both income statement columns), INK3S and
 * INK3SUF, for the user to type into Skatteverket's e-tjänst. Nothing is
 * filed from here and no SRU file is built (founder decision 2026-10-15,
 * delivery path (a)); the `filing` map is the shape an SRU bilaga would
 * reuse later.
 *
 * What is filled from the books and what is the user's:
 *   - INK3R balance sheet (5.1-5.21): the closed books, BAS INK3R coupling,
 *     with the sign reclassification every statutory balance sheet shares.
 *   - INK3R "enligt redovisningen" (6.1-6.19): the books before the
 *     resultatavslut, like INK2R (the closing verifikat would zero them).
 *   - INK3R "som ska tas upp/dras av": the per-account treatment the company
 *     sets (founder decision 2026-10-15, split per account): a taxable
 *     account counts in full, an exempt one not at all, and a shared or
 *     unclassified account leaves the ruta waiting for the user's figure.
 *   - 6.20, 6.21, 7.1, 7.2, 7.9 and 7.10 are the blankett's own sums.
 *   - 7.5a: the schablonintäkt on the periodiseringsfonder at the start of the
 *     year, from the same service and rate table as INK2S 4.6a.
 *   - Everything else on INK3S, and all of INK3SUF, is entered by the user.
 *   - Any ruta except the sums can be overridden.
 *
 * Whether the förening is allmännyttig is the user's statement, never the
 * product's; it decides only whether INK3SUF belongs in the underlag.
 */

export class Ink3WrongLegalFormError extends Error {
  readonly code = 'TAX_DECL_INK3_WRONG_LEGAL_FORM'
  constructor() {
    super('INK3-underlaget gäller bara ideella föreningar.')
    this.name = 'Ink3WrongLegalFormError'
  }
}

/**
 * INK3R boxes each shared sign-reclassification rule moves between (rules in
 * lib/reports/sign-reclassification.ts, shared with INK2R and the K2
 * årsredovisning). A test pins that each rule's range maps to `from`.
 */
export const INK3R_SIGN_RECLASSIFICATION_ROUTES: Record<SignReclassificationId, { from: string; to: string }> = {
  tax_account_credit_to_liability: { from: '8728', to: '8741' },
  tax_liability_debit_to_receivable: { from: '8741', to: '8728' },
  vat_liability_debit_to_receivable: { from: '8743', to: '8728' },
}

/** Truncation residue allowed before two whole-krona totals disagree (SFL 22 kap. 1 §). */
const ROUNDING_TOLERANCE_KR = 2

interface Contribution {
  accountNumber: string
  accountName: string
  /** Raw ledger balance, debit-positive. */
  balance: number
}

interface ResultAccount extends Contribution {
  target: { kind: 'field'; code: string } | { kind: 'net'; plusCode: string; minusCode: string }
}

function toSignedBalances(rows: TrialBalanceRow[]): Map<string, number> {
  const balances = new Map<string, number>()
  for (const row of rows) {
    balances.set(row.account_number, (Number(row.closing_debit) || 0) - (Number(row.closing_credit) || 0))
  }
  return balances
}

/** The result still on the result accounts, credit-positive (profit positive). */
function resultOnResultAccounts(rows: TrialBalanceRow[]): number {
  return sumOre(
    rows
      .filter((row) => row.account_number >= '3' && row.account_number < '9')
      .map((row) => (Number(row.closing_credit) || 0) - (Number(row.closing_debit) || 0)),
  )
}

function isNonZero(amount: number): boolean {
  return Math.abs(amount) >= 0.005
}

/** Add an amount and its account line to a box. */
function addTo(
  sums: Map<string, number>,
  lines: Map<string, Ink3AccountLine[]>,
  code: string,
  line: { accountNumber: string; accountName: string; amount: number; treatment: Ink3Treatment | null },
): void {
  sums.set(code, (sums.get(code) ?? 0) + line.amount)
  const list = lines.get(code) ?? []
  list.push({ ...line, amount: truncateToWholeKronor(line.amount) })
  lines.set(code, list)
}

export interface Ink3EngineInput {
  table: Ink3FieldTable
  inputs: Ink3Inputs
  closedRows: TrialBalanceRow[]
  preClosingRows: TrialBalanceRow[]
  /** The profile's closing account (årets resultat), for the cross-check. */
  closingAccount: string
  /** Periodiseringsfonder with their opening balances, for 7.5a. */
  fonder: ExistingFond[]
  /** The calendar year the räkenskapsår ends in: keys the schablonintäkt rate. */
  closingYear: number
  isClosed: boolean
  hasLinkedClosingEntry: boolean
}

export interface Ink3EngineResult {
  fields: Ink3Field[]
  filing: Record<string, number | string>
  accounts: Ink3ClassifiableAccount[]
  totals: Ink3Underlag['totals']
  complete: boolean
  sufApplicable: boolean
  warnings: string[]
}

/**
 * The pure computation: trial balances, inputs and fonder in, every field out.
 * Split from the database reads so fixtures can drive it directly.
 */
export function computeInk3Underlag(input: Ink3EngineInput): Ink3EngineResult {
  const { table, inputs } = input
  const layout = ink3Layout(table)
  const warnings: string[] = []

  const balanceSheetBalances = toSignedBalances(input.closedRows)
  const incomeBalances = toSignedBalances(input.preClosingRows)
  const names = new Map<string, string>()
  for (const row of [...input.closedRows, ...input.preClosingRows]) names.set(row.account_number, row.account_name)
  const nameOf = (account: string) => names.get(account) || `Konto ${account}`

  // ── Collect each account's contribution ──────────────────────────────
  const balanceContributions = new Map<string, Contribution[]>()
  const resultAccounts: ResultAccount[] = []
  const unmapped: string[] = []
  const allAccounts = [...new Set([...balanceSheetBalances.keys(), ...incomeBalances.keys()])].sort()

  for (const accountNumber of allAccounts) {
    const classChar = accountNumber.charAt(0)
    if (classChar < '1' || classChar > '8') continue
    const isBalanceAccount = classChar === '1' || classChar === '2'
    const balance = isBalanceAccount
      ? (balanceSheetBalances.get(accountNumber) ?? 0)
      : (incomeBalances.get(accountNumber) ?? 0)
    const target = ink3AccountTarget(accountNumber)
    if (target?.kind === 'result') continue
    if (!isNonZero(balance)) continue
    const contribution = { accountNumber, accountName: nameOf(accountNumber), balance }
    if (isBalanceAccount && target?.kind === 'field') {
      const list = balanceContributions.get(target.code) ?? []
      list.push(contribution)
      balanceContributions.set(target.code, list)
    } else if (!isBalanceAccount && target) {
      resultAccounts.push({ ...contribution, target })
    } else {
      unmapped.push(`${accountNumber} (${contribution.accountName})`)
    }
  }
  if (unmapped.length > 0) {
    warnings.push(
      `Konton utan ruta på INK3R enligt BAS kopplingstabell: ${unmapped.join(', ')}. Saldona finns inte med i underlaget; flytta dem till ett konto med ruta eller ange rutans belopp själv.`,
    )
  }

  // Shared sign reclassification: a credit 1630 is a skatteskuld, a debit
  // 25xx or 26xx a fordran. Whole account rows move.
  for (const rule of SIGN_RECLASSIFICATION_RULES) {
    const route = INK3R_SIGN_RECLASSIFICATION_ROUTES[rule.id]
    const moving = new Set(selectReclassifiedAccounts(rule, balanceSheetBalances))
    if (moving.size === 0) continue
    const source = balanceContributions.get(route.from) ?? []
    const moved = source.filter((c) => moving.has(c.accountNumber))
    if (moved.length === 0) continue
    balanceContributions.set(route.from, source.filter((c) => !moving.has(c.accountNumber)))
    balanceContributions.set(route.to, [...(balanceContributions.get(route.to) ?? []), ...moved])
    warnings.push(rule.warning)
  }

  // ── Books: balance sheet and the bookkeeping column ──────────────────
  const bookSums = new Map<string, number>()
  const bookLines = new Map<string, Ink3AccountLine[]>()
  const assets = new Set(layout.assetCodes)
  for (const [code, list] of balanceContributions) {
    for (const c of list) {
      addTo(bookSums, bookLines, code, {
        accountNumber: c.accountNumber,
        accountName: c.accountName,
        amount: assets.has(code) ? c.balance : -c.balance,
        treatment: null,
      })
    }
  }

  const signOf = new Map(layout.incomeStatement.map((row) => [row.code, row.sign]))
  const taxSums = new Map<string, number>()
  const taxLines = new Map<string, Ink3AccountLine[]>()
  const taxWaiting = new Map<string, Ink3NeedsInputReason>()
  const classifiable: Ink3ClassifiableAccount[] = []
  const rutaOf = (code: string) => table.byCode.get(code)?.ruta ?? code

  // A shared or unclassified account leaves the taxable box waiting for the
  // user's figure; unclassified wins, since it is the one to fix first.
  const markWaiting = (code: string | null, treatment: 'shared' | null) => {
    if (!code) return
    if (treatment === null) taxWaiting.set(code, 'unclassified_account')
    else if (taxWaiting.get(code) !== 'unclassified_account') taxWaiting.set(code, 'shared_account')
  }

  const netGroups = new Map<string, { plusCode: string; minusCode: string; members: ResultAccount[] }>()
  for (const account of resultAccounts) {
    const treatment = inputs.accountTreatments[account.accountNumber] ?? null
    if (account.target.kind === 'field') {
      const code = account.target.code
      // A cost is positive in its minus box, an income in its plus box.
      const amount = signOf.get(code) === '-' ? account.balance : -account.balance
      const twin = layout.taxableTwin.get(code) ?? null
      const line = { accountNumber: account.accountNumber, accountName: account.accountName, amount, treatment: twin ? treatment : null }
      addTo(bookSums, bookLines, code, line)
      if (twin) {
        classifiable.push({ accountNumber: account.accountNumber, accountName: account.accountName, ruta: rutaOf(code), amount: truncateToWholeKronor(amount), treatment })
        if (treatment === 'taxable') addTo(taxSums, taxLines, twin, line)
        else if (treatment !== 'exempt') markWaiting(twin, treatment)
      }
    } else {
      const key = `${account.target.plusCode}|${account.target.minusCode}`
      const group = netGroups.get(key) ?? { plusCode: account.target.plusCode, minusCode: account.target.minusCode, members: [] }
      group.members.push(account)
      netGroups.set(key, group)
    }
  }

  for (const group of netGroups.values()) {
    const net = sumOre(group.members.map((m) => -m.balance))
    const toPlus = net >= 0
    const bookCode = toPlus ? group.plusCode : group.minusCode
    const plusTwin = layout.taxableTwin.get(group.plusCode) ?? null
    const minusTwin = layout.taxableTwin.get(group.minusCode) ?? null
    const ruta = rutaOf(group.plusCode) === rutaOf(group.minusCode)
      ? rutaOf(group.plusCode)
      : `${rutaOf(group.plusCode)}/${rutaOf(group.minusCode)}`
    for (const m of group.members) {
      const treatment = inputs.accountTreatments[m.accountNumber] ?? null
      addTo(bookSums, bookLines, bookCode, {
        accountNumber: m.accountNumber,
        accountName: m.accountName,
        amount: toPlus ? -m.balance : m.balance,
        treatment,
      })
      classifiable.push({ accountNumber: m.accountNumber, accountName: m.accountName, ruta, amount: truncateToWholeKronor(-m.balance), treatment })
      if (treatment === null || treatment === 'shared') {
        markWaiting(plusTwin, treatment)
        markWaiting(minusTwin, treatment)
      }
    }
    const taxable = group.members.filter((m) => inputs.accountTreatments[m.accountNumber] === 'taxable')
    if (taxable.length > 0) {
      const taxNet = sumOre(taxable.map((m) => -m.balance))
      const taxCode = taxNet >= 0 ? plusTwin : minusTwin
      if (taxCode) {
        for (const m of taxable) {
          addTo(taxSums, taxLines, taxCode, {
            accountNumber: m.accountNumber,
            accountName: m.accountName,
            amount: taxNet >= 0 ? -m.balance : m.balance,
            treatment: 'taxable',
          })
        }
      }
    }
  }

  // ── Fields, in Skatteverket's order ──────────────────────────────────
  const overrides = inputs.fieldOverrides
  const unknownOverrides = Object.keys(overrides).filter((code) => !table.byCode.has(code) || INK3_DERIVED_CODES.has(code))
  if (unknownOverrides.length > 0) {
    warnings.push(`Sparade värden för fältkod ${unknownOverrides.join(', ')} används inte: koden finns inte för ${table.beskattningsperiod} eller är en summa.`)
  }

  const fields = new Map<string, Ink3Field>()
  const taxableTwins = new Set([...layout.taxableTwin.values()].filter((c): c is string => c !== null))
  const bookCodes = new Set([...layout.assetCodes, ...layout.equityLiabilityCodes, ...layout.incomeStatement.map((r) => r.code)])

  // 7.5a: schablonintäkt on the fonder at the start of the year.
  let schablon: number | null
  try {
    const rate = resolveSchablonintaktRate(input.closingYear, input.fonder)
    const base = sumOre(input.fonder.map((f) => Math.max(0, f.opening_balance)))
    schablon = rate === 0 ? 0 : wholeKronaPercentage(base, rate * 100)
  } catch (err) {
    if (!(err instanceof SchablonintaktRateNotConfiguredError)) throw err
    schablon = null
    warnings.push(
      `Räntesatsen för schablonintäkt på periodiseringsfonder för ${input.closingYear} är inte inlagd. Ange beloppet i ruta 7.5a själv.`,
    )
  }
  if (input.fonder.some((f) => f.balance < f.opening_balance - 0.005)) {
    warnings.push(
      'En periodiseringsfond har återförts under året. Kontrollera om ett uppräknat belopp ska tas upp i ruta 7.5c.',
    )
  }

  const valueOf = (code: string): number => {
    const v = fields.get(code)?.value
    return typeof v === 'number' ? v : 0
  }

  for (const def of table.fields) {
    const override = INK3_DERIVED_CODES.has(def.code) ? undefined : overrides[def.code]
    let computed: number | null = null
    let source: Ink3FieldSource = 'input'
    let accounts: Ink3AccountLine[] = []
    let waiting: Ink3NeedsInputReason | null = null

    if (bookCodes.has(def.code)) {
      computed = truncateToWholeKronor(bookSums.get(def.code) ?? 0)
      accounts = bookLines.get(def.code) ?? []
      source = 'books'
    } else if (taxableTwins.has(def.code)) {
      computed = truncateToWholeKronor(taxSums.get(def.code) ?? 0)
      accounts = taxLines.get(def.code) ?? []
      source = 'books'
      waiting = taxWaiting.get(def.code) ?? null
    } else if (def.code === INK3S_PFOND_SCHABLON) {
      computed = schablon
      source = 'computed'
      waiting = schablon === null ? 'not_computable' : null
    } else if (INK3_DERIVED_CODES.has(def.code)) {
      source = 'computed'
      computed = 0 // filled below, once the parts are known
    }

    const hasOverride = override !== undefined
    const value: Ink3FieldValue | null = hasOverride ? override : computed
    fields.set(def.code, {
      code: def.code,
      blankett: def.blankett,
      ruta: def.ruta,
      label: def.label,
      column: def.column,
      sign: def.sign,
      datatyp: def.datatyp,
      value,
      computed,
      source: hasOverride ? (source === 'input' ? 'input' : 'override') : source,
      overridable: !INK3_DERIVED_CODES.has(def.code),
      needsInput: !hasOverride && waiting !== null,
      needsInputReason: hasOverride ? null : waiting,
      accounts,
    })
  }

  const setSum = (code: string, amount: number) => {
    const field = fields.get(code)
    if (field) {
      field.value = amount
      field.computed = amount
    }
  }

  // 6.20: årets resultat enligt bokföringen, from the final bookkeeping boxes.
  const bookkeepingResult = layout.incomeStatement.reduce(
    (sum, row) => sum + (row.sign === '+' ? valueOf(row.code) : -valueOf(row.code)),
    0,
  )
  setSum(INK3R_BOOKKEEPING_RESULT.profit, Math.max(bookkeepingResult, 0))
  setSum(INK3R_BOOKKEEPING_RESULT.loss, Math.max(-bookkeepingResult, 0))

  // 6.21: the taxable column's result, carried to 7.1/7.2.
  const taxableResult = layout.incomeStatement.reduce((sum, row) => {
    const twin = layout.taxableTwin.get(row.code)
    if (!twin) return sum
    return sum + (row.sign === '+' ? valueOf(twin) : -valueOf(twin))
  }, 0)
  setSum(INK3R_TAXABLE_RESULT.profit, Math.max(taxableResult, 0))
  setSum(INK3R_TAXABLE_RESULT.loss, Math.max(-taxableResult, 0))
  setSum(INK3S_CARRIED_RESULT.profit, Math.max(taxableResult, 0))
  setSum(INK3S_CARRIED_RESULT.loss, Math.max(-taxableResult, 0))

  // 7.9/7.10: rows 7.1-7.8 by their printed sign.
  const taxableSurplus = layout.surplusTerms.reduce((sum, term) => sum + term.factor * valueOf(term.code), 0)
  setSum(INK3S_SURPLUS.profit, Math.max(taxableSurplus, 0))
  setSum(INK3S_SURPLUS.loss, Math.max(-taxableSurplus, 0))

  // ── Checks ───────────────────────────────────────────────────────────
  const totalAssets = layout.assetCodes.reduce((sum, code) => sum + valueOf(code), 0)
  const totalEquityLiabilities = layout.equityLiabilityCodes.reduce((sum, code) => sum + valueOf(code), 0)

  // The result the books give, before any override, for the balance and
  // årets resultat checks.
  const booksResult = layout.incomeStatement.reduce((sum, row) => {
    const amount = truncateToWholeKronor(bookSums.get(row.code) ?? 0)
    return sum + (row.sign === '+' ? amount : -amount)
  }, 0)
  const unclosedResult = resultOnResultAccounts(input.closedRows)
  const resultTransferred = Math.abs(resultOnResultAccounts(input.preClosingRows) - unclosedResult) >= 0.01
  const resultClosedIntoEquity =
    Math.abs(unclosedResult) <= ROUNDING_TOLERANCE_KR && (resultTransferred || input.hasLinkedClosingEntry)
  const adjustedEquityLiabilities = resultTransferred
    ? totalEquityLiabilities + truncateToWholeKronor(unclosedResult)
    : totalEquityLiabilities + booksResult

  if (!input.isClosed) {
    warnings.push('Räkenskapsåret är inte stängt; underlaget kan tas fram, men siffrorna kan ändras om fler bokföringar görs.')
  }
  if (input.closedRows.every((r) => !isNonZero((Number(r.closing_debit) || 0) - (Number(r.closing_credit) || 0)))
    && input.preClosingRows.every((r) => !isNonZero((Number(r.closing_debit) || 0) - (Number(r.closing_credit) || 0)))) {
    warnings.push('Inga bokförda transaktioner hittades för perioden.')
  }
  const balanceDiff = Math.abs(totalAssets - adjustedEquityLiabilities)
  if (balanceDiff > ROUNDING_TOLERANCE_KR && (totalAssets > 0 || adjustedEquityLiabilities > 0)) {
    warnings.push(
      `Balansräkningen är inte i balans. Tillgångar: ${totalAssets} kr, Eget kapital och skulder: ${adjustedEquityLiabilities} kr (differens: ${balanceDiff} kr).`,
    )
  }
  if (resultClosedIntoEquity) {
    const booked = truncateToWholeKronor(-(balanceSheetBalances.get(input.closingAccount) ?? 0))
    if (Math.abs(booked - booksResult) > ROUNDING_TOLERANCE_KR) {
      warnings.push(
        `Årets resultat enligt resultaträkningen (${booksResult} kr) stämmer inte med det bokförda resultatet på konto ${input.closingAccount} (${booked} kr).`,
      )
    }
  }

  for (const field of fields.values()) {
    if (field.datatyp === 'Numeriskt_B' && typeof field.value === 'number' && field.value < 0) {
      warnings.push(
        `Ruta ${field.ruta ?? field.code} (fältkod ${field.code}) blir ${field.value} kr, men rutan tar bara belopp från 0. Kontrollera kontona bakom rutan.`,
      )
    }
  }
  for (const [a, b] of INK3_EXCLUSIVE_PAIRS) {
    if (fields.get(a)?.value === true && fields.get(b)?.value === true) {
      warnings.push(`Fältkod ${a} och ${b} kan inte båda vara ikryssade.`)
    }
  }

  const sufApplicable = inputs.allmannyttig === true
  const waitingFields = [...fields.values()].filter((f) => f.needsInput)
  if (waitingFields.length > 0) {
    warnings.push(
      `${waitingFields.length} ${waitingFields.length === 1 ? 'ruta behöver' : 'rutor behöver'} din bedömning: konton som är delade eller inte klassade, eller ett belopp som inte kan räknas fram.`,
    )
  }
  if (inputs.allmannyttig === null) {
    warnings.push('Ange om föreningen är allmännyttig. Bedömningen är föreningens egen; den avgör om INK3SUF ska lämnas.')
  }

  const filing: Record<string, number | string> = {}
  for (const field of fields.values()) {
    if (field.blankett === 'INK3SUF' && !sufApplicable) continue
    if (typeof field.value === 'number' && field.value !== 0) filing[field.code] = field.value
    else if (field.value === true) filing[field.code] = 'X'
    else if (typeof field.value === 'string' && field.value.trim() !== '') filing[field.code] = field.value
  }

  classifiable.sort((a, b) => a.accountNumber.localeCompare(b.accountNumber))

  return {
    fields: [...fields.values()],
    filing,
    accounts: classifiable,
    totals: {
      totalAssets,
      totalEquityLiabilities: adjustedEquityLiabilities,
      bookkeepingResult,
      taxableResult,
      taxableSurplus,
    },
    complete: inputs.allmannyttig !== null && waitingFields.length === 0,
    sufApplicable,
    warnings,
  }
}

/** Generate the INK3 underlag for a räkenskapsår of an ideell förening. */
export async function generateInk3Underlag(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<Ink3Underlag> {
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end, is_closed, closing_entry_id, opening_balance_entry_id')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()
  if (periodError || !period) throw new Error('Fiscal period not found')

  const { data: settings } = await supabase
    .from('company_settings')
    .select('company_name, org_number, entity_type')
    .eq('company_id', companyId)
    .maybeSingle()
  const entityType = await resolveCompanyEntityType(supabase, companyId, settings?.entity_type)
  if (filesIncomeReturn(entityType) !== 'INK3') throw new Ink3WrongLegalFormError()

  const table = resolveInk3FieldTable(period.period_end as string)

  const [inputs, closed, preClosing, fonder] = await Promise.all([
    loadInk3Inputs(supabase, companyId, fiscalPeriodId),
    generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include' }),
    generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'exclude-final' }),
    listExistingPeriodiseringsfonder(
      supabase,
      companyId,
      period.period_end as string,
      period.period_start as string,
      (period.opening_balance_entry_id as string | null) ?? null,
    ),
  ])

  const result = computeInk3Underlag({
    table,
    inputs,
    closedRows: closed.rows,
    preClosingRows: preClosing.rows,
    closingAccount: resultClosingAccounts(entityType).closing,
    fonder,
    closingYear: parseInt((period.period_end as string).slice(0, 4), 10),
    isClosed: Boolean(period.is_closed),
    hasLinkedClosingEntry: Boolean(period.closing_entry_id),
  })

  return {
    fiscalYear: {
      id: period.id as string,
      name: period.name as string,
      start: period.period_start as string,
      end: period.period_end as string,
      isClosed: Boolean(period.is_closed),
    },
    beskattningsperiod: table.beskattningsperiod,
    fieldTable: {
      beskattningsperiod: table.beskattningsperiod,
      files: table.source.files.map((f) => f.file),
    },
    companyInfo: {
      companyName: settings?.company_name || 'Okänt företag',
      orgNumber: settings?.org_number || null,
    },
    allmannyttig: inputs.allmannyttig,
    sufApplicable: result.sufApplicable,
    fields: result.fields,
    filing: result.filing,
    accounts: result.accounts,
    totals: result.totals,
    complete: result.complete,
    warnings: result.warnings,
  }
}


import type { SupabaseClient } from '@supabase/supabase-js'
import { loadTaxAdjustmentSnapshot } from '@/lib/bokslut/tax-provision/tax-adjustment-service'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import {
  SIGN_RECLASSIFICATION_RULES,
  selectReclassifiedAccounts,
  type SignReclassificationId,
} from '@/lib/reports/sign-reclassification'
import type { FiscalPeriod, TrialBalanceRow } from '@/types'
import type {
  INK2Declaration,
  INK2RRutor,
  INK2Rutor,
  INK2SRutor,
  INK2AccountMapping,
  INK2RSRUCode,
} from './types'
import {
  INK2R_ASSET_CODES,
  INK2R_EQUITY_LIABILITY_CODES,
} from './types'
import { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping } from './account-mappings'

// Re-exported so existing importers (ne-engine, tests) keep their paths.
export { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping }

/**
 * INK2 Declaration Engine
 *
 * Generates INK2 (huvudblankett), INK2R (räkenskapsschema), and INK2S
 * (skattemässiga justeringar) for aktiebolag tax reporting.
 *
 * Account mappings follow the official BAS-to-SRU mapping from
 * bas.se/kontoplaner/sru/ and Skatteverket field code spec.
 *
 * INK2R contains the full balance sheet + income statement.
 * INK2S auto-derives basic fields (result + tax → taxable result), as well as
 * periodiseringsfond and överavskrivningar when those have been posted via the
 * bokslut-dispositions calculators in lib/bokslut/.
 *
 * Balances come from generateTrialBalance, never from a raw journal scan, and
 * the two sides of INK2R read DIFFERENT views of the same period:
 *
 *   - Balance sheet: the closed books. After year-end the resultatavslut has
 *     moved årets resultat into 2099, so fritt eget kapital (7302) is only
 *     right when the closing verifikat is included.
 *   - Income statement: the pre-closing books (excludeFinalClosingEntry). The
 *     resultatavslut zeroes every P&L account against 2099, so including it
 *     collapses the whole resultaträkning to zero, which then cascades into
 *     INK2S 7650/7651 and the taxable result. INK2 is always filed after
 *     bokslut, so that is the normal state, not an edge case.
 *
 * excludeFinalClosingEntry drops only fiscal_periods.closing_entry_id: tax,
 * depreciation and bokslutsdispositioner also carry source_type 'year_end' and
 * must stay on the form (7525, 7528).
 */

/** One mapping per SRU code: pinned by a test in __tests__/ink2-engine.test.ts. */
const MAPPING_BY_CODE = new Map<INK2RSRUCode, INK2AccountMapping>(
  INK2R_ACCOUNT_MAPPINGS.map((mapping) => [mapping.sruCode, mapping]),
)

/**
 * INK2R posts each shared sign-reclassification rule moves between. The rules
 * live in lib/reports/sign-reclassification.ts and are shared with the K2
 * iXBRL årsredovisning so both statutory reports present the same balance
 * sheet. A test pins that every rule's account range really does map to the
 * `from` code below.
 */
const SIGN_RECLASSIFICATION_ROUTES: Record<
  SignReclassificationId,
  { from: INK2RSRUCode; to: INK2RSRUCode }
> = {
  tax_account_credit_to_liability: { from: '7261', to: '7368' },
  tax_liability_debit_to_receivable: { from: '7368', to: '7261' },
  vat_liability_debit_to_receivable: { from: '7369', to: '7261' },
}

/**
 * Truncate to nearest krona (drop öre) per SFL 22 kap. 1 §
 */
function truncateToKrona(value: number): number {
  return value >= 0 ? Math.floor(value) : Math.ceil(value)
}

/**
 * Slack allowed before a difference counts as a real disagreement. Every INK2
 * field is truncated to whole kronor per SFL 22 kap. 1 §, so a few öre of
 * truncation residual can accumulate across the form legitimately.
 */
const ROUNDING_TOLERANCE_KR = 2

/**
 * Check if the balance sheet totals differ beyond the expected rounding tolerance.
 */
export function checkBalanceWarning(totalAssets: number, totalEquityLiabilities: number): string | null {
  const balanceDiff = Math.abs(totalAssets - totalEquityLiabilities)
  if (balanceDiff > ROUNDING_TOLERANCE_KR && (totalAssets > 0 || totalEquityLiabilities > 0)) {
    return `Balansräkningen är inte i balans. Tillgångar: ${totalAssets} kr, Eget kapital och skulder: ${totalEquityLiabilities} kr (differens: ${balanceDiff} kr).`
  }
  return null
}

/** Create zero-initialized INK2R rutor */
function createEmptyINK2RRutor(): INK2RRutor {
  return {
    '7201': 0, '7202': 0, '7214': 0, '7215': 0, '7216': 0, '7217': 0,
    '7230': 0, '7231': 0, '7233': 0, '7232': 0, '7234': 0, '7235': 0,
    '7241': 0, '7242': 0, '7243': 0, '7244': 0, '7245': 0, '7246': 0,
    '7251': 0, '7252': 0, '7261': 0, '7262': 0, '7263': 0,
    '7270': 0, '7271': 0, '7281': 0,
    '7301': 0, '7302': 0,
    '7321': 0, '7322': 0, '7323': 0,
    '7331': 0, '7332': 0, '7333': 0,
    '7350': 0, '7351': 0, '7352': 0, '7353': 0, '7354': 0,
    '7360': 0, '7361': 0, '7362': 0, '7363': 0, '7364': 0,
    '7365': 0, '7366': 0, '7367': 0, '7369': 0, '7368': 0, '7370': 0,
    '7410': 0, '7411': 0, '7412': 0, '7413': 0,
    '7511': 0, '7512': 0, '7513': 0, '7514': 0, '7515': 0, '7516': 0, '7517': 0,
    '7414': 0, '7415': 0, '7423': 0, '7416': 0, '7417': 0,
    '7521': 0, '7522': 0,
    '7524': 0, '7419': 0, '7420': 0, '7525': 0, '7421': 0, '7422': 0,
    '7528': 0,
    '7450': 0, '7550': 0,
  }
}

// Reuse canonical code arrays from types.ts (single source of truth)
const ASSET_CODES = INK2R_ASSET_CODES
const EQUITY_LIABILITY_CODES = INK2R_EQUITY_LIABILITY_CODES

/** One account's contribution to an SRU code, before orientation and truncation. */
interface AccountContribution {
  accountNumber: string
  accountName: string
  /** Raw ledger balance, debit-positive. */
  balance: number
}

/** UB per account from a trial balance, debit-positive. */
function toSignedBalances(rows: TrialBalanceRow[]): Map<string, number> {
  const balances = new Map<string, number>()
  for (const row of rows) {
    balances.set(
      row.account_number,
      (Number(row.closing_debit) || 0) - (Number(row.closing_credit) || 0),
    )
  }
  return balances
}

function findMappingForAccount(accountNumber: string): INK2AccountMapping | null {
  for (const mapping of INK2R_ACCOUNT_MAPPINGS) {
    if (isAccountInMapping(accountNumber, mapping)) return mapping
  }
  return null
}

/**
 * Orient a raw ledger balance to the amount Skatteverket expects in the field.
 * Every INK2R amount is reported positive when the post carries its normal
 * balance; costs are positive on the income statement side.
 */
function orientedAmount(balance: number, mapping: INK2AccountMapping): number {
  if (mapping.normalBalance === 'debit') return balance
  // Credit-normal posts, and 'net' posts where positive means income.
  return -balance
}

/**
 * Relocate balance sheet accounts whose balance deviates from their post's
 * normal side (1630 with a credit is a skatteskuld, 2641 with a debit is a
 * fordran). Whole account rows move, so the per-account breakdown stays
 * consistent with the post totals; for `net` rules the moved rows sum to the
 * deviating net by construction because every account in range moves together.
 */
function applySignReclassifications(
  contributions: Map<INK2RSRUCode, AccountContribution[]>,
  balanceSheetBalances: ReadonlyMap<string, number>,
  warnings: string[],
): void {
  for (const rule of SIGN_RECLASSIFICATION_RULES) {
    const route = SIGN_RECLASSIFICATION_ROUTES[rule.id]
    const moving = new Set(selectReclassifiedAccounts(rule, balanceSheetBalances))
    if (moving.size === 0) continue

    const source = contributions.get(route.from) ?? []
    const moved = source.filter((c) => moving.has(c.accountNumber))
    if (moved.length === 0) continue

    contributions.set(
      route.from,
      source.filter((c) => !moving.has(c.accountNumber)),
    )
    contributions.set(route.to, [...(contributions.get(route.to) ?? []), ...moved])
    warnings.push(rule.warning)
  }
}

/**
 * Whether the resultatavslut has already moved årets resultat into 2099.
 *
 * Mirrors the predicate generateTrialBalance uses to drop the closing entry: a
 * reversed closing entry nets to zero against its storno and has therefore not
 * moved anything.
 */
async function isResultClosedIntoEquity(
  supabase: SupabaseClient,
  companyId: string,
  closingEntryId: string | null | undefined,
): Promise<boolean> {
  if (!closingEntryId) return false
  const { data } = await supabase
    .from('journal_entries')
    .select('status')
    .eq('id', closingEntryId)
    .eq('company_id', companyId)
    .maybeSingle()
  return (data as { status?: string } | null)?.status === 'posted'
}

/**
 * Generate INK2 declaration for a fiscal period
 */
export async function generateINK2Declaration(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string
): Promise<INK2Declaration> {

  // Fetch fiscal period
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (periodError || !period) {
    throw new Error('Fiscal period not found')
  }

  // Fetch company settings
  const { data: settings } = await supabase
    .from('company_settings')
    .select('company_name, org_number, entity_type, address_line1, postal_code, city, email')
    .eq('company_id', companyId)
    .single()

  // Resolve entity_type: prefer company_settings, fall back to companies table (NOT NULL, always reliable)
  let entityType = settings?.entity_type
  if (!entityType) {
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('entity_type')
      .eq('id', companyId)
      .single()
    if (companyError) throw new Error(`Failed to resolve entity type: ${companyError.message}`)
    entityType = company?.entity_type
  }

  if (entityType !== 'aktiebolag') {
    throw new Error('INK2 declaration is only for aktiebolag (limited company)')
  }

  // The balance sheet reads the closed books, the income statement the
  // pre-closing books. See the module docblock for why the two differ.
  const [taxAdjustments, closedTrialBalance, preClosingTrialBalance, resultClosedIntoEquity] =
    await Promise.all([
      loadTaxAdjustmentSnapshot(supabase, companyId, fiscalPeriodId),
      generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include' }),
      generateTrialBalance(supabase, companyId, fiscalPeriodId, {
        closingEntry: 'exclude-final',
      }),
      isResultClosedIntoEquity(supabase, companyId, period.closing_entry_id as string | null),
    ])

  const balanceSheetBalances = toSignedBalances(closedTrialBalance.rows)
  const incomeBalances = toSignedBalances(preClosingTrialBalance.rows)

  const accountNameMap = new Map<string, string>()
  for (const row of [...closedTrialBalance.rows, ...preClosingTrialBalance.rows]) {
    accountNameMap.set(row.account_number, row.account_name)
  }

  const warnings: string[] = []

  // Collect each account's contribution to its SRU code, keeping the raw
  // balance so a reclassified account can be re-oriented under its new code.
  const contributions = new Map<INK2RSRUCode, AccountContribution[]>()
  const allAccountNumbers = new Set([
    ...balanceSheetBalances.keys(),
    ...incomeBalances.keys(),
  ])

  for (const accountNumber of allAccountNumbers) {
    // Skip account 8999: årets resultat is calculated
    if (accountNumber === '8999') continue

    const mapping = findMappingForAccount(accountNumber)

    if (!mapping) {
      // BAS accounts 4500-4599, 4700-4899, and 1300-1310 have no standard SRU
      // mapping. These are unusual and may indicate custom accounts.
      const hasBalance =
        Math.abs(balanceSheetBalances.get(accountNumber) ?? 0) >= 0.01
        || Math.abs(incomeBalances.get(accountNumber) ?? 0) >= 0.01
      const classChar = accountNumber.charAt(0)
      if (hasBalance && classChar >= '1' && classChar <= '8') {
        // Only warn for standard BAS range accounts that weren't mapped
        warnings.push(`Konto ${accountNumber} (${accountNameMap.get(accountNumber) || 'okänt'}) kunde inte mappas till ett SRU-fält.`)
      }
      continue
    }

    const balance =
      mapping.section === 'income_statement'
        ? incomeBalances.get(accountNumber) ?? 0
        : balanceSheetBalances.get(accountNumber) ?? 0
    if (Math.abs(balance) < 0.01) continue

    const list = contributions.get(mapping.sruCode)
    const contribution: AccountContribution = {
      accountNumber,
      accountName: accountNameMap.get(accountNumber) || `Konto ${accountNumber}`,
      balance,
    }
    if (list) {
      list.push(contribution)
    } else {
      contributions.set(mapping.sruCode, [contribution])
    }
  }

  applySignReclassifications(contributions, balanceSheetBalances, warnings)

  // Initialize INK2R rutor and breakdown
  const ink2r = createEmptyINK2RRutor()
  const allCodes = Object.keys(ink2r) as INK2RSRUCode[]
  const breakdown = {} as INK2Declaration['breakdown']
  for (const code of allCodes) {
    breakdown[code] = { accounts: [], total: 0 }
  }

  for (const [code, list] of contributions) {
    const mapping = MAPPING_BY_CODE.get(code)
    if (!mapping) continue
    for (const contribution of list) {
      const amount = orientedAmount(contribution.balance, mapping)
      ink2r[code] += amount
      breakdown[code].accounts.push({
        accountNumber: contribution.accountNumber,
        accountName: contribution.accountName,
        amount: truncateToKrona(amount),
      })
    }
  }

  // Truncate all INK2R rutor to whole kronor
  for (const code of allCodes) {
    ink2r[code] = truncateToKrona(ink2r[code])
    breakdown[code].total = ink2r[code]
  }

  // Calculate totals
  const totalAssets = ASSET_CODES.reduce((sum, code) => sum + ink2r[code], 0)
  const totalEquityLiabilities = EQUITY_LIABILITY_CODES.reduce((sum, code) => sum + ink2r[code], 0)

  // Operating result: revenue minus costs (costs are positive per Skatteverket convention)
  const operatingResult =
    ink2r['7410'] + ink2r['7411'] + ink2r['7412'] + ink2r['7413']
    - ink2r['7511'] - ink2r['7512'] - ink2r['7513'] - ink2r['7514']
    - ink2r['7515'] - ink2r['7516'] - ink2r['7517']

  // Financial items: income minus costs
  const financialItems =
    ink2r['7414'] + ink2r['7415'] + ink2r['7423'] + ink2r['7416'] + ink2r['7417']
    - ink2r['7521'] - ink2r['7522']

  // Bokslutsdispositioner: subtract debit-normal, add credit-normal and net
  const bokslutsdispositioner =
    - ink2r['7524'] + ink2r['7419'] + ink2r['7420'] - ink2r['7525']
    + ink2r['7421'] + ink2r['7422']

  // Result before tax
  const resultBeforeTax = operatingResult + financialItems + bokslutsdispositioner

  // Result after tax (7528 is positive, subtract it)
  const aretsResultat = resultBeforeTax - ink2r['7528']

  // Set årets resultat: vinst (7450) or förlust (7550)
  if (aretsResultat >= 0) {
    ink2r['7450'] = aretsResultat
    ink2r['7550'] = 0
  } else {
    ink2r['7450'] = 0
    ink2r['7550'] = Math.abs(aretsResultat)
  }

  // During an open fiscal year 2099 has no balance yet: the result exists only
  // as the net of the income statement accounts, so add it to make the balance
  // sheet tie out. Once the resultatavslut is posted, 7302 already carries it
  // via 2099 and adding it again would double-count årets resultat.
  const adjustedEquityLiabilities = resultClosedIntoEquity
    ? totalEquityLiabilities
    : totalEquityLiabilities + aretsResultat

  // Fiscal year dates as YYYYMMDD
  const fyStart = (period.period_start as string).replace(/-/g, '')
  const fyEnd = (period.period_end as string).replace(/-/g, '')

  // Build INK2 (huvudblankett)
  // Auto-derive from INK2S result and the saved tax-only adjustments.
  // 7528 is already positive per Skatteverket convention
  const taxAmount = ink2r['7528']
  // INK2/SRU amounts are declared in whole kronor with ören omitted. Use the
  // same whole-krona values in both the adjustment fields and the tax result
  // so the worksheet remains internally consistent.
  const nonDeductibleExpenses = Math.trunc(taxAdjustments.nonDeductibleExpenses)
  const nonTaxableIncome = Math.trunc(taxAdjustments.nonTaxableIncome)
  const taxableResult =
    aretsResultat + taxAmount
    + nonDeductibleExpenses - nonTaxableIncome

  const ink2: INK2Rutor = {
    '7011': fyStart,
    '7012': fyEnd,
    '7104': taxableResult >= 0 ? taxableResult : 0,
    '7114': taxableResult < 0 ? Math.abs(taxableResult) : 0,
  }

  // Build INK2S (skattemässiga justeringar, auto-derived basics only)
  const ink2s: INK2SRutor = {
    '7011': fyStart,
    '7012': fyEnd,
    '7650': aretsResultat >= 0 ? aretsResultat : 0,
    '7750': aretsResultat < 0 ? Math.abs(aretsResultat) : 0,
    '7651': taxAmount, // Skatt (ej avdragsgill)
    '7653': nonDeductibleExpenses,
    '7754': nonTaxableIncome,
    '8020': taxableResult >= 0 ? taxableResult : 0,
    '8021': taxableResult < 0 ? Math.abs(taxableResult) : 0,
  }

  // Add warnings
  if (!(period as FiscalPeriod).is_closed) {
    warnings.push('Räkenskapsåret är inte stängt; deklarationen kan genereras, men siffrorna kan ändras om fler bokföringar görs.')
  }

  if (totalAssets === 0 && totalEquityLiabilities === 0 && ink2r['7410'] === 0) {
    warnings.push('Inga bokförda transaktioner hittades för perioden.')
  }

  const balanceWarning = checkBalanceWarning(totalAssets, adjustedEquityLiabilities)
  if (balanceWarning) {
    warnings.push(balanceWarning)
  }

  // Cross-surface self-check. When the year is closed, the resultaträkning the
  // form reports must equal the årets resultat the books actually carry on 2099,
  // which is also the figure the fastställda årsredovisningen shows. Mirrors the
  // equivalent check in lib/bokslut/ixbrl/k2-mapper.ts so both statutory reports
  // catch the same disagreement.
  //
  // This is the alarm that was missing: when INK2R reported 0 kr against a
  // booked result of 469 542 kr, nothing warned, because the balance sheet
  // still tied out on its own. A customer found it instead.
  if (resultClosedIntoEquity) {
    const bookedResult = truncateToKrona(-(balanceSheetBalances.get('2099') ?? 0))
    const declaredResult = aretsResultat
    if (Math.abs(bookedResult - declaredResult) > ROUNDING_TOLERANCE_KR) {
      warnings.push(
        `Årets resultat enligt resultaträkningen (${declaredResult} kr) stämmer inte med det bokförda resultatet på konto 2099 (${bookedResult} kr). Deklarationen stämmer då inte med det fastställda bokslutet.`,
      )
    }
  }

  return {
    fiscalYear: {
      id: period.id,
      name: period.name,
      start: period.period_start,
      end: period.period_end,
      isClosed: period.is_closed,
    },
    ink2,
    ink2r,
    ink2s,
    breakdown,
    totals: {
      totalAssets,
      totalEquityLiabilities: adjustedEquityLiabilities,
      operatingResult,
      aretsResultat,
    },
    companyInfo: {
      companyName: settings?.company_name || 'Okänt företag',
      orgNumber: settings?.org_number || null,
      addressLine1: settings?.address_line1 || null,
      postalCode: settings?.postal_code || null,
      city: settings?.city || null,
      email: settings?.email || null,
    },
    warnings,
  }
}

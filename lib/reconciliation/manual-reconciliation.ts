import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateARReconciliation } from '@/lib/reports/ar-reconciliation'
import { generateReconciliation as generateSupplierReconciliation } from '@/lib/reports/supplier-reconciliation'
import { generateVacationLiability } from '@/lib/reports/vacation-liability'
import {
  manualAccountKey,
  type BridgeLine,
  type ManualSpecification,
  type ReconciliationAccount,
  type ReconciliationSignoff,
  type ReconciliationStatus,
} from './schemas'

const log = createLogger('reconciliation/manual')

/**
 * The manual adapter: every balance sheet account that has no feed of its
 * own (no bank connection, no Skatteverket sync) but still has to be
 * reconciled and attested for a bokslut (Reko 760/765: each material
 * balanspost against its underlag, documented and signed).
 *
 * The ledger side is the account's balance on the balansdag, computed the way
 * the trial balance computes it: the fiscal period's opening balance plus the
 * movement through the date. It is never an all-history sum: year-end posts
 * an opening-balance verifikat in the new year that re-books every balance
 * account, so summing across periods counts a closed year twice.
 *
 * The outside side comes from a specification the system already keeps
 * (kundreskontra for 1510, leverantörsreskontra for 2440, semesterlöneskuld
 * for 2920/2940) or, for every other account, from the balance the signer
 * states from their underlag when they sign off. The reskontra totals are the
 * open items as they stand today, not as of the balansdag; a per-date
 * reskontra is a follow-up and the bridge label says "idag" until then.
 */

export const BALANCE_TOLERANCE = 0.005

export interface BalanceRow {
  account_number: string
  account_name: string
  opening_balance: number
  movement: number
  closing_balance: number
}

export interface BalanceSheetSnapshot {
  period: { id: string; name: string; period_start: string; period_end: string }
  /** The balansdag the balances are computed through (inclusive). */
  as_of: string
  rows: Map<string, BalanceRow>
}

interface FiscalPeriodRow {
  id: string
  name: string
  period_start: string
  period_end: string
}

/**
 * Class 1-2 balances through `asOfDate`, from the fiscal period that contains
 * the date. Null when no period covers the date (nothing to reconcile there).
 */
export async function loadBalanceSheetSnapshot(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate: string,
): Promise<BalanceSheetSnapshot | null> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('company_id', companyId)
    .lte('period_start', asOfDate)
    .gte('period_end', asOfDate)
    .order('period_start', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Kunde inte hämta räkenskapsår: ${error.message}`)
  const period = data as FiscalPeriodRow | null
  if (!period) return null

  const { rows } = await generateTrialBalance(supabase, companyId, period.id, {
    closingEntry: 'include',
    toDate: asOfDate,
  })
  const map = new Map<string, BalanceRow>()
  for (const r of rows) {
    if (r.account_class !== 1 && r.account_class !== 2) continue
    map.set(r.account_number, {
      account_number: r.account_number,
      account_name: r.account_name,
      opening_balance: roundOre(r.opening_debit - r.opening_credit),
      movement: roundOre(r.period_debit - r.period_credit),
      closing_balance: roundOre(r.closing_debit - r.closing_credit),
    })
  }
  return { period, as_of: asOfDate, rows: map }
}

/** A system-kept specification for one balance account, in ledger sign (debit positive). */
export interface SpecificationProvider {
  key: ManualSpecification['provider']
  label_sv: string
  label_en: string
}

export const SPECIFICATION_PROVIDERS: Record<string, SpecificationProvider> = {
  '1510': { key: 'ar', label_sv: 'Kundreskontra, öppna fakturor', label_en: 'Customer ledger, open invoices' },
  '2440': { key: 'ap', label_sv: 'Leverantörsreskontra, öppna fakturor', label_en: 'Supplier ledger, open invoices' },
  '2920': { key: 'vacation', label_sv: 'Semesterlöneskuld enligt lönekörningar', label_en: 'Vacation liability per payroll runs' },
  '2940': {
    key: 'vacation',
    label_sv: 'Sociala avgifter på semesterlöneskuld enligt lönekörningar',
    label_en: 'Social fees on vacation liability per payroll runs',
  },
}

export type SpecificationAmounts = Map<string, { amount: number; unconverted_fx_count: number }>

/**
 * Compute the specification amounts for the provider accounts, one read per
 * source (the two reskontra tie-outs and the vacation liability). A failed
 * source is logged and left out: the account then reconciles like any manual
 * account (outside unknown) rather than against a wrong number.
 */
export async function loadSpecificationAmounts(
  supabase: SupabaseClient,
  companyId: string,
  snapshot: BalanceSheetSnapshot,
  onlyAccounts?: ReadonlySet<string>,
): Promise<SpecificationAmounts> {
  const out: SpecificationAmounts = new Map()
  const wants = (n: string) => !onlyAccounts || onlyAccounts.has(n)
  const tasks: Array<Promise<void>> = []

  if (wants('1510')) {
    tasks.push(
      generateARReconciliation(supabase, companyId, snapshot.period.id)
        .then((r) => {
          out.set('1510', { amount: roundOre(r.ar_ledger_total), unconverted_fx_count: r.unconverted_fx_count })
        })
        .catch((err) => log.warn('AR specification failed', { companyId, error: String(err) })),
    )
  }
  if (wants('2440')) {
    tasks.push(
      generateSupplierReconciliation(supabase, companyId, snapshot.period.id)
        .then((r) => {
          // Liabilities carry credit balances: negative in ledger sign.
          out.set('2440', { amount: roundOre(-r.supplier_ledger_total), unconverted_fx_count: r.unconverted_fx_count })
        })
        .catch((err) => log.warn('AP specification failed', { companyId, error: String(err) })),
    )
  }
  if (wants('2920') || wants('2940')) {
    const year = Number(snapshot.as_of.slice(0, 4))
    tasks.push(
      generateVacationLiability(supabase, companyId, year)
        .then((r) => {
          if (wants('2920')) out.set('2920', { amount: roundOre(-r.totals.accruedAmount), unconverted_fx_count: 0 })
          if (wants('2940')) out.set('2940', { amount: roundOre(-r.totals.accruedAvgifter), unconverted_fx_count: 0 })
        })
        .catch((err) => log.warn('vacation specification failed', { companyId, error: String(err) })),
    )
  }
  await Promise.all(tasks)
  return out
}

function bridgeFor(
  row: BalanceRow,
  snapshot: BalanceSheetSnapshot,
  specification: ManualSpecification | null,
): BridgeLine[] {
  const lines: BridgeLine[] = []
  if (specification) {
    lines.push({
      key: 'specification',
      label_sv: `${specification.label_sv} (idag)`,
      label_en: `${specification.label_en} (today)`,
      amount: specification.amount,
      count: null,
      items_bucket: null,
    })
  }
  lines.push(
    {
      key: 'opening_balance',
      label_sv: `Ingående balans ${snapshot.period.period_start}`,
      label_en: `Opening balance ${snapshot.period.period_start}`,
      amount: row.opening_balance,
      count: null,
      items_bucket: null,
    },
    {
      key: 'movement',
      label_sv: `Förändring t.o.m. ${snapshot.as_of}`,
      label_en: `Movement through ${snapshot.as_of}`,
      amount: row.movement,
      count: null,
      items_bucket: null,
    },
    {
      key: 'ledger_balance',
      label_sv: `Bokfört på ${row.account_number} per ${snapshot.as_of}`,
      label_en: `Booked on ${row.account_number} as of ${snapshot.as_of}`,
      amount: row.closing_balance,
      count: null,
      items_bucket: null,
    },
  )
  return lines
}

/** Status from an already loaded snapshot and specification map (no reads). */
export function buildManualStatus(
  row: BalanceRow,
  snapshot: BalanceSheetSnapshot,
  specifications: SpecificationAmounts,
): ReconciliationStatus {
  const provider = SPECIFICATION_PROVIDERS[row.account_number]
  const spec = provider ? specifications.get(row.account_number) : undefined
  const specification: ManualSpecification | null =
    provider && spec
      ? {
          provider: provider.key,
          label_sv: provider.label_sv,
          label_en: provider.label_en,
          amount: spec.amount,
          unconverted_fx_count: spec.unconverted_fx_count,
        }
      : null
  const external = specification ? specification.amount : null
  const difference = external == null ? null : roundOre(row.closing_balance - external)
  return {
    account_key: manualAccountKey(row.account_number),
    kind: 'manual',
    account_number: row.account_number,
    currency: 'SEK',
    window: { from: snapshot.period.period_start, to: snapshot.as_of },
    // The balansdag itself: the tiles read "per <date>" from it.
    as_of: `${snapshot.as_of}T00:00:00.000Z`,
    stale: false,
    external_balance: external,
    ledger_balance: row.closing_balance,
    difference,
    // Nothing explains a manual difference but the signer's note.
    unexplained_difference: difference,
    is_reconciled: difference != null && Math.abs(difference) < BALANCE_TOLERANCE,
    bridge: bridgeFor(row, snapshot, specification),
    counts: { proposed: 0, unmatched_external: 0, unmatched_ledger: 0, matched: 0, ignored: 0 },
    skattekonto: null,
    bank: null,
    manual: {
      period_id: snapshot.period.id,
      period_start: snapshot.period.period_start,
      period_end: snapshot.period.period_end,
      opening_balance: row.opening_balance,
      movement: row.movement,
      closing_balance: row.closing_balance,
      specification,
    },
  }
}

async function resolveRow(
  supabase: SupabaseClient,
  companyId: string,
  accountNumber: string,
  snapshot: BalanceSheetSnapshot,
): Promise<BalanceRow | null> {
  const row = snapshot.rows.get(accountNumber)
  if (row) return row
  // No activity in the period: the account is still reconcilable (a zero
  // balance is a claim too) as long as it exists in the company's chart.
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('account_number, account_name, account_class')
    .eq('company_id', companyId)
    .eq('account_number', accountNumber)
    .maybeSingle()
  if (error) throw new Error(`Kunde inte hämta konto: ${error.message}`)
  const account = data as { account_number: string; account_name: string; account_class: number } | null
  if (!account || (account.account_class !== 1 && account.account_class !== 2)) return null
  return {
    account_number: account.account_number,
    account_name: account.account_name,
    opening_balance: 0,
    movement: 0,
    closing_balance: 0,
  }
}

export interface ManualStatusOptions {
  /** The balansdag. Defaults to today. */
  asOf?: string | null
  today?: string
}

/**
 * Status for one manual account. Null when the date falls outside every
 * fiscal period or the account is not a balance account of this company.
 */
export async function getManualReconciliationStatus(
  supabase: SupabaseClient,
  companyId: string,
  accountNumber: string,
  options: ManualStatusOptions = {},
): Promise<ReconciliationStatus | null> {
  const today = options.today ?? new Date().toISOString().slice(0, 10)
  const asOf = options.asOf ?? today
  const snapshot = await loadBalanceSheetSnapshot(supabase, companyId, asOf)
  if (!snapshot) return null
  const row = await resolveRow(supabase, companyId, accountNumber, snapshot)
  if (!row) return null
  const specifications = SPECIFICATION_PROVIDERS[accountNumber]
    ? await loadSpecificationAmounts(supabase, companyId, snapshot, new Set([accountNumber]))
    : new Map()
  return buildManualStatus(row, snapshot, specifications)
}

export interface ListManualAccountsOptions {
  /** The balansdag the list is computed through. */
  asOf: string
  /** Account numbers other adapters already own (cash accounts' ledger accounts, 1630 when the skattekonto is present). */
  exclude: ReadonlySet<string>
  /** Latest active sign-off per account key, as the service already loaded them. */
  signoffs: ReadonlyMap<string, ReconciliationSignoff | null>
  withStatus?: boolean
}

function manualState(
  status: ReconciliationStatus,
  signedOffThrough: string | null,
  asOf: string,
): NonNullable<ReconciliationAccount['status']> {
  // A manual account has no live feed, so the attestation is its state: signed
  // through the balansdag counts as reconciled; otherwise the specification
  // decides, and an account without one is simply not reconciled yet.
  const attested = signedOffThrough != null && signedOffThrough >= asOf
  const state: NonNullable<ReconciliationAccount['status']>['state'] =
    attested || status.is_reconciled ? 'reconciled' : 'open'
  return {
    state,
    as_of: status.as_of,
    unexplained_difference: status.unexplained_difference,
    open_counts: { proposed: 0, unmatched_external: 0, unmatched_ledger: 0 },
  }
}

/**
 * Every balance account with a balance or a movement through the date, plus
 * any account that carries a sign-off, minus the accounts other adapters own.
 * One trial balance read for the balances; one read per specification source.
 */
export async function listManualAccounts(
  supabase: SupabaseClient,
  companyId: string,
  options: ListManualAccountsOptions,
): Promise<ReconciliationAccount[]> {
  const snapshot = await loadBalanceSheetSnapshot(supabase, companyId, options.asOf)
  if (!snapshot) return []
  const withStatus = options.withStatus ?? true

  const candidates = new Map<string, BalanceRow>()
  for (const row of snapshot.rows.values()) {
    if (options.exclude.has(row.account_number)) continue
    if (Math.abs(row.closing_balance) < BALANCE_TOLERANCE && Math.abs(row.movement) < BALANCE_TOLERANCE) continue
    candidates.set(row.account_number, row)
  }
  for (const [key, signoff] of options.signoffs) {
    if (!signoff || !key.startsWith('manual:')) continue
    const accountNumber = key.slice('manual:'.length)
    if (options.exclude.has(accountNumber) || candidates.has(accountNumber)) continue
    const row = snapshot.rows.get(accountNumber) ?? {
      account_number: accountNumber,
      account_name: `Konto ${accountNumber}`,
      opening_balance: 0,
      movement: 0,
      closing_balance: 0,
    }
    candidates.set(accountNumber, row)
  }

  const providerAccounts = new Set([...candidates.keys()].filter((n) => SPECIFICATION_PROVIDERS[n]))
  const specifications =
    withStatus && providerAccounts.size > 0
      ? await loadSpecificationAmounts(supabase, companyId, snapshot, providerAccounts)
      : new Map()

  return [...candidates.values()]
    .sort((a, b) => a.account_number.localeCompare(b.account_number))
    .map((row): ReconciliationAccount => {
      const key = manualAccountKey(row.account_number)
      const signedOffThrough = options.signoffs.get(key)?.through_date ?? null
      const status = withStatus ? buildManualStatus(row, snapshot, specifications) : null
      return {
        account_key: key,
        kind: 'manual',
        account_number: row.account_number,
        name: row.account_name,
        currency: 'SEK',
        logo_url: null,
        source: { type: 'manual', synced_at: null, stale: false },
        status: status ? manualState(status, signedOffThrough, options.asOf) : null,
        superseded_by: null,
        signed_off_through: signedOffThrough,
      }
    })
}

/**
 * The K10 underlag per delägare and inkomstår, from what the company's
 * books and registers hold and what each owner entered (k10_owner_inputs):
 *
 *   - shares at the start of the year: the aktiebok replayed to 31 December
 *     the year before (IL 57:11: the gränsbelopp is for shares owned at the
 *     start of the beskattningsår);
 *   - dividend received in the year: the dividend register's split per
 *     holder, booked or paid, with a betalningsdag in the year (the rule
 *     KU31 uses);
 *   - löneunderlag: the payroll's cash pay the year before (payroll.ts);
 *   - the owner's own cash pay: the payroll employees with the owner's name;
 *   - omkostnadsbelopp: the aktiebok prices plus ovillkorade tillskott
 *     (cost-basis.ts), or the owner's own figure;
 *   - fåmansföretag: the answer confirmed for KU31, else what the aktiebok
 *     suggests.
 *
 * Only natural persons file K10; a company holder is left out. The
 * computation is k10-math.ts. Names and masked identities only.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { roundOre } from '@/lib/money'
import { loadContributions } from '../capital/contributions'
import { loadDistributions, loadDividends } from '../capital/dividends'
import { deriveFamansforetag } from '../capital/famans'
import { loadKu31Settings } from '../capital/ku31'
import { loadRegisterParties } from '../people'
import { loadShareRegisterData } from '../share-register'
import { COST_BASIS_GAP_TEXT_SV, costBasisFromRegister, type CostBasisResult } from './cost-basis'
import { computeK10, type K10Figure, type K10Result } from './k10-math'
import { K10_FIRST_YEAR, k10Parameters, supportedK10Years, type K10Parameters } from './k10-parameters'
import { ownerTaxFailure } from './loans'
import { loadPayrollCashPay, ownPayFromPayroll, type PayrollYear } from './payroll'

export interface K10OwnerInputs {
  saved_dividend_space: number
  cost_basis_override: number | null
  payroll_base_override: number | null
  own_pay_override: number | null
  uses_basic_amount: boolean
  note: string | null
  updated_at: string | null
}

export const EMPTY_K10_INPUTS: K10OwnerInputs = {
  saved_dividend_space: 0,
  cost_basis_override: null,
  payroll_base_override: null,
  own_pay_override: null,
  uses_basic_amount: true,
  note: null,
  updated_at: null,
}

export interface K10OwnerView {
  party_id: string
  name: string
  /** Masked personnummer, never the full one. */
  identity: string | null
  shares_at_start: number
  dividend_received: number
  inputs: K10OwnerInputs
  inputs_saved: boolean
  cost_basis: Pick<CostBasisResult, 'register_amount' | 'contributions_amount' | 'amount' | 'complete' | 'gaps'> & { gaps_sv: string[] }
  own_pay_employees: Array<{ employee_id: string; name: string; amount: number }>
  result: K10Result
  warnings: Array<{ code: string; message_sv: string }>
}

export interface K10YearView {
  income_year: number
  supported: boolean
  supported_years: number[]
  /** Why there is no underlag for the year (unsupported), in Swedish. */
  unsupported_reason_sv: string | null
  parameters: K10Parameters | null
  start_date: string
  famansforetag: { value: boolean; confirmed: boolean; top_four_votes_pct: number }
  total_shares_at_start: number
  payroll: { year: number; total: number; runs: number; opening_balance_amount: number; employees: number }
  owners: K10OwnerView[]
  /** Company holders at the start of the year: no K10 for them. */
  company_holders: Array<{ party_id: string; name: string; shares: number }>
}

function normaliseInputs(row: Record<string, unknown>): K10OwnerInputs {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  return {
    saved_dividend_space: Number(row.saved_dividend_space ?? 0),
    cost_basis_override: num(row.cost_basis_override),
    payroll_base_override: num(row.payroll_base_override),
    own_pay_override: num(row.own_pay_override),
    uses_basic_amount: row.uses_basic_amount !== false,
    note: (row.note as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  }
}

export async function loadK10Inputs(ctx: OperationContext, year: number): Promise<Map<string, K10OwnerInputs>> {
  const { data, error } = await ctx.supabase
    .from('k10_owner_inputs')
    .select('party_id, saved_dividend_space, cost_basis_override, payroll_base_override, own_pay_override, uses_basic_amount, note, updated_at')
    .eq('company_id', ctx.companyId)
    .eq('income_year', year)
  if (error) throw new Error(`k10_owner_inputs read failed: ${error.message}`)
  return new Map(((data ?? []) as Array<Record<string, unknown>>).map((r) => [r.party_id as string, normaliseInputs(r)]))
}

function unsupportedReason(year: number): string {
  if (year < K10_FIRST_YEAR) {
    return `K10-underlaget beräknas med 3:12-reglerna från inkomstår ${K10_FIRST_YEAR} (SFS 2025:1361). För ${year} gäller de tidigare reglerna; använd Skatteverkets K10 för det året.`
  }
  return `Inkomstbasbelopp och statslåneränta för inkomstår ${year} är inte inlagda ännu. Underlaget finns för ${supportedK10Years().join(', ')}.`
}

function figure(amount: number, source: K10Figure['source'], detail_sv: string): K10Figure {
  return { amount: roundOre(amount), source, detail_sv }
}

function payrollDetail(payroll: PayrollYear): string {
  if (payroll.runs === 0 && payroll.opening_balance_amount === 0) return `Inga lönekörningar med betalningsdag ${payroll.year} i Accounted`
  const parts = [`Kontant bruttolön i ${payroll.runs} lönekörningar ${payroll.year} i Accounted`]
  if (payroll.opening_balance_amount > 0) parts.push('med ingående saldon från tidigare lönesystem')
  return parts.join(', ')
}

export async function loadK10Year(ctx: OperationContext, year: number): Promise<K10YearView> {
  const params = k10Parameters(year)
  const startDate = `${year - 1}-12-31`
  const [register, dividends, inputs, payroll, contributions, ku31] = await Promise.all([
    loadShareRegisterData(ctx, startDate),
    loadDividends(ctx.supabase, ctx.companyId),
    loadK10Inputs(ctx, year),
    loadPayrollCashPay(ctx.supabase, ctx.companyId, year - 1),
    loadContributions(ctx),
    loadKu31Settings(ctx, year),
  ])

  const ofYear = dividends.filter((d) => (d.status === 'booked' || d.status === 'paid') && Number(d.payment_date.slice(0, 4)) === year)
  const distributions = await loadDistributions(ctx.supabase, ctx.companyId, ofYear.map((d) => d.id))
  const received = new Map<string, number>()
  for (const list of distributions.values()) for (const row of list) received.set(row.party_id, roundOre((received.get(row.party_id) ?? 0) + row.amount))

  const holders = register.summary.holders
  const totalShares = register.summary.total_shares
  const partyIds = [...new Set([...holders.map((h) => h.party_id), ...received.keys()])]
  const parties = await loadRegisterParties(ctx.companyId, partyIds)
  const derivation = deriveFamansforetag(holders.map((h) => ({ party_id: h.party_id, votes: h.votes })))
  const confirmed = ku31?.famansforetag !== null && ku31?.famansforetag !== undefined

  const owners: K10OwnerView[] = []
  const companyHolders: K10YearView['company_holders'] = []
  for (const partyId of partyIds) {
    const party = parties.get(partyId)
    const holding = holders.find((h) => h.party_id === partyId)
    if (party?.kind === 'company') {
      if (holding) companyHolders.push({ party_id: partyId, name: party.name, shares: holding.shares })
      continue
    }
    const ownerInputs = inputs.get(partyId) ?? EMPTY_K10_INPUTS
    const name = party?.name ?? ''
    const cost = costBasisFromRegister({
      partyId,
      held: holding?.ranges ?? [],
      events: register.events,
      asOf: startDate,
      contributions: contributions.map((c) => ({ party_id: c.party_id, kind: c.kind, conditional: c.conditional, status: c.status, promised_on: c.promised_on, amount: c.amount })),
    })
    const own = ownPayFromPayroll(payroll, name)
    const dividend = received.get(partyId) ?? 0
    const warnings: K10OwnerView['warnings'] = []
    if (!cost.complete && ownerInputs.cost_basis_override === null && (holding?.shares ?? 0) > 0) {
      warnings.push({ code: 'K10_COST_BASIS_INCOMPLETE', message_sv: `Omkostnadsbeloppet kan inte räknas fram helt ur aktieboken. ${cost.gaps.map((g) => COST_BASIS_GAP_TEXT_SV[g]).join(' ')} Ange ditt omkostnadsbelopp.` })
    }
    if (own.employees.length === 0 && ownerInputs.own_pay_override === null && payroll.total > 0) {
      warnings.push({ code: 'K10_OWN_PAY_UNMATCHED', message_sv: `Ingen anställd i lönekörningarna ${year - 1} har namnet ${name || 'på ägaren'}. Ange din och närståendes kontanta lön, annars blir det lönebaserade utrymmet 0 kr.` })
    }
    if (!holding && dividend > 0) {
      warnings.push({ code: 'K10_NO_SHARES_AT_START', message_sv: `Utdelning utan aktier vid årets ingång: aktierna förvärvades under ${year} och ger inget gränsbelopp för året.` })
    }
    const result = params
      ? computeK10({
          params,
          shares_at_start: holding?.shares ?? 0,
          total_shares_at_start: totalShares,
          uses_basic_amount: ownerInputs.uses_basic_amount,
          payroll_base:
            ownerInputs.payroll_base_override !== null
              ? figure(ownerInputs.payroll_base_override, 'owner', 'Ditt belopp (t.ex. med dotterbolag eller utan lönebidrag)')
              : figure(payroll.total, 'payroll', payrollDetail(payroll)),
          own_pay:
            ownerInputs.own_pay_override !== null
              ? figure(ownerInputs.own_pay_override, 'owner', 'Ditt belopp')
              : figure(own.amount, 'payroll', own.employees.length > 0 ? `Lön till ${own.employees.map((e) => e.name).join(', ')} ${year - 1}` : `Ingen lön med ditt namn ${year - 1}`),
          cost_basis:
            ownerInputs.cost_basis_override !== null
              ? figure(ownerInputs.cost_basis_override, 'owner', 'Ditt belopp')
              : figure(
                  cost.amount,
                  'register',
                  `Aktieboken ${roundOre(cost.register_amount)} kr${cost.contributions_amount > 0 ? ` och ovillkorade aktieägartillskott ${cost.contributions_amount} kr` : ''}${cost.complete ? '' : ' (ofullständigt)'}`,
                ),
          saved_dividend_space: figure(ownerInputs.saved_dividend_space, 'owner', `Från din K10 för ${year - 1}`),
          dividend: figure(dividend, 'ledger', dividend > 0 ? `Bokförd utdelning med betalningsdag ${year}` : `Ingen utdelning med betalningsdag ${year}`),
        })
      : null
    if (!result) continue
    owners.push({
      party_id: partyId,
      name,
      identity: party?.personnummer_masked ?? party?.birth_date ?? null,
      shares_at_start: holding?.shares ?? 0,
      dividend_received: dividend,
      inputs: ownerInputs,
      inputs_saved: inputs.has(partyId),
      cost_basis: { register_amount: cost.register_amount, contributions_amount: cost.contributions_amount, amount: cost.amount, complete: cost.complete, gaps: cost.gaps, gaps_sv: cost.gaps.map((g) => COST_BASIS_GAP_TEXT_SV[g]) },
      own_pay_employees: own.employees,
      result,
      warnings,
    })
  }
  owners.sort((a, b) => b.shares_at_start - a.shares_at_start || a.name.localeCompare(b.name, 'sv'))

  return {
    income_year: year,
    supported: params !== null,
    supported_years: supportedK10Years(),
    unsupported_reason_sv: params ? null : unsupportedReason(year),
    parameters: params,
    start_date: startDate,
    famansforetag: { value: confirmed ? Boolean(ku31!.famansforetag) : derivation.derived, confirmed, top_four_votes_pct: derivation.top_four_votes_pct },
    total_shares_at_start: totalShares,
    payroll: { year: payroll.year, total: payroll.total, runs: payroll.runs, opening_balance_amount: payroll.opening_balance_amount, employees: payroll.employees.length },
    owners,
    company_holders: companyHolders,
  }
}

// ── The owner's inputs ───────────────────────────────────────────────

export interface K10InputsInput {
  party_id: string
  income_year: number
  saved_dividend_space?: number | null
  cost_basis_override?: number | null
  payroll_base_override?: number | null
  own_pay_override?: number | null
  uses_basic_amount?: boolean | null
  note?: string | null
}

export interface K10InputsSaved {
  party_id: string
  income_year: number
  inputs: K10OwnerInputs
  result: K10Result | null
}

/**
 * Save what an owner enters for a year (an upsert: omitted fields keep
 * their value, null clears an override). The answer carries the K10
 * underlag recomputed with the new figures.
 */
export async function saveK10Inputs(ctx: OperationContext, input: K10InputsInput, { dryRun }: { dryRun: boolean }): Promise<OperationOutcome<K10InputsSaved>> {
  try {
    if (!k10Parameters(input.income_year)) return { ok: false, code: 'K10_YEAR_UNSUPPORTED', messageSv: unsupportedReason(input.income_year) }
    const view = await loadK10Year(ctx, input.income_year)
    const owner = view.owners.find((o) => o.party_id === input.party_id)
    if (!owner) return { ok: false, code: 'K10_OWNER_NOT_FOUND' }
    const current = owner.inputs
    const pick = <K extends keyof K10OwnerInputs>(key: K, value: K10OwnerInputs[K] | undefined): K10OwnerInputs[K] => (value === undefined ? current[key] : value)
    const next: K10OwnerInputs = {
      saved_dividend_space: roundOre(input.saved_dividend_space ?? current.saved_dividend_space),
      cost_basis_override: pick('cost_basis_override', input.cost_basis_override === undefined ? undefined : input.cost_basis_override === null ? null : roundOre(input.cost_basis_override)),
      payroll_base_override: pick('payroll_base_override', input.payroll_base_override === undefined ? undefined : input.payroll_base_override === null ? null : roundOre(input.payroll_base_override)),
      own_pay_override: pick('own_pay_override', input.own_pay_override === undefined ? undefined : input.own_pay_override === null ? null : roundOre(input.own_pay_override)),
      uses_basic_amount: input.uses_basic_amount ?? current.uses_basic_amount,
      note: input.note === undefined ? current.note : input.note?.trim() || null,
      updated_at: current.updated_at,
    }
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          party: { party_id: input.party_id, name: owner.name },
          income_year: input.income_year,
          before: { ...current, updated_at: undefined },
          after: { ...next, updated_at: undefined },
        },
      }
    }
    const { error } = await ctx.supabase.from('k10_owner_inputs').upsert(
      {
        company_id: ctx.companyId,
        party_id: input.party_id,
        income_year: input.income_year,
        saved_dividend_space: next.saved_dividend_space,
        cost_basis_override: next.cost_basis_override,
        payroll_base_override: next.payroll_base_override,
        own_pay_override: next.own_pay_override,
        uses_basic_amount: next.uses_basic_amount,
        note: next.note,
        updated_by: ctx.userId,
      },
      { onConflict: 'company_id,party_id,income_year' },
    )
    if (error) throw new Error(`k10_owner_inputs upsert failed: ${error.message}`)
    const after = await loadK10Year(ctx, input.income_year)
    const saved = after.owners.find((o) => o.party_id === input.party_id)
    return { ok: true, data: { party_id: input.party_id, income_year: input.income_year, inputs: saved?.inputs ?? next, result: saved?.result ?? null } }
  } catch (error) {
    return ownerTaxFailure(error)
  }
}

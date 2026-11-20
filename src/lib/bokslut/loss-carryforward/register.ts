import type { SupabaseClient } from '@supabase/supabase-js'
import { equalOre, roundOre } from '@/lib/money'
import { resolveCompanyEntityType, usesInk2 } from '@/lib/company/entity-type'
import { lossCarryforwardEnabledFor } from '@/lib/env/loss-carryforward-switch'
import { isMissingTableError } from '@/lib/bookkeeping/business-event-link'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import {
  amountBlockLimit,
  computeLossYear,
  defaultGroupBlockLastYear,
  type GroupBlockInput,
  type LossYearResult,
  type LossYearWarningCode,
} from './calculator'
import type {
  LossCarryforwardSource,
  OwnershipChangeSource,
  SaveLossCarryforwardInput,
} from './schemas'

/**
 * The underskottsregister (tax_loss_carryforwards): one row per company and
 * räkenskapsår, read in fiscal-year order so each year can be checked
 * against the one before it (the previous year's carried-forward deficit is
 * this year's 4.14 a; a koncernbidragsspärr carries its pool from year to
 * year). The arithmetic is ./calculator.ts; this file loads, checks, stores
 * and explains.
 *
 * Every door goes through here: the dashboard routes, the v1 endpoints and
 * the MCP tools (lib/operations/tax-loss-carryforwards.ts). Each refuses
 * while BOLAGET_COMPANY_IDS leaves the company out, and for a legal form
 * that does not file INK2.
 */

type Num = number | string

export interface LossCarryforwardRow {
  id: string
  company_id: string
  fiscal_period_id: string
  brought_forward: Num
  result_before_deficit: Num | null
  group_contributions_received: Num
  amount_block_reduction: Num
  amount_block_manual: boolean
  group_block_reduction: Num
  group_block_manual: boolean
  carried_forward: Num | null
  ownership_change_date: string | null
  ownership_change_source: OwnershipChangeSource | null
  amount_block_applies: boolean
  acquisition_cost: Num | null
  capital_contributions: Num
  group_block_applies: boolean
  group_block_last_year: number | null
  source: LossCarryforwardSource
  note: string | null
  document_id: string | null
  tax_assessment_notice_id: string | null
  updated_at?: string
}

export interface FiscalPeriodRef {
  id: string
  name: string
  period_start: string
  period_end: string
}

export type LossCarryforwardWarningCode =
  | LossYearWarningCode
  /** 4.14 a differs from what the previous year in the register carries forward. */
  | 'brought_forward_differs'
  /** The stored figures differ from what the register computes today (an earlier year changed): save the year again. */
  | 'recompute_differs'

export interface LossCarryforwardWarning {
  code: LossCarryforwardWarningCode
  message_sv: string
  message_en: string
  /** The amount the warning is about, when it names one. */
  amount?: number
}

export interface LossCarryforwardView {
  tax_loss_carryforward_id: string
  fiscal_period_id: string
  fiscal_period: { name: string; period_start: string; period_end: string }
  /** The calendar year the fiscal year ends in (the inkomstår on INK2). */
  fiscal_year: number
  /** INK2S 4.14 a. */
  brought_forward: number
  source: LossCarryforwardSource
  result_before_deficit: number | null
  group_contributions_received: number
  /** INK2S 4.14 b. */
  amount_block_reduction: number
  amount_block_manual: boolean
  /** INK2S 4.14 c. */
  group_block_reduction: number
  group_block_manual: boolean
  /** 4.14 a less 4.14 b and 4.14 c: what the year's tax adjustments deduct. */
  deductible: number
  /** INK2S 4.15 when positive, 4.16 when negative; null while the result is unknown. */
  taxable_result: number | null
  /** To the next year's 4.14 a; null while the result is unknown. */
  carried_forward: number | null
  ownership_change: null | {
    date: string
    source: OwnershipChangeSource
    amount_block: boolean
    acquisition_cost: number | null
    capital_contributions: number
    /** 300 % of the utgift less tillskott (40:15-16), when the utgift is known. */
    amount_block_limit: number | null
    group_block: boolean
    group_block_last_year: number | null
  }
  /** Whether a koncernbidragsspärr covers this year (its own change or an earlier one). */
  group_block_active: boolean
  note: string | null
  document_id: string | null
  tax_assessment_notice_id: string | null
  updated_at: string | null
  warnings: LossCarryforwardWarning[]
}

const WARNING_TEXT: Record<LossCarryforwardWarningCode, { sv: string; en: string }> = {
  amount_block_missing_cost: {
    sv: 'Beloppsspärren är inte beräknad: ange utgiften för förvärvet av det bestämmande inflytandet. Inget har dragits bort.',
    en: 'The amount block is not computed: enter the cost of acquiring the controlling interest. Nothing has been deducted.',
  },
  amount_block_manual_differs: {
    sv: 'Angiven reduktion på 4.14 b skiljer sig från den beräknade beloppsspärren.',
    en: 'The stated reduction on 4.14 b differs from the computed amount block.',
  },
  group_block_missing_result: {
    sv: 'Koncernbidragsspärren är inte beräknad: ange årets resultat före underskottsavdrag.',
    en: 'The group contribution block is not computed: enter the year\'s result before the deficit deduction.',
  },
  group_block_missing_pool: {
    sv: 'Koncernbidragsspärren är inte beräknad: föregående räkenskapsår saknas i registret.',
    en: 'The group contribution block is not computed: the previous fiscal year is missing from the register.',
  },
  group_block_manual_differs: {
    sv: 'Angiven reduktion på 4.14 c skiljer sig från den beräknade koncernbidragsspärren.',
    en: 'The stated reduction on 4.14 c differs from the computed group contribution block.',
  },
  brought_forward_differs: {
    sv: 'Underskottet från föregående år skiljer sig från vad föregående år i registret för vidare.',
    en: 'The deficit brought forward differs from what the previous year in the register carries forward.',
  },
  recompute_differs: {
    sv: 'Ett tidigare år har ändrats sedan året sparades: spara året igen så räknas det om.',
    en: 'An earlier year changed after this year was saved: save the year again to recompute it.',
  },
}

function warning(code: LossCarryforwardWarningCode, amount?: number): LossCarryforwardWarning {
  const text = WARNING_TEXT[code]
  return { code, message_sv: text.sv, message_en: text.en, ...(amount === undefined ? {} : { amount }) }
}

function num(value: Num | null | undefined): number {
  return roundOre(Number(value ?? 0) || 0)
}

function numOrNull(value: Num | null | undefined): number | null {
  return value === null || value === undefined ? null : num(value)
}

function fiscalYearOf(period: { period_end: string }): number {
  return Number.parseInt(period.period_end.slice(0, 4), 10)
}

/** The day after an ISO date, as an ISO date. */
function nextDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

interface ChainEntry {
  row: LossCarryforwardRow
  period: FiscalPeriodRef
}

/**
 * The koncernbidragsspärr input for entry `index`: the year of its own
 * change, or a later year inside an earlier change's window (the pool is
 * what the immediately preceding year's 4.14 c kept back).
 */
function groupBlockFor(chain: ChainEntry[], index: number): GroupBlockInput | null {
  const { row, period } = chain[index]
  if (row.group_block_applies) return { kind: 'change_year' }
  const year = fiscalYearOf(period)
  for (let j = index - 1; j >= 0; j--) {
    const earlier = chain[j].row
    if (!earlier.group_block_applies) continue
    if (earlier.group_block_last_year === null || earlier.group_block_last_year < year) return null
    const previous = chain[index - 1]
    const consecutive = previous && nextDay(previous.period.period_end) === period.period_start
    return { kind: 'continuing', pool: consecutive ? num(previous.row.group_block_reduction) : null }
  }
  return null
}

function computeEntry(chain: ChainEntry[], index: number): LossYearResult {
  const { row } = chain[index]
  return computeLossYear({
    broughtForward: num(row.brought_forward),
    resultBeforeDeficit: numOrNull(row.result_before_deficit),
    groupContributionsReceived: num(row.group_contributions_received),
    amountBlock: row.amount_block_applies
      ? { acquisitionCost: numOrNull(row.acquisition_cost), capitalContributions: num(row.capital_contributions) }
      : null,
    groupBlock: groupBlockFor(chain, index),
    manualAmountBlockReduction: row.amount_block_manual ? num(row.amount_block_reduction) : null,
    manualGroupBlockReduction: row.group_block_manual ? num(row.group_block_reduction) : null,
  })
}

function sameAmount(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b
  return equalOre(a, b)
}

function viewOf(chain: ChainEntry[], index: number): LossCarryforwardView {
  const { row, period } = chain[index]
  const computed = computeEntry(chain, index)
  const warnings = computed.warnings.map((code) => warning(code))

  const previous = chain[index - 1]
  if (previous && nextDay(previous.period.period_end) === period.period_start) {
    const carried = numOrNull(previous.row.carried_forward)
    if (carried !== null && !equalOre(carried, num(row.brought_forward))) {
      warnings.push(warning('brought_forward_differs', carried))
    }
  }

  const stored = {
    b: num(row.amount_block_reduction),
    c: num(row.group_block_reduction),
    carried: numOrNull(row.carried_forward),
  }
  if (
    !equalOre(stored.b, computed.amountBlockReduction)
    || !equalOre(stored.c, computed.groupBlockReduction)
    || !sameAmount(stored.carried, computed.carriedForward)
  ) {
    warnings.push(warning('recompute_differs', computed.carriedForward ?? undefined))
  }

  const deductible = roundOre(Math.max(0, num(row.brought_forward) - stored.b - stored.c))
  const result = numOrNull(row.result_before_deficit)
  return {
    tax_loss_carryforward_id: row.id,
    fiscal_period_id: row.fiscal_period_id,
    fiscal_period: { name: period.name, period_start: period.period_start, period_end: period.period_end },
    fiscal_year: fiscalYearOf(period),
    brought_forward: num(row.brought_forward),
    source: row.source,
    result_before_deficit: result,
    group_contributions_received: num(row.group_contributions_received),
    amount_block_reduction: stored.b,
    amount_block_manual: row.amount_block_manual,
    group_block_reduction: stored.c,
    group_block_manual: row.group_block_manual,
    deductible,
    taxable_result: result === null ? null : roundOre(result - deductible),
    carried_forward: stored.carried,
    ownership_change: row.ownership_change_date
      ? {
          date: row.ownership_change_date,
          source: row.ownership_change_source ?? 'manual',
          amount_block: row.amount_block_applies,
          acquisition_cost: numOrNull(row.acquisition_cost),
          capital_contributions: num(row.capital_contributions),
          amount_block_limit:
            row.amount_block_applies && row.acquisition_cost !== null
              ? amountBlockLimit(num(row.acquisition_cost), num(row.capital_contributions))
              : null,
          group_block: row.group_block_applies,
          group_block_last_year: row.group_block_last_year,
        }
      : null,
    group_block_active: groupBlockFor(chain, index) !== null,
    note: row.note,
    document_id: row.document_id,
    tax_assessment_notice_id: row.tax_assessment_notice_id,
    updated_at: row.updated_at ?? null,
    warnings,
  }
}

async function loadChain(supabase: SupabaseClient, companyId: string): Promise<ChainEntry[]> {
  const { data, error } = await supabase
    .from('tax_loss_carryforwards')
    .select(
      'id, company_id, fiscal_period_id, brought_forward, result_before_deficit, group_contributions_received, amount_block_reduction, amount_block_manual, group_block_reduction, group_block_manual, carried_forward, ownership_change_date, ownership_change_source, amount_block_applies, acquisition_cost, capital_contributions, group_block_applies, group_block_last_year, source, note, document_id, tax_assessment_notice_id, updated_at',
    )
    .eq('company_id', companyId)
  if (error) throw error
  const rows = (data ?? []) as unknown as LossCarryforwardRow[]
  if (rows.length === 0) return []
  const periods = await loadPeriods(supabase, companyId, rows.map((r) => r.fiscal_period_id))
  return rows
    .flatMap((row) => {
      const period = periods.get(row.fiscal_period_id)
      return period ? [{ row, period }] : []
    })
    .sort((a, b) => a.period.period_start.localeCompare(b.period.period_start))
}

async function loadPeriods(
  supabase: SupabaseClient,
  companyId: string,
  ids: string[],
): Promise<Map<string, FiscalPeriodRef>> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('company_id', companyId)
    .in('id', [...new Set(ids)])
  if (error) throw error
  return new Map(((data ?? []) as FiscalPeriodRef[]).map((p) => [p.id, p]))
}

export async function loadFiscalPeriod(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<FiscalPeriodRef | null> {
  const periods = await loadPeriods(supabase, companyId, [fiscalPeriodId])
  return periods.get(fiscalPeriodId) ?? null
}

type Gate = { ok: true } | { ok: false; code: string }

/** The switch and the legal form: the register is for companies that file INK2. */
export async function registerGate(supabase: SupabaseClient, companyId: string): Promise<Gate> {
  if (!lossCarryforwardEnabledFor(companyId)) return { ok: false, code: 'LOSS_CARRYFORWARD_UNAVAILABLE' }
  const form = await resolveCompanyEntityType(supabase, companyId)
  if (!usesInk2(form)) return { ok: false, code: 'LOSS_CARRYFORWARD_FORM_UNSUPPORTED' }
  return { ok: true }
}

/** Every year in the register, oldest first, each checked against the one before it. */
export async function listLossCarryforwards(
  ctx: Pick<OperationContext, 'supabase' | 'companyId'>,
): Promise<OperationOutcome<{ tax_loss_carryforwards: LossCarryforwardView[] }>> {
  const gate = await registerGate(ctx.supabase, ctx.companyId)
  if (!gate.ok) return gate
  const chain = await loadChain(ctx.supabase, ctx.companyId)
  return { ok: true, data: { tax_loss_carryforwards: chain.map((_, i) => viewOf(chain, i)) } }
}

/** One year of the register by its id. */
export async function getLossCarryforward(
  ctx: Pick<OperationContext, 'supabase' | 'companyId'>,
  id: string,
): Promise<OperationOutcome<LossCarryforwardView>> {
  const gate = await registerGate(ctx.supabase, ctx.companyId)
  if (!gate.ok) return gate
  const chain = await loadChain(ctx.supabase, ctx.companyId)
  const index = chain.findIndex((entry) => entry.row.id === id)
  if (index < 0) return { ok: false, code: 'LOSS_CARRYFORWARD_NOT_FOUND' }
  return { ok: true, data: viewOf(chain, index) }
}

/** What the register says for one fiscal year, as the tax adjustments read it. */
export interface RegisterDeficit {
  taxLossCarryforwardId: string
  /** INK2S 4.14 a. */
  broughtForward: number
  /** INK2S 4.14 b. */
  amountBlockReduction: number
  /** INK2S 4.14 c. */
  groupBlockReduction: number
  /** 4.14 a less 4.14 b and 4.14 c: what the year deducts. */
  deductible: number
  source: LossCarryforwardSource
}

/**
 * The register's row for a fiscal year, or null when the year has none.
 * Read on the tax adjustments' path for every company the switch opens, so
 * it fails open while the table does not exist yet (the migration applies
 * after the code is live).
 */
export async function loadRegisterDeficit(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<RegisterDeficit | null> {
  const { data, error } = await supabase
    .from('tax_loss_carryforwards')
    .select('id, brought_forward, amount_block_reduction, group_block_reduction, source')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (error) {
    if (isMissingTableError(error)) return null
    throw new Error(`Failed to load the loss carry-forward register: ${error.message}`)
  }
  if (!data) return null
  const row = data as Pick<LossCarryforwardRow, 'id' | 'brought_forward' | 'amount_block_reduction' | 'group_block_reduction' | 'source'>
  const broughtForward = num(row.brought_forward)
  const amountBlockReduction = num(row.amount_block_reduction)
  const groupBlockReduction = num(row.group_block_reduction)
  return {
    taxLossCarryforwardId: row.id,
    broughtForward,
    amountBlockReduction,
    groupBlockReduction,
    deductible: roundOre(Math.max(0, broughtForward - amountBlockReduction - groupBlockReduction)),
    source: row.source,
  }
}

async function belongsToCompany(
  supabase: SupabaseClient,
  table: 'document_attachments' | 'tax_assessment_notices',
  companyId: string,
  id: string,
): Promise<boolean> {
  const query =
    table === 'document_attachments'
      ? supabase.from('document_attachments').select('id').eq('company_id', companyId).eq('id', id).maybeSingle()
      : supabase.from('tax_assessment_notices').select('id').eq('company_id', companyId).eq('id', id).maybeSingle()
  const { data, error } = await query
  if (error) throw error
  return Boolean(data)
}

/**
 * Save one fiscal year of the register (insert or replace by
 * fiscal_period_id). The 4.14 b and 4.14 c reductions are computed from the
 * ownership change and the year's result unless stated, and the deficit
 * carried forward is computed from them; a dry run answers what would be
 * stored and writes nothing.
 */
export async function saveLossCarryforward(
  ctx: OperationContext,
  input: SaveLossCarryforwardInput,
  options: { dryRun: boolean },
): Promise<OperationOutcome<LossCarryforwardView>> {
  const { supabase, companyId } = ctx
  const gate = await registerGate(supabase, companyId)
  if (!gate.ok) return gate

  const period = await loadFiscalPeriod(supabase, companyId, input.fiscal_period_id)
  if (!period) return { ok: false, code: 'FISCAL_PERIOD_NOT_FOUND', details: { fiscal_period_id: input.fiscal_period_id } }
  const fiscalYear = fiscalYearOf(period)

  const change = input.ownership_change ?? null
  if (change && (change.date < period.period_start || change.date > period.period_end)) {
    return { ok: false, code: 'LOSS_CARRYFORWARD_CHANGE_OUTSIDE_YEAR', details: { field: 'ownership_change.date' } }
  }
  const groupBlockLastYear = change?.group_block
    ? change.group_block_last_year ?? defaultGroupBlockLastYear(fiscalYear)
    : null
  if (groupBlockLastYear !== null && groupBlockLastYear < fiscalYear) {
    return { ok: false, code: 'LOSS_CARRYFORWARD_BLOCK_END_BEFORE_CHANGE', details: { field: 'ownership_change.group_block_last_year' } }
  }
  const broughtForward = roundOre(input.brought_forward)
  const statedB = input.amount_block_reduction ?? null
  const statedC = input.group_block_reduction ?? null
  if (roundOre((statedB ?? 0) + (statedC ?? 0)) > broughtForward) {
    return { ok: false, code: 'LOSS_CARRYFORWARD_REDUCTIONS_EXCEED', details: { field: 'amount_block_reduction' } }
  }
  if (input.document_id && !(await belongsToCompany(supabase, 'document_attachments', companyId, input.document_id))) {
    return { ok: false, code: 'LOSS_CARRYFORWARD_LINK_NOT_FOUND', details: { field: 'document_id' } }
  }
  if (
    input.tax_assessment_notice_id
    && !(await belongsToCompany(supabase, 'tax_assessment_notices', companyId, input.tax_assessment_notice_id))
  ) {
    return { ok: false, code: 'LOSS_CARRYFORWARD_LINK_NOT_FOUND', details: { field: 'tax_assessment_notice_id' } }
  }

  const chain = await loadChain(supabase, companyId)
  const existing = chain.find((entry) => entry.row.fiscal_period_id === period.id)?.row
  const draft: LossCarryforwardRow = {
    id: existing?.id ?? 'new',
    company_id: companyId,
    fiscal_period_id: period.id,
    brought_forward: broughtForward,
    result_before_deficit: input.result_before_deficit === undefined || input.result_before_deficit === null
      ? null
      : roundOre(input.result_before_deficit),
    group_contributions_received: roundOre(input.group_contributions_received ?? 0),
    amount_block_reduction: statedB ?? 0,
    amount_block_manual: statedB !== null,
    group_block_reduction: statedC ?? 0,
    group_block_manual: statedC !== null,
    carried_forward: null,
    ownership_change_date: change?.date ?? null,
    ownership_change_source: change ? 'manual' : null,
    amount_block_applies: Boolean(change?.amount_block),
    acquisition_cost: change?.amount_block && change.acquisition_cost != null ? roundOre(change.acquisition_cost) : null,
    capital_contributions: change?.amount_block ? roundOre(change.capital_contributions ?? 0) : 0,
    group_block_applies: Boolean(change?.group_block),
    group_block_last_year: groupBlockLastYear,
    source: input.source,
    note: input.note?.trim() || null,
    document_id: input.document_id ?? null,
    tax_assessment_notice_id: input.tax_assessment_notice_id ?? null,
  }

  // Compute this year in its place in the register, then store what it says.
  const withDraft = [...chain.filter((entry) => entry.row.fiscal_period_id !== period.id), { row: draft, period }].sort(
    (a, b) => a.period.period_start.localeCompare(b.period.period_start),
  )
  const index = withDraft.findIndex((entry) => entry.row === draft)
  const computed = computeEntry(withDraft, index)
  draft.amount_block_reduction = computed.amountBlockReduction
  draft.group_block_reduction = computed.groupBlockReduction
  draft.carried_forward = computed.carriedForward

  if (options.dryRun) {
    const view = viewOf(withDraft, index)
    return { ok: true, dryRun: true, preview: { ...view, tax_loss_carryforward_id: existing?.id ?? null } }
  }

  const { data, error } = await supabase
    .from('tax_loss_carryforwards')
    .upsert(
      {
        company_id: draft.company_id,
        fiscal_period_id: draft.fiscal_period_id,
        brought_forward: draft.brought_forward,
        result_before_deficit: draft.result_before_deficit,
        group_contributions_received: draft.group_contributions_received,
        amount_block_reduction: draft.amount_block_reduction,
        amount_block_manual: draft.amount_block_manual,
        group_block_reduction: draft.group_block_reduction,
        group_block_manual: draft.group_block_manual,
        carried_forward: draft.carried_forward,
        ownership_change_date: draft.ownership_change_date,
        ownership_change_source: draft.ownership_change_source,
        amount_block_applies: draft.amount_block_applies,
        acquisition_cost: draft.acquisition_cost,
        capital_contributions: draft.capital_contributions,
        group_block_applies: draft.group_block_applies,
        group_block_last_year: draft.group_block_last_year,
        source: draft.source,
        note: draft.note,
        document_id: draft.document_id,
        tax_assessment_notice_id: draft.tax_assessment_notice_id,
        updated_by: ctx.userId,
      },
      { onConflict: 'company_id,fiscal_period_id' },
    )
    .select(
      'id, company_id, fiscal_period_id, brought_forward, result_before_deficit, group_contributions_received, amount_block_reduction, amount_block_manual, group_block_reduction, group_block_manual, carried_forward, ownership_change_date, ownership_change_source, amount_block_applies, acquisition_cost, capital_contributions, group_block_applies, group_block_last_year, source, note, document_id, tax_assessment_notice_id, updated_at',
    )
    .single()
  if (error) return { ok: false, code: 'INTERNAL_ERROR', error }

  const saved = data as unknown as LossCarryforwardRow
  withDraft[index] = { row: saved, period }
  return { ok: true, data: viewOf(withDraft, index), created: !existing }
}

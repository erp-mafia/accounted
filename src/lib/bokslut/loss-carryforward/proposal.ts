import type { SupabaseClient } from '@supabase/supabase-js'
import { generateINK2Declaration } from '@/lib/reports/ink2/ink2-engine'
import type { Logger } from '@/lib/logger'
import type { OperationOutcome } from '@/lib/operations/types'
import {
  listLossCarryforwards,
  loadFiscalPeriod,
  registerGate,
  type FiscalPeriodRef,
  type LossCarryforwardView,
} from './register'
import type { LossCarryforwardSource } from './schemas'

/**
 * What the app already knows about a fiscal year's deficit, offered when the
 * user opens a year in the register. Nothing is written here: the user picks
 * a figure (or types one) and saves it.
 *
 *   - computed: the previous fiscal year in the register carries a deficit
 *     forward (the roll-forward).
 *   - ink2_history: the previous fiscal year's INK2 as this app computes it
 *     from its books (INK2S 4.16, the underskott carried to the next year).
 *   - tax_assessment: a slutskattebesked registered for the previous fiscal
 *     year. tax_assessment_notices holds no amounts, so it is offered as the
 *     document to read the fastställt underskott from and to link, not as a
 *     figure.
 *
 * The year's own result before the deduction is offered from this year's
 * INK2 (4.15 or 4.16 with 4.14 a added back).
 */

export interface DeficitCandidate {
  source: LossCarryforwardSource
  /** The deficit to bring forward; null when the source only points at where to read it. */
  amount: number | null
  /** The fiscal year the figure comes from. */
  fiscal_period_id: string
  fiscal_period_name: string
  /** Set for a tax_assessment candidate: the notice to link. */
  tax_assessment_notice_id?: string
  decision_date?: string
}

export interface LossCarryforwardProposal {
  fiscal_period: FiscalPeriodRef
  previous_fiscal_period: FiscalPeriodRef | null
  /** The year as the register holds it, when it has a row. */
  existing: LossCarryforwardView | null
  candidates: DeficitCandidate[]
  /** This year's result on INK2S before 4.14, from the books; null when it cannot be computed. */
  result_before_deficit: number | null
}

async function previousFiscalPeriod(
  supabase: SupabaseClient,
  companyId: string,
  period: FiscalPeriodRef,
): Promise<FiscalPeriodRef | null> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('company_id', companyId)
    .lt('period_end', period.period_start)
    .order('period_end', { ascending: false })
    .limit(1)
  if (error) throw error
  return ((data ?? [])[0] as FiscalPeriodRef | undefined) ?? null
}

/** INK2S figures of a year, or null when the engine cannot produce them (logged). */
async function ink2Figures(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  log: Logger,
): Promise<{ deficit: number; resultBeforeDeficit: number } | null> {
  try {
    const declaration = await generateINK2Declaration(supabase, companyId, fiscalPeriodId)
    const s = declaration.ink2s
    return { deficit: s['7770'], resultBeforeDeficit: s['7670'] - s['7770'] + s['7763'] }
  } catch (error) {
    log.warn('loss-carryforward: INK2 figures unavailable', {
      fiscalPeriodId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

export async function proposeLossCarryforward(
  ctx: { supabase: SupabaseClient; companyId: string; log: Logger },
  fiscalPeriodId: string,
): Promise<OperationOutcome<LossCarryforwardProposal>> {
  const { supabase, companyId, log } = ctx
  const gate = await registerGate(supabase, companyId)
  if (!gate.ok) return gate

  const period = await loadFiscalPeriod(supabase, companyId, fiscalPeriodId)
  if (!period) return { ok: false, code: 'FISCAL_PERIOD_NOT_FOUND', details: { fiscal_period_id: fiscalPeriodId } }
  const previous = await previousFiscalPeriod(supabase, companyId, period)

  const listed = await listLossCarryforwards(ctx)
  if (!listed.ok || listed.dryRun) return listed as OperationOutcome<never>
  const rows = listed.data.tax_loss_carryforwards
  const existing = rows.find((row) => row.fiscal_period_id === period.id) ?? null

  const candidates: DeficitCandidate[] = []
  if (previous) {
    const previousRow = rows.find((row) => row.fiscal_period_id === previous.id)
    if (previousRow && previousRow.carried_forward !== null) {
      candidates.push({
        source: 'computed',
        amount: previousRow.carried_forward,
        fiscal_period_id: previous.id,
        fiscal_period_name: previous.name,
      })
    }
    const previousInk2 = await ink2Figures(supabase, companyId, previous.id, log)
    if (previousInk2) {
      candidates.push({
        source: 'ink2_history',
        amount: previousInk2.deficit,
        fiscal_period_id: previous.id,
        fiscal_period_name: previous.name,
      })
    }
    const { data: notices, error } = await supabase
      .from('tax_assessment_notices')
      .select('id, decision_date')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', previous.id)
      .is('archived_at', null)
      .order('decision_date', { ascending: false })
      .limit(1)
    if (error) throw error
    const notice = (notices ?? [])[0] as { id: string; decision_date: string } | undefined
    if (notice) {
      candidates.push({
        source: 'tax_assessment',
        amount: null,
        fiscal_period_id: previous.id,
        fiscal_period_name: previous.name,
        tax_assessment_notice_id: notice.id,
        decision_date: notice.decision_date,
      })
    }
  }

  const own = await ink2Figures(supabase, companyId, period.id, log)
  return {
    ok: true,
    data: {
      fiscal_period: period,
      previous_fiscal_period: previous,
      existing,
      candidates,
      result_before_deficit: own ? own.resultBeforeDeficit : null,
    },
  }
}


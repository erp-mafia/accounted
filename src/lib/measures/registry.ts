/**
 * The measure registry: one place an agent or integration asks for a defined
 * figure instead of rebuilding it from reports or journal lines.
 *
 * The three answers the doors serve (lib/operations/measures.ts):
 *   - listMeasures(): every measure with its definition, dimension and the
 *     report it equals;
 *   - getMeasure(): one value, its definition, what it covers, caveats and
 *     an explain handle (the call that explains this very figure);
 *   - explainMeasure(): the same value with what it adds (accounts, customers
 *     or suppliers) and the journal lines or invoices behind it, paged.
 *
 * A measure that cannot be computed answers a typed refusal (the codes in
 * lib/errors/structured-errors.ts, MEASURE_*) with a Swedish sentence; a
 * transient database failure is rethrown so the door answers it as one.
 */
import { AccountRoleError } from '@/lib/bookkeeping/account-roles'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'
import { MEASURE_DEFINITIONS } from './definitions'
import { DEFAULT_DRILLDOWN_LIMIT, MAX_DRILLDOWN_LIMIT, pageOf } from './explain'
import { resolveScope, scopeParams } from './params'
import {
  DIMENSION_PARAMS,
  MEASURE_IDS,
  MeasureRefusal,
  isMeasureId,
  type MeasureBreakdown,
  type MeasureComputation,
  type MeasureContext,
  type AnyMeasureDefinition,
  type MeasureDimension,
  type MeasureEquals,
  type MeasureId,
  type MeasureParams,
  type MeasureRefusalCode,
  type ResolvedScope,
} from './types'

const log = createLogger('measures')

const BY_ID = new Map<string, AnyMeasureDefinition>(
  (MEASURE_DEFINITIONS as ReadonlyArray<AnyMeasureDefinition>).map((m) => [m.id, m]),
)

export function getMeasureDefinition(id: MeasureId): AnyMeasureDefinition {
  return BY_ID.get(id)!
}

/** Every measure id, in list order. */
export const REGISTERED_MEASURE_IDS: readonly MeasureId[] = MEASURE_DEFINITIONS.map((m) => m.id)

export type MeasureOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: MeasureRefusalCode; messageSv: string; details: Record<string, unknown> }

/** The explain handle: the call that answers the explanation of the same figure. */
export interface MeasureExplainHandle {
  tool: 'gnubok_explain_measure'
  arguments: { measure_id: MeasureId } & MeasureParams
  v1_path: string
}

export interface MeasureSummary {
  measure_id: MeasureId
  name_sv: string
  name_en: string
  definition: string
  definition_sv: string
  unit: 'SEK'
  dimension: MeasureDimension
  parameters: string[]
  equals: MeasureEquals
}

export interface MeasureValue extends Omit<MeasureSummary, 'definition_sv' | 'parameters' | 'dimension'> {
  value: number
  count: number | null
  as_of: string
  period: MeasureComputation['period']
  /** The momsperiod, for vat_payable. */
  vat_period: { period_type: string; year: number; period: number } | null
  caveats: MeasureComputation['caveats']
  data_status: MeasureComputation['data_status']
  explain: MeasureExplainHandle
}

export interface MeasureExplanation {
  measure_id: MeasureId
  name_sv: string
  unit: 'SEK'
  value: number
  count: number | null
  as_of: string
  period: MeasureComputation['period']
  equals: MeasureEquals
  contributors: MeasureBreakdown['contributors']
  drilldown: MeasureBreakdown['drilldown'] & { total: number; offset: number; next_offset: number | null }
  reconciles: boolean
  reconciliation_note: string | null
}

function summaryOf(m: AnyMeasureDefinition): MeasureSummary {
  return {
    measure_id: m.id,
    name_sv: m.name_sv,
    name_en: m.name_en,
    definition: m.definition,
    definition_sv: m.definition_sv,
    unit: m.unit,
    dimension: m.dimension,
    parameters: [...DIMENSION_PARAMS[m.dimension]],
    equals: m.equals,
  }
}

export function listMeasures(): MeasureSummary[] {
  return REGISTERED_MEASURE_IDS.map((id) => summaryOf(getMeasureDefinition(id)))
}

function unknownMeasure(id: string): MeasureOutcome<never> {
  return {
    ok: false,
    code: 'MEASURE_NOT_FOUND',
    messageSv: `Måttet ${JSON.stringify(id)} finns inte. Giltiga mått: ${MEASURE_IDS.join(', ')}.`,
    details: { measure_id: id, valid: [...MEASURE_IDS] },
  }
}

/**
 * Runs `work`, turning what cannot be computed into a typed refusal. A
 * transient failure (timeout, deadlock, dropped connection) is rethrown: the
 * door answers it as retryable, and nothing is ever reported as a zero.
 */
async function guarded<T>(measure: AnyMeasureDefinition, work: () => Promise<T>): Promise<MeasureOutcome<T>> {
  try {
    return { ok: true, data: await work() }
  } catch (err) {
    if (err instanceof MeasureRefusal) {
      return { ok: false, code: err.code, messageSv: err.messageSv, details: { measure_id: measure.id, ...err.details } }
    }
    if (err instanceof AccountRoleError) {
      return {
        ok: false,
        code: 'MEASURE_ACCOUNT_ROLE_UNAVAILABLE',
        messageSv: `${measure.name_sv} kan inte beräknas: bolagets land (${err.jurisdiction || 'okänt'}) har inget konto för rollen ${err.role}. Inget värde har räknats fram.`,
        details: { measure_id: measure.id, role: err.role, jurisdiction: err.jurisdiction, reason: err.code },
      }
    }
    if (getStructuredError(err).retryable) throw err
    log.error('measure source failed', err as Error, { measureId: measure.id })
    return {
      ok: false,
      code: 'MEASURE_SOURCE_FAILED',
      messageSv: `${measure.name_sv} kunde inte beräknas: underlaget (${measure.equals.report}) gick inte att läsa. Inget värde har räknats fram.`,
      details: { measure_id: measure.id, report: measure.equals.report },
    }
  }
}

function explainHandle(companyId: string, measure: AnyMeasureDefinition, scope: ResolvedScope): MeasureExplainHandle {
  const params = scopeParams(scope)
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)] as [string, string]),
  ).toString()
  return {
    tool: 'gnubok_explain_measure',
    arguments: { measure_id: measure.id, ...params },
    v1_path: `/api/v1/companies/${companyId}/measures/${measure.id}/explain${query ? `?${query}` : ''}`,
  }
}

function vatPeriodOf(scope: ResolvedScope): MeasureValue['vat_period'] {
  return scope.kind === 'vat_period' ? { period_type: scope.periodType, year: scope.year, period: scope.period } : null
}

/** One measure's value, with what it covers and the handle that explains it. */
export async function getMeasure(
  ctx: MeasureContext,
  measureId: string,
  params: MeasureParams,
  options: { today?: string } = {},
): Promise<MeasureOutcome<MeasureValue>> {
  if (!isMeasureId(measureId)) return unknownMeasure(measureId)
  const measure = getMeasureDefinition(measureId)
  return guarded(measure, async () => {
    const scope = await resolveScope(ctx, measure, params, options.today)
    const { result } = await measure.compute(ctx, scope)
    return {
      measure_id: measure.id,
      name_sv: measure.name_sv,
      name_en: measure.name_en,
      definition: measure.definition,
      unit: measure.unit,
      value: result.value,
      count: result.count,
      as_of: result.as_of,
      period: result.period,
      vat_period: vatPeriodOf(scope),
      equals: measure.equals,
      caveats: result.caveats,
      data_status: result.data_status,
      explain: explainHandle(ctx.companyId, measure, scope),
    }
  })
}

/** One measure's value and what it adds, down to the journal lines or invoices (paged). */
export async function explainMeasure(
  ctx: MeasureContext,
  measureId: string,
  params: MeasureParams,
  page: { limit?: number; offset?: number } = {},
  options: { today?: string } = {},
): Promise<MeasureOutcome<MeasureExplanation>> {
  if (!isMeasureId(measureId)) return unknownMeasure(measureId)
  const measure = getMeasureDefinition(measureId)
  const limit = Math.min(Math.max(page.limit ?? DEFAULT_DRILLDOWN_LIMIT, 1), MAX_DRILLDOWN_LIMIT)
  const offset = Math.max(page.offset ?? 0, 0)
  return guarded(measure, async () => {
    const scope = await resolveScope(ctx, measure, params, options.today)
    const computed = await measure.compute(ctx, scope)
    const breakdown = await measure.explain(ctx, scope, computed)
    const paged = pageOf<unknown>(breakdown.drilldown.items, { limit, offset })
    return {
      measure_id: measure.id,
      name_sv: measure.name_sv,
      unit: measure.unit,
      value: computed.result.value,
      count: computed.result.count,
      as_of: computed.result.as_of,
      period: computed.result.period,
      equals: measure.equals,
      contributors: breakdown.contributors,
      drilldown: {
        kind: breakdown.drilldown.kind,
        items: paged.items,
        total: paged.total,
        offset,
        next_offset: paged.next_offset,
      } as MeasureExplanation['drilldown'],
      reconciles: breakdown.reconciles,
      reconciliation_note: breakdown.reconciliation_note ?? null,
    }
  })
}

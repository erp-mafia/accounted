/**
 * The unexplained queue: differences that should be zero, run on demand,
 * each with what it compares, where a person sees the same figures, and the
 * call that names the items behind it.
 *
 * The answers the doors serve (lib/operations/unexplained.ts):
 *   - listUnexplained(): every check run for the company, one row per
 *     subject, the unexplained ones first, then the ones that could not be
 *     checked (with the reason), then the ones that are ok;
 *   - getUnexplainedCheck(): one check with its definition, basis, the
 *     figures it compares and every subject's result with both figures;
 *   - explainUnexplained(): one subject's difference broken into parts and
 *     the items behind them (typed handles), paged.
 *
 * A check never throws past this file: a failed read is a cannot_check with
 * SOURCE_FAILED (retryable when transient). The doors refuse only what the
 * caller sent wrong (an unknown check, a subject that does not exist).
 */
import { todayIsoStockholm } from '@/lib/dates/iso'
import { pageOf } from '@/lib/measures/explain'
import { bankBalanceVsBank } from './checks/bank-balance'
import { payablesVsLedger, receivablesVsLedger } from './checks/reskontra'
import { skattekontoVsSkatteverket } from './checks/skattekonto'
import { unbookedBankLinesOverdue } from './checks/unbooked-bank'
import { vatDeclaredNotSettled } from './checks/vat-settlement'
import { cannotCheck, sourceFailed } from './shared'
import {
  CHECK_IDS,
  SUBJECT_PARAM_KEYS,
  isCheckId,
  type AnyCheckDefinition,
  type CheckBreakdown,
  type CheckContext,
  type CheckId,
  type CheckItem,
  type CheckNextAction,
  type CheckPart,
  type CheckRefusal,
  type CheckRun,
  type CheckSide,
  type CheckSource,
  type CheckStatus,
  type CheckSubject,
  type CheckSubjectParams,
  type UnexplainedErrorCode,
} from './types'

/** Every check, in the order the queue lists them within a status. */
export const CHECK_DEFINITIONS = [
  receivablesVsLedger,
  payablesVsLedger,
  bankBalanceVsBank,
  skattekontoVsSkatteverket,
  vatDeclaredNotSettled,
  unbookedBankLinesOverdue,
] as const satisfies ReadonlyArray<AnyCheckDefinition>

const BY_ID = new Map<string, AnyCheckDefinition>(
  (CHECK_DEFINITIONS as ReadonlyArray<AnyCheckDefinition>).map((c) => [c.id, c]),
)

export function getCheckDefinition(id: CheckId): AnyCheckDefinition {
  return BY_ID.get(id)!
}

export const REGISTERED_CHECK_IDS: readonly CheckId[] = CHECK_DEFINITIONS.map((c) => c.id)

/** Default and largest page of an item list. Small: an agent reads the first page and acts. */
export const DEFAULT_ITEM_LIMIT = 25
export const MAX_ITEM_LIMIT = 200

/** Rows the list answers before it stops and says how many it left out. */
export const MAX_LIST_ROWS = 30

export type UnexplainedOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: UnexplainedErrorCode; messageSv: string; details: Record<string, unknown> }

/** The call that explains one result. */
export interface UnexplainedExplainHandle {
  tool: 'gnubok_explain_unexplained'
  arguments: { check_id: CheckId } & CheckSubjectParams
  v1_path: string
}

/** A subject in the queue's compact form: just enough to tell rows apart. */
export type CompactSubject =
  | { kind: 'company' }
  | { kind: 'bank_account'; cash_account_id: string; handle: string | null; account_number: string; name: string }
  | { kind: 'vat_period'; period_type: string; year: number; period: number; label: string }

/** One row of the queue. */
export interface UnexplainedRow {
  check_id: CheckId
  name_sv: string
  status: CheckStatus
  subject: CompactSubject
  difference: number | null
  unit: 'SEK' | 'count'
  as_of: string
  summary_sv: string
  /** cannot_check only: the typed reason (message in summary_sv). */
  refusal_code: CheckRefusal['code'] | null
  /** unexplained only: the tool or screen that fixes it. */
  next: { tool: string; arguments?: Record<string, unknown>; screen: string } | null
  explain: UnexplainedExplainHandle
}

export interface UnexplainedList {
  as_of: string
  counts: Record<CheckStatus, number>
  /** Unexplained first (largest SEK difference first), then cannot_check, then ok. */
  items: UnexplainedRow[]
  /** Rows left out past MAX_LIST_ROWS (the ok rows go first). */
  truncated: number
}

export interface CheckSummary {
  check_id: CheckId
  name_sv: string
  name_en: string
  definition: string
  definition_sv: string
  basis: string
  unit: 'SEK' | 'count'
  tolerance: number
  subject_kind: CheckSubject['kind']
  compares: CheckSource[]
}

export interface UnexplainedResult {
  status: CheckStatus
  subject: CheckSubject
  difference: number | null
  as_of: string
  summary_sv: string
  sides: CheckSide[]
  refusal: CheckRefusal | null
  facts: Record<string, unknown> | null
  next_action: CheckNextAction | null
  explain: UnexplainedExplainHandle
}

export interface UnexplainedCheck extends CheckSummary {
  next_action: CheckNextAction
  status: CheckStatus
  results: UnexplainedResult[]
}

export interface UnexplainedExplanation {
  check_id: CheckId
  name_sv: string
  status: CheckStatus
  subject: CheckSubject
  difference: number | null
  unit: 'SEK' | 'count'
  as_of: string
  summary_sv: string
  sides: CheckSide[]
  refusal: CheckRefusal | null
  parts: CheckPart[]
  residual: number | null
  reconciles: boolean
  note: string | null
  items: { list: CheckItem[]; total: number; offset: number; next_offset: number | null }
  next_action: CheckNextAction | null
}

function contextOf(base: { supabase: CheckContext['supabase']; companyId: string }, today?: string): CheckContext {
  return { supabase: base.supabase, companyId: base.companyId, today: today ?? todayIsoStockholm() }
}

/** A check run, never thrown: a failure past the check's own guards is a cannot_check. */
async function safeRun(ctx: CheckContext, check: AnyCheckDefinition): Promise<CheckRun[]> {
  try {
    return await check.run(ctx)
  } catch (err) {
    return [cannotCheck({ kind: 'company' }, ctx.today, sourceFailed(check.id, check.name_sv, err))]
  }
}

function subjectParams(subject: CheckSubject): CheckSubjectParams {
  switch (subject.kind) {
    case 'company':
      return {}
    case 'bank_account':
      return { cash_account_id: subject.cash_account_id }
    case 'vat_period':
      return { period_type: subject.period_type, year: subject.year, period: subject.period }
  }
}

function explainHandle(companyId: string, check: AnyCheckDefinition, subject: CheckSubject): UnexplainedExplainHandle {
  const params = subjectParams(subject)
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)] as [string, string]),
  ).toString()
  return {
    tool: 'gnubok_explain_unexplained',
    arguments: { check_id: check.id, ...params },
    v1_path: `/api/v1/companies/${companyId}/unexplained/${check.id}/explain${query ? `?${query}` : ''}`,
  }
}

/** The fix for one subject: the definition's action with the subject's arguments. */
function nextActionFor(check: AnyCheckDefinition, subject: CheckSubject): CheckNextAction {
  const base = check.next_action
  if (subject.kind === 'bank_account') return { ...base, arguments: { ...base.arguments, cash_account_id: subject.cash_account_id } }
  if (subject.kind === 'vat_period') {
    return { ...base, arguments: { ...base.arguments, period_type: subject.period_type, year: subject.year, period: subject.period } }
  }
  return base
}

function compactSubject(subject: CheckSubject): CompactSubject {
  if (subject.kind === 'vat_period') {
    return { kind: 'vat_period', period_type: subject.period_type, year: subject.year, period: subject.period, label: subject.label }
  }
  return subject
}

const STATUS_ORDER: Record<CheckStatus, number> = { unexplained: 0, cannot_check: 1, ok: 2 }

function rowOf(companyId: string, check: AnyCheckDefinition, run: CheckRun): UnexplainedRow {
  const next = run.status === 'unexplained' ? nextActionFor(check, run.subject) : null
  return {
    check_id: check.id,
    name_sv: check.name_sv,
    status: run.status,
    subject: compactSubject(run.subject),
    difference: run.difference,
    unit: check.unit,
    as_of: run.as_of,
    summary_sv: run.summary_sv,
    refusal_code: run.refusal?.code ?? null,
    next: next ? { tool: next.tool, ...(next.arguments ? { arguments: next.arguments } : {}), screen: next.screen } : null,
    explain: explainHandle(companyId, check, run.subject),
  }
}

function orderRows(rows: UnexplainedRow[]): UnexplainedRow[] {
  const checkOrder = new Map<string, number>(REGISTERED_CHECK_IDS.map((id, i) => [id, i]))
  return rows.sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    if (byStatus !== 0) return byStatus
    // Within unexplained, the largest money difference first; counts after money.
    if (a.status === 'unexplained' && a.unit !== b.unit) return a.unit === 'count' ? 1 : -1
    if (a.status === 'unexplained' && a.unit !== 'count') {
      const bySize = Math.abs(b.difference ?? 0) - Math.abs(a.difference ?? 0)
      if (bySize !== 0) return bySize
    }
    return (checkOrder.get(a.check_id) ?? 0) - (checkOrder.get(b.check_id) ?? 0)
  })
}

/** Every check run for the company: the queue. */
export async function listUnexplained(
  base: { supabase: CheckContext['supabase']; companyId: string },
  options: { today?: string; checks?: readonly CheckId[] } = {},
): Promise<UnexplainedList> {
  const ctx = contextOf(base, options.today)
  const checks = (options.checks ?? REGISTERED_CHECK_IDS).map(getCheckDefinition)
  const runs = await Promise.all(checks.map(async (check) => ({ check, runs: await safeRun(ctx, check) })))
  const rows = orderRows(runs.flatMap(({ check, runs: results }) => results.map((r) => rowOf(ctx.companyId, check, r))))
  const counts: Record<CheckStatus, number> = { unexplained: 0, cannot_check: 0, ok: 0 }
  for (const row of rows) counts[row.status] += 1
  return {
    as_of: ctx.today,
    counts,
    items: rows.slice(0, MAX_LIST_ROWS),
    truncated: Math.max(0, rows.length - MAX_LIST_ROWS),
  }
}

function summaryOf(check: AnyCheckDefinition): CheckSummary {
  return {
    check_id: check.id,
    name_sv: check.name_sv,
    name_en: check.name_en,
    definition: check.definition,
    definition_sv: check.definition_sv,
    basis: check.basis,
    unit: check.unit,
    tolerance: check.tolerance,
    subject_kind: check.subject_kind,
    compares: check.compares,
  }
}

/** The worst status of a check's results: unexplained, then cannot_check; ok only when every subject is ok. */
function overallStatus(runs: CheckRun[]): CheckStatus {
  if (runs.some((r) => r.status === 'unexplained')) return 'unexplained'
  if (runs.some((r) => r.status === 'cannot_check') || runs.length === 0) return 'cannot_check'
  return 'ok'
}

function unknownCheck(id: string): UnexplainedOutcome<never> {
  return {
    ok: false,
    code: 'UNEXPLAINED_CHECK_NOT_FOUND',
    messageSv: `Kontrollen ${JSON.stringify(id)} finns inte. Giltiga kontroller: ${CHECK_IDS.join(', ')}.`,
    details: { check_id: id, valid: [...CHECK_IDS] },
  }
}

/** One check: definition, basis, compared figures and every subject's result. */
export async function getUnexplainedCheck(
  base: { supabase: CheckContext['supabase']; companyId: string },
  checkId: string,
  options: { today?: string } = {},
): Promise<UnexplainedOutcome<UnexplainedCheck>> {
  if (!isCheckId(checkId)) return unknownCheck(checkId)
  const check = getCheckDefinition(checkId)
  const ctx = contextOf(base, options.today)
  const runs = await safeRun(ctx, check)
  return {
    ok: true,
    data: {
      ...summaryOf(check),
      next_action: check.next_action,
      status: overallStatus(runs),
      results: runs.map((run) => ({
        status: run.status,
        subject: run.subject,
        difference: run.difference,
        as_of: run.as_of,
        summary_sv: run.summary_sv,
        sides: run.sides,
        refusal: run.refusal,
        facts: run.facts ?? null,
        next_action: run.status === 'unexplained' ? nextActionFor(check, run.subject) : null,
        explain: explainHandle(ctx.companyId, check, run.subject),
      })),
    },
  }
}

function sameSubject(subject: CheckSubject, params: CheckSubjectParams): boolean {
  switch (subject.kind) {
    case 'company':
      return true
    case 'bank_account':
      return params.cash_account_id === subject.cash_account_id
    case 'vat_period':
      return params.period_type === subject.period_type && params.year === subject.year && params.period === subject.period
  }
}

const SUBJECT_PARAMS_BY_KIND: Record<CheckSubject['kind'], ReadonlyArray<keyof CheckSubjectParams>> = {
  company: [],
  bank_account: ['cash_account_id'],
  vat_period: ['period_type', 'year', 'period'],
}

/** Picks the subject the caller named, or refuses with what it can name. */
function pickRun(
  check: AnyCheckDefinition,
  runs: CheckRun[],
  params: CheckSubjectParams,
): { ok: true; run: CheckRun } | Extract<UnexplainedOutcome<never>, { ok: false }> {
  const accepted = SUBJECT_PARAMS_BY_KIND[check.subject_kind]
  const sent = SUBJECT_PARAM_KEYS.filter((key) => params[key] !== undefined)
  const refused = sent.filter((key) => !accepted.includes(key))
  if (refused.length > 0) {
    return {
      ok: false,
      code: 'UNEXPLAINED_PARAMETER_NOT_ACCEPTED',
      messageSv: `${check.name_sv} tar inte ${refused.join(', ')}.${accepted.length > 0 ? ` Giltiga parametrar: ${accepted.join(', ')}.` : ' Kontrollen gäller hela bolaget.'}`,
      details: { check_id: check.id, refused, accepted: [...accepted] },
    }
  }
  const named = sent.length > 0
  if (!named) {
    // One result, or a company-wide refusal standing in for every subject.
    if (runs.length === 1) return { ok: true, run: runs[0] }
    return {
      ok: false,
      code: 'UNEXPLAINED_SUBJECT_REQUIRED',
      messageSv: `${check.name_sv} har flera resultat: ange ${accepted.join(', ')} för det som ska förklaras.`,
      details: { check_id: check.id, required: [...accepted], subjects: runs.map((r) => subjectParams(r.subject)) },
    }
  }
  const run = runs.find((r) => r.subject.kind !== 'company' && sameSubject(r.subject, params))
  if (!run) {
    return {
      ok: false,
      code: 'UNEXPLAINED_SUBJECT_NOT_FOUND',
      messageSv: `${check.name_sv} har inget resultat för ${sent.map((k) => `${k}=${String(params[k])}`).join(', ')}.`,
      details: { check_id: check.id, subjects: runs.filter((r) => r.subject.kind !== 'company').map((r) => subjectParams(r.subject)) },
    }
  }
  return { ok: true, run }
}

const EMPTY_BREAKDOWN: CheckBreakdown = { parts: [], items: [], residual: null, reconciles: false }

/** One subject's difference: its parts and the items behind them, paged. */
export async function explainUnexplained(
  base: { supabase: CheckContext['supabase']; companyId: string },
  checkId: string,
  params: CheckSubjectParams,
  page: { limit?: number; offset?: number } = {},
  options: { today?: string } = {},
): Promise<UnexplainedOutcome<UnexplainedExplanation>> {
  if (!isCheckId(checkId)) return unknownCheck(checkId)
  const check = getCheckDefinition(checkId)
  const ctx = contextOf(base, options.today)
  const runs = await safeRun(ctx, check)
  const picked = pickRun(check, runs, params)
  if (!picked.ok) return picked
  const run = picked.run
  const limit = Math.min(Math.max(page.limit ?? DEFAULT_ITEM_LIMIT, 1), MAX_ITEM_LIMIT)
  const offset = Math.max(page.offset ?? 0, 0)

  let breakdown = EMPTY_BREAKDOWN
  let refusal = run.refusal
  let status = run.status
  if (run.status !== 'cannot_check') {
    try {
      breakdown = await check.explain(ctx, run)
    } catch (err) {
      // The difference stands (it was computed); only its parts could not be read.
      refusal = sourceFailed(check.id, `${check.name_sv}, förklaringen`, err)
      breakdown = { ...EMPTY_BREAKDOWN, note: 'The difference was computed, but the items behind it could not be read.' }
      status = run.status
    }
  }
  const paged = pageOf(breakdown.items, { limit, offset })
  return {
    ok: true,
    data: {
      check_id: check.id,
      name_sv: check.name_sv,
      status,
      subject: run.subject,
      difference: run.difference,
      unit: check.unit,
      as_of: run.as_of,
      summary_sv: run.summary_sv,
      sides: run.sides,
      refusal,
      parts: breakdown.parts,
      residual: breakdown.residual,
      reconciles: breakdown.reconciles,
      note: breakdown.note ?? null,
      items: { list: paged.items, total: paged.total, offset, next_offset: paged.next_offset },
      next_action: run.status === 'unexplained' ? nextActionFor(check, run.subject) : null,
    },
  }
}

/** The agent briefing's block: counts and the top rows, never the full list. */
export interface UnexplainedBriefing {
  tool: 'gnubok_list_unexplained'
  as_of: string
  unexplained: number
  cannot_check: number
  top: Array<{ check_id: CheckId; name_sv: string; subject?: string; difference: number | null; unit: 'SEK' | 'count' }>
}

/** Rows the briefing names. */
export const BRIEFING_TOP = 3

export async function summarizeUnexplained(
  base: { supabase: CheckContext['supabase']; companyId: string },
  options: { today?: string } = {},
): Promise<UnexplainedBriefing> {
  const list = await listUnexplained(base, options)
  return {
    tool: 'gnubok_list_unexplained',
    as_of: list.as_of,
    unexplained: list.counts.unexplained,
    cannot_check: list.counts.cannot_check,
    top: list.items
      .filter((r) => r.status === 'unexplained')
      .slice(0, BRIEFING_TOP)
      .map((r) => ({
        check_id: r.check_id,
        name_sv: r.name_sv,
        ...(r.subject.kind === 'bank_account'
          ? { subject: r.subject.account_number }
          : r.subject.kind === 'vat_period'
            ? { subject: r.subject.label }
            : {}),
        difference: r.difference,
        unit: r.unit,
      })),
  }
}

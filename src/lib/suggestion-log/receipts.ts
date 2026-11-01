import { chunk } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { slateAccount } from '@/lib/bookkeeping/proposal'
import { dbError } from '@/lib/errors/db-error'
import { isMissingColumnError } from '@/lib/pending-operations/agent-reason'
import type { BankLineFinal, DecisionOutcome, LoggedSuggestion } from './classify'
import type { InboxFinal, InboxSuggestion } from './inbox-classify'
import { DECISION_CHECK_RESULTS } from './checks'

/**
 * Decision receipts: what is recorded about an automated or agent decision,
 * read back into one typed receipt. No table of its own.
 *
 * A receipt is one suggestion_log row (the suggestions on offer, the one
 * acted on, what was booked, who decided), about a bank line, an underlag or
 * an approved staged operation (kind 'operation', written by ./operation.ts
 * after commitPendingOperation, one per voucher the approval posted), joined
 * with:
 *   - the booked voucher's committed actor columns (credential label, HOW it
 *     was committed, voucher number), which the commit RPC stamps on the
 *     immutable entry;
 *   - the pending_operations row that carried the decision, when an agent
 *     staged it and a person approved it (who proposed, which model): named
 *     by the row's pending_operation_id, or for a row written before that
 *     was recorded, found by the voucher in a committed operation's
 *     result_data.
 *
 * Links are resolved here, by the reader, never written onto a posted entry
 * (the decision row points at its voucher through final.journal_entry_id; a
 * samlingsverifikat carries one row per bank line).
 *
 * Confidence is the acted-on suggestion's recorded score. Bank-line scores
 * come from deterministic backing (rules, templates, history; an assistant
 * read is floored and capped by candidate backing), so they are 'backing'. An
 * inbox extraction's score is the reading model's own number, so it is
 * labelled 'model_reported' and never presented as evidence. A staged
 * operation carries no score: its basis is null.
 *
 * rule_version, policy_version, input_hash, checks, confidence_band and
 * agent_reason (the reason the agent gave when it staged the operation) are
 * read as they were recorded at decision time (./record.ts, ./inbox.ts,
 * ./operation.ts),
 * never derived here: the rules and thresholds in force now are not the ones
 * a past decision was made under. A row written before they were recorded
 * answers explicit nulls, not omissions, so a reader can tell "not recorded"
 * from "absent by mistake".
 */

/** At most this many receipts per subject: a samlingsverifikat can carry hundreds of bank lines. */
export const MAX_RECEIPTS_PER_SUBJECT = 100

const ID_CHUNK = 200

export const DECISION_ACTOR_TYPES = [
  'user',
  'api_key',
  'mcp_oauth',
  'cron',
  'system',
  'agent_chat',
  'service_account',
] as const
export type DecisionActorType = (typeof DECISION_ACTOR_TYPES)[number]

const CANDIDATE_SOURCES = [
  'assistant',
  'rule',
  'catalog',
  'counterparty_template',
  'recent',
  'extraction',
  'pending_operation',
] as const

const DecisionCandidateSchema = z.object({
  source: z.enum(CANDIDATE_SOURCES),
  source_id: z.string(),
  rank: z.number().int(),
  accounts: z
    .array(z.string())
    .describe(
      "The business account the suggestion books (bank line), or the result accounts read off the document (underlag). Empty for a staged operation: the voucher's own lines are what it booked.",
    ),
  vat_treatment: z.string().nullable(),
  confidence: z.number().nullable(),
  model: z.string().nullable(),
  prompt_sha256: z.string().nullable(),
  matches_final: z.boolean().describe('True when what was booked agrees with this suggestion.'),
  contested: z.boolean(),
  agreement: z
    .number()
    .nullable()
    .describe("Assistant only: the read's self-consistency agreement (share of samples that chose this account)."),
  from_candidate: z
    .boolean()
    .nullable()
    .describe('Assistant only: true when the read chose one of the deterministic candidates rather than a category default.'),
  reasoning_sha256: z
    .string()
    .nullable()
    .describe("Assistant only: SHA-256 of the read's reasoning, kept because the read itself is replaced by the next one."),
})

const DecisionCheckSchema = z.object({
  id: z
    .string()
    .describe(
      'already_booked, duplicate, currency, reverse_charge_seller_vat, counter_legs, bank_line_direction, chart, dimension_policy, invoice_match, period_lock, document_reuse, payee_alert or representation_vat_cap.',
    ),
  result: z.enum(DECISION_CHECK_RESULTS),
  detail: z.string().nullable().describe("Why, for anything but a plain pass, e.g. 'force:journal_entry:<id>' or 'confirm_no_match'."),
})

export const DecisionReceiptSchema = z.object({
  receipt_id: z.string().uuid().describe('The suggestion_log row.'),
  subject_kind: z
    .enum(['bank_line', 'inbox_item', 'operation'])
    .describe('operation: a staged operation (MCP, REST ?stage=true, Att göra) approved and committed; its one candidate is the staged proposal, named by proposed_by.'),
  decided_at: z.string(),
  outcome: z
    .enum(['accepted', 'changed', 'manual', 'dismissed'])
    .describe('accepted: booked as suggested. changed: started from a suggestion, booked something else. manual: booked without acting on one. dismissed: bank line ignored or underlag deleted.'),
  decided_by: z.object({
    actor_type: z.enum(DECISION_ACTOR_TYPES),
    user_id: z.string().nullable(),
    label: z.string().nullable().describe('Credential label at commit time (e.g. the API key name), when the voucher records one.'),
    commit_method: z.string().nullable(),
  }),
  proposed_by: z
    .object({
      pending_operation_id: z.string().uuid(),
      operation_type: z.string(),
      actor_type: z.string(),
      actor_id: z.string().nullable(),
      label: z.string().nullable(),
      user_id: z
        .string()
        .nullable()
        .optional()
        .describe("The person the operation was staged for: the key's owner, a service account's sponsor, who chatted. Absent when not read."),
      risk_level: z.string().nullable(),
      model: z.string().nullable(),
      prompt_hash: z.string().nullable(),
      staged_at: z.string(),
      approved_at: z.string().nullable(),
    })
    .nullable()
    .describe('The staged operation that carried the decision, when it was staged (by an agent, a key or a person) and then approved.'),
  candidates: z.array(DecisionCandidateSchema),
  chosen: DecisionCandidateSchema.nullable(),
  booked: z
    .object({
      journal_entry_id: z.string().nullable(),
      voucher: z.string().nullable(),
      entry_status: z.string().nullable(),
      account: z.string().nullable(),
      vat_treatment: z.string().nullable(),
      supplier_invoice_id: z.string().nullable(),
      changed_fields: z.array(z.string()),
    })
    .nullable(),
  evidence: z.object({
    transaction_id: z.string().nullable(),
    inbox_item_id: z.string().nullable(),
    document_ids: z.array(z.string()),
  }),
  confidence: z.object({
    value: z.number().nullable(),
    basis: z
      .enum(['backing', 'model_reported'])
      .nullable()
      .describe("backing: derived from deterministic evidence. model_reported: the reading model's own score, not evidence. Null without a score (a staged operation)."),
  }),
  rule_version: z
    .string()
    .nullable()
    .describe(
      'The rules that produced the suggestions on offer, as <pipeline>.<revision>[+<program version>]: bank-proposals for a bank line, inbox-extraction for an underlag. Null when not recorded (decisions before 2026-10-16, or a suggestion snapshot that failed).',
    ),
  policy_version: z
    .string()
    .nullable()
    .describe(
      'The approval policy confidence_band was evaluated under, thresholds included: direct-booking.<revision>;... for a bank line, staged-approval.<revision>;approver=person|credential[;unattended_limit=<SEK>|none] for a staged operation, grant.<revision>;grant_id=<id>;grant_version=<n> for one a company grant let through without a person. Null without a band.',
    ),
  input_hash: z
    .string()
    .nullable()
    .describe(
      'SHA-256 of the canonical JSON of the decision inputs, taken before booking: the bank line or underlag fields, its document hash and the suggestions (without matches_final); for a staged operation, its params and the preview the approver was shown. Recomputable from the records it names. Null when not recorded.',
    ),
  checks: z
    .array(DecisionCheckSchema)
    .nullable()
    .describe(
      'The guards the booking door ran before deciding, in order. A guard that did not apply is absent; warn marks an override or a guard that could not run. Null when the door does not report them or the decision predates them.',
    ),
  confidence_band: z
    .enum(['direct', 'review'])
    .nullable()
    .describe(
      "Under policy_version at decision time: direct, the acted-on suggestion books without a review; review, it opens one. From deterministic evidence, never the model's own score. For a staged operation: review when a person approved it, direct when a key credential did within its unattended ceiling or a company grant let it through. Null without an acted-on suggestion, and for an underlag.",
    ),
  agent_reason: z
    .string()
    .nullable()
    .describe(
      'Why the agent that staged the operation proposed it, in its own words, as the approver saw it (the reason given when staging, at most 500 characters). Null when none was given, for a decision no staged operation carried, and for decisions before 2026-10-28.',
    ),
  review_shown: z
    .boolean()
    .nullable()
    .describe(
      "Whether the person saw the booking's review before it was booked: false for a bank row's one click (booked without a review), true when it was booked from the review. Null when the door does not say (API, MCP and approvals) and for decisions recorded before it was.",
    ),
})

export type DecisionCandidate = z.infer<typeof DecisionCandidateSchema>
export type DecisionReceipt = z.infer<typeof DecisionReceiptSchema>

export type DecisionSubject = { journalEntryId: string } | { transactionId: string } | { documentId: string }

/** A suggestion_log row as the reader selects it. */
export interface SuggestionLogRow {
  id: string
  kind: 'bank_line' | 'inbox_item' | 'operation'
  transaction_id: string | null
  inbox_item_id: string | null
  document_id: string | null
  suggestions: unknown
  acted_on: number | null
  final: unknown
  outcome: DecisionOutcome
  actor_type: string
  resolved_by: string | null
  created_at: string
  // Recorded at decision time from 2026-10-16 (migration 20261016003000).
  rule_version?: string | null
  policy_version?: string | null
  input_hash?: string | null
  checks?: unknown
  confidence_band?: string | null
  pending_operation_id?: string | null
  // Copied from the approved operation from 2026-10-28 (migration 20261028210000).
  agent_reason?: string | null
  // Said by the dashboard's categorize door (migration 20261030131517).
  review_shown?: boolean | null
}

export interface ReceiptEntryRow {
  id: string
  voucher_series: string | null
  voucher_number: number | null
  status: string | null
  committed_actor_type?: string | null
  committed_actor_label: string | null
  commit_method: string | null
}

export interface ReceiptOperationRow {
  id: string
  operation_type: string
  actor_type: string
  actor_id: string | null
  actor_label: string | null
  /** The person the operation was staged for. Absent from behandlingshistorik_decisions rows. */
  user_id?: string | null
  risk_level: string | null
  agent_metadata: { model?: unknown; prompt_hash?: unknown } | null
  created_at: string
  resolved_at: string | null
  journal_entry_id: string | null
  registration_journal_entry_id: string | null
}

export interface ReceiptContext {
  entries: Map<string, ReceiptEntryRow>
  /** Keyed by the journal entry the operation booked (rows without pending_operation_id). */
  operations: Map<string, ReceiptOperationRow>
  /** Keyed by operation id (rows that name their pending_operation_id). */
  operationsById?: Map<string, ReceiptOperationRow>
}

// ── Pure: one row (+ context) → one receipt ─────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function actorType(v: unknown): DecisionActorType {
  return (DECISION_ACTOR_TYPES as readonly string[]).includes(v as string) ? (v as DecisionActorType) : 'user'
}

export function voucherLabel(entry: Pick<ReceiptEntryRow, 'voucher_series' | 'voucher_number'> | undefined): string | null {
  if (!entry || !entry.voucher_number) return null
  return formatVoucher(entry)
}

/** The journal entry a decision booked, read off its final. */
export function bookedEntryId(row: Pick<SuggestionLogRow, 'final'>): string | null {
  return isRecord(row.final) ? str(row.final.journal_entry_id) : null
}

function candidateFrom(raw: unknown): DecisionCandidate | null {
  if (!isRecord(raw)) return null
  const source = raw.source
  if (!(CANDIDATE_SOURCES as readonly string[]).includes(source as string)) return null
  const proposal = isRecord(raw.proposal) ? raw.proposal : {}
  let accounts: string[] = []
  let vat: string | null = null
  if (source === 'extraction') {
    const fields = (proposal as Partial<InboxSuggestion['proposal']>).fields
    const read = isRecord(fields) ? (fields.accounts as unknown) : null
    accounts = Array.isArray(read) ? read.filter((a): a is string => typeof a === 'string') : []
  } else {
    const p = proposal as Partial<LoggedSuggestion['proposal']>
    if (typeof p.debit_account === 'string' && typeof p.credit_account === 'string') {
      accounts = [slateAccount({ debit_account: p.debit_account, credit_account: p.credit_account, line_pattern: p.line_pattern })]
    }
    vat = str(p.vat_treatment)
  }
  return {
    source: source as DecisionCandidate['source'],
    source_id: str(raw.source_id) ?? '',
    rank: num(raw.rank) ?? 0,
    accounts,
    vat_treatment: vat,
    confidence: num(raw.confidence),
    model: str(raw.model),
    prompt_sha256: str(raw.prompt_sha256),
    matches_final: raw.matches_final === true,
    contested: raw.contested === true,
    agreement: num(raw.agreement),
    from_candidate: typeof raw.from_candidate === 'boolean' ? raw.from_candidate : null,
    reasoning_sha256: str(raw.reasoning_sha256),
  }
}

function checksFrom(raw: unknown): DecisionReceipt['checks'] {
  if (!Array.isArray(raw)) return null
  return raw
    .filter(isRecord)
    .filter((c) => typeof c.id === 'string' && (DECISION_CHECK_RESULTS as readonly unknown[]).includes(c.result))
    .map((c) => ({ id: c.id as string, result: c.result as DecisionCheckResultValue, detail: str(c.detail) }))
}

type DecisionCheckResultValue = (typeof DECISION_CHECK_RESULTS)[number]

function confidenceBasis(chosen: DecisionCandidate | null): DecisionReceipt['confidence']['basis'] {
  if (!chosen || chosen.source === 'pending_operation') return null
  return chosen.source === 'extraction' ? 'model_reported' : 'backing'
}

function bandFrom(raw: unknown): DecisionReceipt['confidence_band'] {
  return raw === 'direct' || raw === 'review' ? raw : null
}

function bookedFrom(row: SuggestionLogRow, entry: ReceiptEntryRow | undefined): DecisionReceipt['booked'] {
  if (!isRecord(row.final)) return null
  const final = row.final as Partial<BankLineFinal> & Partial<InboxFinal>
  const changed = Array.isArray(final.changed_fields)
    ? (final.changed_fields as unknown[]).filter((f): f is string => typeof f === 'string')
    : []
  return {
    journal_entry_id: str(final.journal_entry_id),
    voucher: voucherLabel(entry),
    entry_status: entry?.status ?? null,
    account: str(final.account),
    vat_treatment: str(final.vat_treatment),
    supplier_invoice_id: str(final.supplier_invoice_id),
    changed_fields: changed,
  }
}

export function buildDecisionReceipt(row: SuggestionLogRow, ctx: ReceiptContext): DecisionReceipt {
  const candidates = (Array.isArray(row.suggestions) ? row.suggestions : [])
    .map(candidateFrom)
    .filter((c): c is DecisionCandidate => c !== null)
  const chosen = row.acted_on != null ? (candidates[row.acted_on] ?? null) : null
  const entryId = bookedEntryId(row)
  const entry = entryId ? ctx.entries.get(entryId) : undefined
  // A row that names its operation is read by it, never by voucher matching.
  const op = row.pending_operation_id
    ? ctx.operationsById?.get(row.pending_operation_id)
    : entryId
      ? ctx.operations.get(entryId)
      : undefined
  const meta = op?.agent_metadata ?? null

  return {
    receipt_id: row.id,
    subject_kind: row.kind,
    decided_at: row.created_at,
    outcome: row.outcome,
    decided_by: {
      actor_type: actorType(row.actor_type),
      user_id: row.resolved_by,
      // The voucher's label is the relaying credential of the same commit:
      // the decision row is written inside the request that committed it.
      label: entry?.committed_actor_label ?? op?.actor_label ?? null,
      commit_method: entry?.commit_method ?? null,
    },
    proposed_by: op
      ? {
          pending_operation_id: op.id,
          operation_type: op.operation_type,
          actor_type: op.actor_type,
          actor_id: op.actor_id,
          label: op.actor_label,
          ...(op.user_id !== undefined ? { user_id: op.user_id } : {}),
          risk_level: op.risk_level,
          model: str(meta?.model),
          prompt_hash: str(meta?.prompt_hash),
          staged_at: op.created_at,
          approved_at: op.resolved_at,
        }
      : null,
    candidates,
    chosen,
    booked: bookedFrom(row, entry),
    evidence: {
      transaction_id: row.transaction_id,
      inbox_item_id: row.inbox_item_id,
      document_ids: row.document_id ? [row.document_id] : [],
    },
    confidence: {
      value: chosen?.confidence ?? null,
      basis: confidenceBasis(chosen),
    },
    rule_version: str(row.rule_version),
    policy_version: str(row.policy_version),
    input_hash: str(row.input_hash),
    checks: checksFrom(row.checks),
    confidence_band: bandFrom(row.confidence_band),
    agent_reason: str(row.agent_reason),
    review_shown: typeof row.review_shown === 'boolean' ? row.review_shown : null,
  }
}

/** Newest first; one receipt per suggestion_log row. */
export function buildDecisionReceipts(rows: SuggestionLogRow[], ctx: ReceiptContext): DecisionReceipt[] {
  return [...rows]
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
    .map((row) => buildDecisionReceipt(row, ctx))
}

// ── Compact view for MCP reads (payload budget) ─────────────────────

export interface CompactDecision {
  receipt_id: string
  decided_at: string
  outcome: DecisionReceipt['outcome']
  decided_by: { actor_type: DecisionActorType; label?: string }
  proposed_by?: { pending_operation_id: string; actor_type: string; label?: string; model?: string }
  chosen?: { source: DecisionCandidate['source']; accounts: string[]; confidence: number | null; confidence_basis: 'backing' | 'model_reported' | null }
  alternatives?: Array<{ source: DecisionCandidate['source']; accounts: string[] }>
  evidence: { transaction_id?: string; document_ids?: string[] }
  /** Other decisions booked on the same voucher (a samlingsverifikat carries one per bank line). */
  other_receipts?: number
  rule_version?: string
  confidence_band?: 'direct' | 'review'
  agent_reason?: string
  review_shown?: boolean
}

const MAX_ALTERNATIVES = 3

/** The newest receipt, compacted: nulls and empty lists are left out. */
export function toCompactDecision(receipts: DecisionReceipt[]): CompactDecision | null {
  const r = receipts[0]
  if (!r) return null
  const alternatives = r.candidates
    .filter((c) => c !== r.chosen)
    .slice(0, MAX_ALTERNATIVES)
    .map((c) => ({ source: c.source, accounts: c.accounts }))
  return {
    receipt_id: r.receipt_id,
    decided_at: r.decided_at,
    outcome: r.outcome,
    decided_by: { actor_type: r.decided_by.actor_type, ...(r.decided_by.label ? { label: r.decided_by.label } : {}) },
    ...(r.proposed_by
      ? {
          proposed_by: {
            pending_operation_id: r.proposed_by.pending_operation_id,
            actor_type: r.proposed_by.actor_type,
            ...(r.proposed_by.label ? { label: r.proposed_by.label } : {}),
            ...(r.proposed_by.model ? { model: r.proposed_by.model } : {}),
          },
        }
      : {}),
    ...(r.chosen
      ? {
          chosen: {
            source: r.chosen.source,
            accounts: r.chosen.accounts,
            confidence: r.confidence.value,
            confidence_basis: r.confidence.basis,
          },
        }
      : {}),
    ...(alternatives.length > 0 ? { alternatives } : {}),
    evidence: {
      ...(r.evidence.transaction_id ? { transaction_id: r.evidence.transaction_id } : {}),
      ...(r.evidence.document_ids.length > 0 ? { document_ids: r.evidence.document_ids } : {}),
    },
    ...(receipts.length > 1 ? { other_receipts: receipts.length - 1 } : {}),
    ...(r.rule_version ? { rule_version: r.rule_version } : {}),
    ...(r.confidence_band ? { confidence_band: r.confidence_band } : {}),
    ...(r.agent_reason ? { agent_reason: r.agent_reason } : {}),
    ...(typeof r.review_shown === 'boolean' ? { review_shown: r.review_shown } : {}),
  }
}

// ── IO ──────────────────────────────────────────────────────────────

/** The suggestion_log rows about one voucher, bank line or document, newest first. */
export async function fetchDecisionRows(
  supabase: SupabaseClient,
  companyId: string,
  subject: DecisionSubject,
): Promise<SuggestionLogRow[]> {
  const current = () =>
    supabase
      .from('suggestion_log')
      .select('id, kind, transaction_id, inbox_item_id, document_id, suggestions, acted_on, final, outcome, actor_type, resolved_by, created_at, rule_version, policy_version, input_hash, checks, confidence_band, pending_operation_id, agent_reason, review_shown')
      .eq('company_id', companyId)
  // Each step leaves out the newest column, while its migration has not run
  // yet: the code is live a few minutes before it does (20261030131517
  // review_shown, 20261028210000 agent_reason).
  const read = (columns: 'current' | 'without_review_shown' | 'without_agent_reason') => {
    const base =
      columns === 'current'
        ? current()
        : columns === 'without_review_shown'
          ? (supabase
              .from('suggestion_log')
              .select('id, kind, transaction_id, inbox_item_id, document_id, suggestions, acted_on, final, outcome, actor_type, resolved_by, created_at, rule_version, policy_version, input_hash, checks, confidence_band, pending_operation_id, agent_reason')
              .eq('company_id', companyId) as unknown as ReturnType<typeof current>)
          : (supabase
              .from('suggestion_log')
              .select('id, kind, transaction_id, inbox_item_id, document_id, suggestions, acted_on, final, outcome, actor_type, resolved_by, created_at, rule_version, policy_version, input_hash, checks, confidence_band, pending_operation_id')
              .eq('company_id', companyId) as unknown as ReturnType<typeof current>)
    const filtered =
      'journalEntryId' in subject
        ? base.eq('final->>journal_entry_id', subject.journalEntryId)
        : 'transactionId' in subject
          ? base.eq('transaction_id', subject.transactionId)
          : base.eq('document_id', subject.documentId)
    return filtered
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(MAX_RECEIPTS_PER_SUBJECT)
  }
  let result = await read('current')
  if (isMissingColumnError(result.error)) result = await read('without_review_shown')
  if (isMissingColumnError(result.error)) result = await read('without_agent_reason')
  const { data, error } = result
  if (error) throw dbError(error)
  return (data ?? []) as SuggestionLogRow[]
}

/** The row behandlingshistorik_decisions() returns: the decisions and what their receipts read. */
interface PeriodDecisionRows {
  rows: SuggestionLogRow[]
  entries: ReceiptEntryRow[]
  operations: ReceiptOperationRow[]
  legacy_by_entry: ReceiptOperationRow[]
  legacy_by_registration: ReceiptOperationRow[]
}

/**
 * The decisions behandlingshistoriken lists for a fiscal period, with the
 * context their receipts read, in one statement (behandlingshistorik_decisions,
 * migration 20261023094050): those registered inside the window, plus in
 * fiscal-year mode every decision that booked one of the period's vouchers
 * whenever it was made (a December bank line booked in January belongs to the
 * year it was booked in). The period's vouchers are joined in SQL: sent as
 * .in() lists of 200 ids they crossed the gateway's 8 KB request line and the
 * report answered 414 for every year with more than about 200 verifikat. The
 * context is the one loadReceiptContext builds.
 */
export async function fetchPeriodDecisions(
  supabase: SupabaseClient,
  companyId: string,
  args: { periodId: string; window: { fromTs: string; toTs: string }; fiscalYear: boolean },
): Promise<{ rows: SuggestionLogRow[]; context: ReceiptContext }> {
  const { data, error } = await supabase.rpc('behandlingshistorik_decisions', {
    p_company_id: companyId,
    p_period_id: args.periodId,
    p_from: args.window.fromTs,
    p_to: args.window.toTs,
    p_fiscal_year: args.fiscalYear,
  })
  if (error) throw dbError(error)
  const result = ((data as Partial<PeriodDecisionRows>[] | null) ?? [])[0] ?? {}
  const operations = new Map<string, ReceiptOperationRow>()
  keyLegacyOperations(operations, [...(result.legacy_by_entry ?? []), ...(result.legacy_by_registration ?? [])])
  return {
    rows: result.rows ?? [],
    context: {
      entries: new Map((result.entries ?? []).map((e) => [e.id, e])),
      operations,
      operationsById: new Map((result.operations ?? []).map((op) => [op.id, op])),
    },
  }
}

/**
 * Committed operations found by the voucher they booked (rows written before
 * pending_operation_id was recorded), keyed by that voucher: a categorize or
 * voucher op names it journal_entry_id, a supplier invoice registered from an
 * underlag registration_journal_entry_id. The latest approval wins when a
 * voucher was somehow carried twice.
 */
function keyLegacyOperations(into: Map<string, ReceiptOperationRow>, ops: ReceiptOperationRow[]): void {
  for (const op of ops) {
    const key = op.journal_entry_id ?? op.registration_journal_entry_id
    if (!key) continue
    const prev = into.get(key)
    if (!prev || (op.resolved_at ?? '') > (prev.resolved_at ?? '')) into.set(key, op)
  }
}

/**
 * The vouchers the rows booked and the committed operations that booked
 * them. `knownEntries` skips vouchers the caller already holds (the report
 * has the whole year's).
 */
export async function loadReceiptContext(
  supabase: SupabaseClient,
  companyId: string,
  rows: SuggestionLogRow[],
  options: { knownEntries?: Map<string, ReceiptEntryRow> } = {},
): Promise<ReceiptContext> {
  const entries = new Map<string, ReceiptEntryRow>()
  const operations = new Map<string, ReceiptOperationRow>()
  const operationsById = new Map<string, ReceiptOperationRow>()

  // Operations the rows name: read by id, whatever their final state (the
  // row exists only because the approval booked it).
  const operationIds = [...new Set(rows.map((r) => r.pending_operation_id).filter((id): id is string => !!id))]
  for (const ids of chunk(operationIds, ID_CHUNK)) {
    const { data, error } = await supabase
      .from('pending_operations')
      .select('id, operation_type, actor_type, actor_id, actor_label, user_id, risk_level, agent_metadata, created_at, resolved_at, journal_entry_id:result_data->>journal_entry_id, registration_journal_entry_id:result_data->>registration_journal_entry_id')
      .eq('company_id', companyId)
      .in('id', ids)
    if (error) throw dbError(error)
    for (const op of (data ?? []) as ReceiptOperationRow[]) operationsById.set(op.id, op)
  }

  const entryIds = [...new Set(rows.map(bookedEntryId).filter((id): id is string => !!id))]
  if (entryIds.length === 0) return { entries, operations, operationsById }

  const missing: string[] = []
  for (const id of entryIds) {
    const known = options.knownEntries?.get(id)
    if (known) entries.set(id, known)
    else missing.push(id)
  }
  for (const ids of chunk(missing, ID_CHUNK)) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number, status, committed_actor_type, committed_actor_label, commit_method')
      .eq('company_id', companyId)
      .in('id', ids)
    if (error) throw dbError(error)
    for (const row of (data ?? []) as ReceiptEntryRow[]) entries.set(row.id, row)
  }

  // Rows written before pending_operation_id was recorded: a categorize or
  // voucher op names its voucher journal_entry_id; a supplier invoice
  // registered from an underlag names it registration_journal_entry_id. Two
  // literal queries, not one .or(): the schema guard resolves only literal
  // filters.
  const legacyEntryIds = [
    ...new Set(rows.filter((r) => !r.pending_operation_id).map(bookedEntryId).filter((id): id is string => !!id)),
  ]
  for (const ids of chunk(legacyEntryIds, ID_CHUNK)) {
    const [byEntry, byRegistration] = await Promise.all([
      supabase
        .from('pending_operations')
        .select('id, operation_type, actor_type, actor_id, actor_label, user_id, risk_level, agent_metadata, created_at, resolved_at, journal_entry_id:result_data->>journal_entry_id, registration_journal_entry_id:result_data->>registration_journal_entry_id')
        .eq('company_id', companyId)
        .eq('status', 'committed')
        .in('result_data->>journal_entry_id', ids),
      supabase
        .from('pending_operations')
        .select('id, operation_type, actor_type, actor_id, actor_label, user_id, risk_level, agent_metadata, created_at, resolved_at, journal_entry_id:result_data->>journal_entry_id, registration_journal_entry_id:result_data->>registration_journal_entry_id')
        .eq('company_id', companyId)
        .eq('status', 'committed')
        .in('result_data->>registration_journal_entry_id', ids),
    ])
    if (byEntry.error) throw dbError(byEntry.error)
    if (byRegistration.error) throw dbError(byRegistration.error)
    keyLegacyOperations(operations, [...(byEntry.data ?? []), ...(byRegistration.data ?? [])] as ReceiptOperationRow[])
  }
  return { entries, operations, operationsById }
}

/**
 * Every decision receipt about one voucher, bank line or document, newest
 * first. Empty when nothing automated or recorded decided it (a hand-made
 * voucher, an import, anything booked before suggestion_log existed).
 */
export async function getDecisionReceipts(
  supabase: SupabaseClient,
  companyId: string,
  subject: DecisionSubject,
): Promise<DecisionReceipt[]> {
  const rows = await fetchDecisionRows(supabase, companyId, subject)
  if (rows.length === 0) return []
  const ctx = await loadReceiptContext(supabase, companyId, rows)
  return buildDecisionReceipts(rows, ctx)
}

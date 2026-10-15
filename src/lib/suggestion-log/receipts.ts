import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { slateAccount } from '@/lib/bookkeeping/proposal'
import { dbError } from '@/lib/errors/db-error'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { BankLineFinal, DecisionOutcome, LoggedSuggestion } from './classify'
import type { InboxFinal, InboxSuggestion } from './inbox-classify'

/**
 * Decision receipts, step 1: what is ALREADY recorded about an automated or
 * agent decision, read back into one typed receipt. No new table.
 *
 * A receipt is one suggestion_log row (the suggestions on offer, the one
 * acted on, what was booked, who decided), joined with:
 *   - the booked voucher's committed actor columns (credential label, HOW it
 *     was committed, voucher number), which the commit RPC stamps on the
 *     immutable entry;
 *   - the committed pending_operations row that carried the decision, when an
 *     agent staged it and a person approved it (who proposed, which model).
 *
 * Links are resolved here, by the reader, never written onto a posted entry
 * (the decision row points at its voucher through final.journal_entry_id; a
 * samlingsverifikat carries one row per bank line).
 *
 * Confidence is the acted-on suggestion's recorded score. Bank-line scores
 * come from deterministic backing (rules, templates, history; an assistant
 * read is floored and capped by candidate backing), so they are 'backing'. An
 * inbox extraction's score is the reading model's own number, so it is
 * labelled 'model_reported' and never presented as evidence.
 *
 * Fields the receipt will carry once they are recorded at decision time
 * (step 2) are explicit nulls today: rule_version, policy_version,
 * input_hash, checks and confidence_band. They are null, not omitted, so a
 * reader can tell "not recorded yet" from "absent by mistake".
 */

/** At most this many receipts per subject: a samlingsverifikat can carry hundreds of bank lines. */
export const MAX_RECEIPTS_PER_SUBJECT = 100

const ID_CHUNK = 200

export const DECISION_ACTOR_TYPES = ['user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat'] as const
export type DecisionActorType = (typeof DECISION_ACTOR_TYPES)[number]

const CANDIDATE_SOURCES = ['assistant', 'rule', 'catalog', 'counterparty_template', 'recent', 'extraction'] as const

const DecisionCandidateSchema = z.object({
  source: z.enum(CANDIDATE_SOURCES),
  source_id: z.string(),
  rank: z.number().int(),
  accounts: z
    .array(z.string())
    .describe('The business account the suggestion books (bank line), or the result accounts read off the document (underlag).'),
  vat_treatment: z.string().nullable(),
  confidence: z.number().nullable(),
  model: z.string().nullable(),
  prompt_sha256: z.string().nullable(),
  matches_final: z.boolean().describe('True when what was booked agrees with this suggestion.'),
  contested: z.boolean(),
})

export const DecisionReceiptSchema = z.object({
  receipt_id: z.string().uuid().describe('The suggestion_log row.'),
  subject_kind: z.enum(['bank_line', 'inbox_item']),
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
      risk_level: z.string().nullable(),
      model: z.string().nullable(),
      prompt_hash: z.string().nullable(),
      staged_at: z.string(),
      approved_at: z.string().nullable(),
    })
    .nullable()
    .describe('The staged operation that carried the decision, when an agent proposed it and a person approved it.'),
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
      .describe("backing: derived from deterministic evidence. model_reported: the reading model's own score, not evidence."),
  }),
  rule_version: z.literal(null).describe('Not recorded yet.'),
  policy_version: z.literal(null).describe('Not recorded yet.'),
  input_hash: z.literal(null).describe('Not recorded yet.'),
  checks: z.literal(null).describe('Not recorded yet.'),
  confidence_band: z.literal(null).describe('Not recorded yet.'),
})

export type DecisionCandidate = z.infer<typeof DecisionCandidateSchema>
export type DecisionReceipt = z.infer<typeof DecisionReceiptSchema>

export type DecisionSubject = { journalEntryId: string } | { transactionId: string } | { documentId: string }

/** A suggestion_log row as the reader selects it. */
export interface SuggestionLogRow {
  id: string
  kind: 'bank_line' | 'inbox_item'
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
  risk_level: string | null
  agent_metadata: { model?: unknown; prompt_hash?: unknown } | null
  created_at: string
  resolved_at: string | null
  journal_entry_id: string | null
  registration_journal_entry_id: string | null
}

export interface ReceiptContext {
  entries: Map<string, ReceiptEntryRow>
  /** Keyed by the journal entry the operation booked. */
  operations: Map<string, ReceiptOperationRow>
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
  if (!entry || entry.voucher_number == null) return null
  return `${entry.voucher_series ?? ''}${entry.voucher_number}`
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
  }
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
  const op = entryId ? ctx.operations.get(entryId) : undefined
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
      basis: chosen ? (chosen.source === 'extraction' ? 'model_reported' : 'backing') : null,
    },
    rule_version: null,
    policy_version: null,
    input_hash: null,
    checks: null,
    confidence_band: null,
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
  }
}

// ── IO ──────────────────────────────────────────────────────────────

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** The suggestion_log rows about one voucher, bank line or document, newest first. */
export async function fetchDecisionRows(
  supabase: SupabaseClient,
  companyId: string,
  subject: DecisionSubject,
): Promise<SuggestionLogRow[]> {
  const base = supabase
    .from('suggestion_log')
    .select('id, kind, transaction_id, inbox_item_id, document_id, suggestions, acted_on, final, outcome, actor_type, resolved_by, created_at')
    .eq('company_id', companyId)
  const filtered =
    'journalEntryId' in subject
      ? base.eq('final->>journal_entry_id', subject.journalEntryId)
      : 'transactionId' in subject
        ? base.eq('transaction_id', subject.transactionId)
        : base.eq('document_id', subject.documentId)
  const { data, error } = await filtered
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(MAX_RECEIPTS_PER_SUBJECT)
  if (error) throw dbError(error)
  return (data ?? []) as SuggestionLogRow[]
}

/**
 * The decisions registered inside a window, plus (in fiscal-year mode) every
 * decision that booked one of the year's vouchers whenever it was made: a
 * December bank line booked in January belongs to the year it was booked in.
 */
export async function fetchDecisionRowsInWindow(
  supabase: SupabaseClient,
  companyId: string,
  window: { fromTs: string; toTs: string },
  entryIds: string[] = [],
): Promise<SuggestionLogRow[]> {
  const byId = new Map<string, SuggestionLogRow>()
  const windowed = await fetchAllRows<SuggestionLogRow>(({ from, to }) =>
    supabase
      .from('suggestion_log')
      .select('id, kind, transaction_id, inbox_item_id, document_id, suggestions, acted_on, final, outcome, actor_type, resolved_by, created_at')
      .eq('company_id', companyId)
      .gte('created_at', window.fromTs)
      .lte('created_at', window.toTs)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
  for (const row of windowed) byId.set(row.id, row)
  for (const ids of chunk(entryIds, ID_CHUNK)) {
    const rows = await fetchAllRows<SuggestionLogRow>(({ from, to }) =>
      supabase
        .from('suggestion_log')
        .select('id, kind, transaction_id, inbox_item_id, document_id, suggestions, acted_on, final, outcome, actor_type, resolved_by, created_at')
        .eq('company_id', companyId)
        .in('final->>journal_entry_id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    )
    for (const row of rows) byId.set(row.id, row)
  }
  return [...byId.values()]
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
  const entryIds = [...new Set(rows.map(bookedEntryId).filter((id): id is string => !!id))]
  if (entryIds.length === 0) return { entries, operations }

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

  // A categorize or voucher op names its voucher journal_entry_id; a
  // supplier invoice registered from an underlag names it
  // registration_journal_entry_id. Two literal queries, not one .or():
  // the schema guard resolves only literal filters.
  for (const ids of chunk(entryIds, ID_CHUNK)) {
    const [byEntry, byRegistration] = await Promise.all([
      supabase
        .from('pending_operations')
        .select('id, operation_type, actor_type, actor_id, actor_label, risk_level, agent_metadata, created_at, resolved_at, journal_entry_id:result_data->>journal_entry_id, registration_journal_entry_id:result_data->>registration_journal_entry_id')
        .eq('company_id', companyId)
        .eq('status', 'committed')
        .in('result_data->>journal_entry_id', ids),
      supabase
        .from('pending_operations')
        .select('id, operation_type, actor_type, actor_id, actor_label, risk_level, agent_metadata, created_at, resolved_at, journal_entry_id:result_data->>journal_entry_id, registration_journal_entry_id:result_data->>registration_journal_entry_id')
        .eq('company_id', companyId)
        .eq('status', 'committed')
        .in('result_data->>registration_journal_entry_id', ids),
    ])
    if (byEntry.error) throw dbError(byEntry.error)
    if (byRegistration.error) throw dbError(byRegistration.error)
    for (const op of [...(byEntry.data ?? []), ...(byRegistration.data ?? [])] as ReceiptOperationRow[]) {
      const key = op.journal_entry_id ?? op.registration_journal_entry_id
      if (!key) continue
      // The latest approval wins when a voucher was somehow carried twice.
      const prev = operations.get(key)
      if (!prev || (op.resolved_at ?? '') > (prev.resolved_at ?? '')) operations.set(key, op)
    }
  }
  return { entries, operations }
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

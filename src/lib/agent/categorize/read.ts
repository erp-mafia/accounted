import type { SupabaseClient } from '@supabase/supabase-js'
import { gatherCandidates } from './candidates'
import { gatherUnderlag } from './underlag'
import { selectAccount, type AccountCandidate, type AccountSelection } from './select-account'
import { getAccountName } from '@/lib/bookkeeping/client-account-names'
import { accountProposal, categoryForAccount, withUnknownVat, type BookingProposal } from '@/lib/bookkeeping/proposal'
export { categoryForAccount }
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { EntityType, Transaction } from '@/types'
import { readIsFresh, firstSentence, readLeavesMomsUnknown, type AssistantRead } from './read-shape'
import { underlagKeyFor } from '@/lib/transactions/underlag-key'
import { createLogger } from '@/lib/logger'

const log = createLogger('agent/categorize/read')

/**
 * The assistant's read of one transaction, done before anyone opens it.
 *
 * `readTransaction` is the categorize cascade end to end (underlag, the
 * deterministic candidates, the model's pick) minus the write; `storeRead`
 * keeps the result in transaction_assistant_reads, one row per transaction,
 * so the list and the review open with it instead of fetching it while the
 * person waits. A read is fresh while the transaction's document_id is the
 * one it was made with; a receipt matched later makes it stale.
 */

export type { AssistantRead } from './read-shape'
export { readIsFresh, firstSentence } from './read-shape'
export { ASSISTANT_SURE, ASSISTANT_LIKELY } from '@/lib/transactions/direct-booking'

export interface ReadOptions {
  entityType: EntityType
  vatRegistered: boolean
  /** Extracted receipt/invoice text when the caller already has it. */
  underlag?: string
  /**
   * A document the caller attached for this read ahead of the row's own
   * document_id: the underlag uploaded in the review dialog is not linked
   * to the transaction until the booking exists, so without this the read
   * never sees it. Keys the read on that document.
   */
  documentId?: string | null
  samples?: number
}

export async function readTransaction(
  supabase: SupabaseClient,
  companyId: string,
  tx: Transaction,
  opts: ReadOptions,
): Promise<{ selection: AccountSelection; candidates: AccountCandidate[]; read: AssistantRead }> {
  const underlag =
    opts.underlag ?? (await gatherUnderlag(supabase, companyId, tx.id, opts.documentId ?? tx.document_id))
  const candidates = await gatherCandidates(supabase, companyId, tx)
  const selection = await selectAccount({
    companyId,
    transaction: {
      merchantName: tx.merchant_name,
      description: tx.description,
      amount: tx.amount,
      date: tx.date,
      currency: tx.currency,
    },
    underlag,
    candidates,
    entityType: opts.entityType,
    vatRegistered: opts.vatRegistered,
    samples: opts.samples,
  })
  const read: AssistantRead = {
    transaction_id: tx.id,
    underlag_key: opts.documentId ?? underlagKeyFor(tx),
    has_underlag: underlag.trim().length > 0,
    account: selection.account,
    category: selection.category,
    vat_treatment: selection.vatTreatment,
    reverse_charge: selection.reverseCharge,
    reverse_charge_kind: selection.reverseChargeKind,
    confidence: selection.confidence,
    model_confidence: selection.modelConfidence,
    agreement: selection.agreement,
    from_candidate: selection.fromCandidate,
    reasoning: selection.reasoning,
    candidates,
    model: selection.model,
    prompt_sha256: selection.promptSha256,
  }
  return { selection, candidates, read }
}

export async function storeRead(supabase: SupabaseClient, companyId: string, read: AssistantRead): Promise<void> {
  const row = {
    company_id: companyId,
    transaction_id: read.transaction_id,
    underlag_key: read.underlag_key,
    has_underlag: read.has_underlag,
    account: read.account,
    category: read.category,
    vat_treatment: read.vat_treatment,
    reverse_charge: read.reverse_charge,
    confidence: read.confidence,
    model_confidence: read.model_confidence,
    agreement: read.agreement,
    from_candidate: read.from_candidate,
    reasoning: read.reasoning,
    candidates: read.candidates,
    model: read.model,
    prompt_sha256: read.prompt_sha256 ?? null,
  }
  const store = (values: Record<string, unknown>) =>
    supabase.from('transaction_assistant_reads').upsert(values, { onConflict: 'transaction_id' })
  let { error } = await store({ ...row, reverse_charge_kind: read.reverse_charge_kind ?? null })
  // The code can reach production before the reverse_charge_kind column
  // does (the migration job queues behind other pipelines). PostgREST then
  // refuses the whole row (PGRST204): the read is kept without its box,
  // which books as an EU service, rather than lost.
  if (error?.code === 'PGRST204') ({ error } = await store(row))
  if (error) throw new Error(error.message)
}

/** The stored reads for these transactions, keyed by transaction id. */
export async function loadReads(
  supabase: SupabaseClient,
  companyId: string,
  transactionIds: string[],
): Promise<Map<string, AssistantRead>> {
  const out = new Map<string, AssistantRead>()
  if (transactionIds.length === 0) return out
  // Every column: naming reverse_charge_kind would fail the whole read, and
  // empty every row of its suggestion, while the code is live ahead of the
  // column (see storeRead).
  const { data } = await supabase
    .from('transaction_assistant_reads')
    .select('*')
    .eq('company_id', companyId)
    .in('transaction_id', transactionIds)
  for (const row of (data ?? []) as unknown as AssistantRead[]) {
    out.set(row.transaction_id, { ...row, confidence: Number(row.confidence), candidates: row.candidates ?? [] })
  }
  return out
}

/**
 * The read as a row proposal: the account with its name, booked as one
 * account with an explicit VAT, the first sentence of the reasoning as
 * the description. Null when the assistant found nothing that fits.
 */
export function assistantSuggestionFromRead(
  read: AssistantRead,
  tx: Pick<Transaction, 'id' | 'amount'>,
  entityType?: EntityType,
): BookingProposal | null {
  if (!read.account) return null
  const account = read.account
  const candidate = read.candidates.find((c) => c.account === account)
  const label = candidate?.label ?? getAccountName(account)
  const category = categoryForAccount(account, entityType, read.category)
  // A pick of a candidate whose moms is unknown: the review states the
  // underlag's moms. Passed on as null it was read as 'exempt' below.
  const vatUnknown = readLeavesMomsUnknown(read)
  const proposal = accountProposal({
    id: `assistant:${tx.id}`,
    source: 'assistant',
    account,
    label,
    category,
    // The read's moms is already resolved (selectAccount takes it from the
    // candidate, the template or the category): null there means the account
    // books none. Passed on as null, accountProposal took the category's
    // default and offered 1630 with 25 % moms (crm#1275).
    vat_treatment: read.vat_treatment ?? 'exempt',
    reverse_charge_kind: read.reverse_charge_kind,
    amount: tx.amount,
    confidence: read.confidence,
    description: firstSentence(read.reasoning),
    has_underlag: read.has_underlag,
  })
  return vatUnknown ? withUnknownVat(proposal) : proposal
}

export interface PlannedRead {
  companyId: string
  entityType: EntityType
  vatRegistered: boolean
  tx: Transaction
}

export interface PlanOptions {
  /** Reads per run, fleet-wide. */
  perRun: number
  /** Reads per company per run, so one backlog cannot starve the rest. */
  perCompany: number
  /** How far back an unbooked transaction is still worth a read. */
  windowDays: number
  now?: Date
}

const TX_COLUMNS =
  'id, company_id, document_id, merchant_name, description, original_description, amount, amount_sek, date, currency, category, is_business, is_ignored, mcc_code, cash_account_id, journal_entry_id'

/**
 * The next unbooked transactions worth a read: newest first, without a
 * fresh read, in companies that are not sandboxes and have the AI
 * capability. Service-role client: this crosses companies.
 */
export async function planAssistantReads(supabase: SupabaseClient, opts: PlanOptions): Promise<PlannedRead[]> {
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - opts.windowDays * 86_400_000).toISOString().slice(0, 10)
  // A failed read is a failed run, never an empty plan: this one query spans
  // every company, so its timeout would otherwise answer "nothing to read"
  // every ten minutes.
  const { data: rows, error: rowsError } = await supabase
    .from('transactions')
    .select(TX_COLUMNS)
    .is('is_business', null)
    .is('journal_entry_id', null)
    .eq('is_ignored', false)
    .gte('date', since)
    .order('date', { ascending: false })
    .limit(Math.max(opts.perRun * 8, 50))
  if (rowsError) throw new Error(`assistant read candidates failed: ${rowsError.message}`)
  const txs = ((rows ?? []) as unknown as Transaction[]).filter((t) => t.amount !== 0)
  if (txs.length === 0) return []

  const { data: readRows, error: readsError } = await supabase
    .from('transaction_assistant_reads')
    .select('transaction_id, underlag_key')
    .in('transaction_id', txs.map((t) => t.id))
  if (readsError) throw new Error(`assistant read freshness failed: ${readsError.message}`)
  const fresh = new Set<string>()
  for (const r of (readRows ?? []) as Array<{ transaction_id: string; underlag_key: string | null }>) {
    const tx = txs.find((t) => t.id === r.transaction_id)
    if (tx && readIsFresh(r, tx)) fresh.add(r.transaction_id)
  }

  const perCompany = new Map<string, Transaction[]>()
  for (const tx of txs) {
    if (fresh.has(tx.id)) continue
    const list = perCompany.get(tx.company_id) ?? []
    if (list.length >= opts.perCompany) continue
    list.push(tx)
    perCompany.set(tx.company_id, list)
  }

  const planned: PlannedRead[] = []
  for (const [companyId, list] of perCompany) {
    if (planned.length >= opts.perRun) break
    if (await isSandboxCompany(supabase, companyId)) continue
    if (!(await hasCapability(supabase, companyId, CAPABILITY.ai))) continue
    const [{ data: company, error: companyError }, { data: settings, error: settingsError }] = await Promise.all([
      supabase.from('companies').select('entity_type').eq('id', companyId).maybeSingle(),
      supabase.from('company_settings').select('vat_registered').eq('company_id', companyId).maybeSingle(),
    ])
    // Never guess the legal form or the VAT status: a read made as an
    // unregistered enskild firma is stored as fresh, and a sure one with a
    // receipt behind it books with one click. The company waits for the next run.
    if (companyError || settingsError) {
      log.error('assistant reads skipped a company: its legal form or VAT status could not be read', {
        companyId,
        message: (companyError ?? settingsError)?.message,
      })
      continue
    }
    const entityType = ((company?.entity_type as EntityType | undefined) ?? 'enskild_firma')
    const vatRegistered = settings?.vat_registered ?? false
    for (const tx of list) {
      if (planned.length >= opts.perRun) break
      planned.push({ companyId, entityType, vatRegistered, tx })
    }
  }
  return planned
}

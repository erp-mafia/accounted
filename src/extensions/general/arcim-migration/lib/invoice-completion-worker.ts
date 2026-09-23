import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { ExecutionBudgetExceeded, queryInExecutionBudget, withExecutionDeadline } from '@/lib/http/execution-budget'
import { resolveConsent, type ResolvedConsent } from '@/lib/providers/resolve-consent'
import { ProviderCallError } from '@/lib/providers/with-provider-call'
import { FortnoxApiError } from '@/lib/providers/fortnox/client'
import { fortnoxCompletionBlock, fortnoxCompletionRetrySeconds, type CompletionBlockReason } from '@/lib/providers/fortnox/completion-failure'
import { fetchInvoiceCompletionDetail, fetchInvoiceCompletionPage, type InvoiceCompletionSource } from '@/lib/providers/provider-data-fetcher'
import type { ProviderName } from '@/lib/providers/types'
import { completeInvoiceRows } from '@/lib/invoices/complete-invoice-rows'
import { COMPLETE_INVOICE_LINES_SOURCE, planInvoiceLineCompletion, type CandidateRow } from './complete-invoice-lines'

const log = createLogger('invoice-completion-worker')
const COMPANY_BUDGET_MS = 120_000
const WRITE_RESERVE_MS = 15_000
const QUERY_BUDGET_MS = 8_000

export interface InvoiceCompletionWork {
  company_id: string
  consent_id: string
  provider: ProviderName
  account_key: string
  scan_id: string
  part: 'invoices' | 'creditNotes'
  next_page: number | null
  worker_id: string
}
interface Candidate extends CandidateRow {
  ambiguous: boolean
  source_ref: InvoiceCompletionSource | null
}
interface Receipt {
  status: string
  headerUpdated?: boolean
  eventId?: string | null
}

export function emptyCompletionSummary() {
  return {
    companies: 0, completed: 0, alreadyCompleted: 0, headersUpdated: 0, historyAppended: 0,
    unmatched: 0, ambiguous: 0, providerEmpty: 0, totalMismatch: 0, rowsMismatch: 0, failed: 0,
    deferred: 0, uncertain: 0, companiesFailed: 0, companiesBlocked: 0, pages: 0,
    budgetReachedAt: null as string | null,
    // Counts describe this invocation. Delayed retries and undiscovered work
    // are not a measured backlog, so never infer backlog completion from them.
    scope: 'attempted_invoices' as const, backlogComplete: null,
  }
}
export type InvoiceCompletionSummary = ReturnType<typeof emptyCompletionSummary>

function addReceipt(result: InvoiceCompletionSummary, receipt: Receipt) {
  const key = { written: 'completed', already_filled: 'alreadyCompleted', unmatched: 'unmatched',
    ambiguous: 'ambiguous', provider_empty: 'providerEmpty', total_mismatch: 'totalMismatch',
    rows_mismatch: 'rowsMismatch', failed: 'failed' }[receipt.status] as
    'completed' | 'alreadyCompleted' | 'unmatched' | 'ambiguous' | 'providerEmpty' | 'totalMismatch' | 'rowsMismatch' | 'failed' | undefined
  if (key) result[key]++
  if (receipt.status === 'written') {
    if (receipt.headerUpdated) result.headersUpdated++
    if (receipt.eventId) result.historyAppended++
  }
}

async function stage<T>(name: string, deadline: number, fields: Record<string, unknown>, operation: () => Promise<T>): Promise<T> {
  const start = Date.now()
  log.info('invoice completion stage started', { stage: name, ...fields, remainingMs: deadline - start })
  try { return await withExecutionDeadline(deadline, name, operation) }
  finally { log.info('invoice completion stage finished', { stage: name, ...fields, durationMs: Date.now() - start }) }
}

async function rpc<T>(supabase: SupabaseClient, name: string, args: Record<string, unknown>, deadline: number): Promise<T> {
  return withExecutionDeadline(Math.min(deadline, Date.now() + QUERY_BUDGET_MS), name, async () => {
    const { data, error } = await queryInExecutionBudget(supabase.rpc(name, args))
    if (error) throw new Error(`${name}: ${error.message}`)
    return data as T
  })
}

/** Exported for integration tests with real provider transport and fake persistence. */
export async function completeInvoiceCompletionWork(
  supabase: SupabaseClient, work: InvoiceCompletionWork, deadline: number,
): Promise<InvoiceCompletionSummary> {
  const result = emptyCompletionSummary()
  result.companies = 1
  const providerDeadline = deadline - WRITE_RESERVE_MS
  const fields = { companyId: work.company_id, runId: work.worker_id }
  const args = { p_company_id: work.company_id, p_worker_id: work.worker_id }
  const confirmed = new Map<string, Receipt>()
  const uncertain = new Set<string>()
  let connection: ResolvedConsent | undefined
  let retrySeconds = 0
  let block: { reason: CompletionBlockReason; revision: string } | undefined
  let currentStage = 'candidate-selection'
  let pendingIds = new Set<string>()
  const connectionForWork = async () => {
    if (!connection) {
      currentStage = 'credential-resolution'
      connection = await stage(currentStage, providerDeadline, fields, () => resolveConsent(work.company_id, work.consent_id))
      const org = String(connection.consent.org_number ?? '').replace(/[^a-z0-9]/gi, '')
      const account = org || connection.providerCompanyId || work.consent_id
      if (connection.consent.provider !== work.provider || account !== work.account_key) throw new Error('MIGRATION_SOURCE_IDENTITY_CHANGED')
    }
    return connection
  }
  const record = async (row: Candidate, outcome: string) => {
    currentStage = 'persistence'
    let started = false
    try {
      const receipt = await stage(currentStage, deadline - 3000, { ...fields, invoiceId: row.id }, () => {
        started = true
        return rpc<Receipt>(supabase, 'finish_invoice_completion', { ...args, p_invoice_id: row.id, p_outcome: outcome }, deadline - 3000)
      })
      confirmed.set(row.id, receipt)
    } catch (error) { if (started) uncertain.add(row.id); throw error }
  }
  const candidates = async (mappedOnly: boolean) => {
    currentStage = 'candidate-selection'
    return stage(currentStage, providerDeadline, fields, () => rpc<Candidate[]>(supabase,
      'load_invoice_completion_candidates', { ...args, p_mapped_only: mappedOnly }, providerDeadline))
  }
  const process = async (mappedOnly: boolean) => {
    for (;;) {
      const batch = await candidates(mappedOnly)
      pendingIds = new Set(batch.map(row => row.id))
      if (!batch.length) return
      for (const row of batch) {
        if (Date.now() >= providerDeadline) throw new ExecutionBudgetExceeded('invoice-detail')
        if (row.ambiguous) await record(row, 'ambiguous')
        else if (!row.source_ref) await record(row, 'unmatched')
        else {
          const resolved = await connectionForWork()
          currentStage = 'invoice-detail'
          let dto
          try {
            dto = await stage(currentStage, providerDeadline, { ...fields, invoiceId: row.id }, () =>
              fetchInvoiceCompletionDetail(work.provider, resolved.accessToken, resolved.providerCompanyId, row.source_ref!))
          } catch (error) {
            if (error instanceof ExecutionBudgetExceeded) throw error
            if (work.provider === 'fortnox' && (fortnoxCompletionBlock(error) ||
              error instanceof ProviderCallError || (error instanceof FortnoxApiError && error.statusCode === 429))) throw error
            const status = (error as { statusCode?: number }).statusCode
            if (status === 401 || status === 403) throw error
            log.warn('invoice detail failed; retry scheduled', { ...fields, invoiceId: row.id, error: String(error) })
            await record(row, 'failed'); pendingIds.delete(row.id); continue
          }
          if (!dto || dto.id !== row.source_ref.id || dto.invoiceNumber !== row.invoice_number || dto.issueDate.slice(0, 10) !== row.invoice_date.slice(0, 10)) {
            await record(row, 'unmatched')
          } else {
            const prepared = planInvoiceLineCompletion(row, dto, work.company_id)
            if ('reason' in prepared) {
              await record(row, { noLinesAtProvider: 'provider_empty', totalMismatch: 'total_mismatch', rowsMismatch: 'rows_mismatch' }[prepared.reason])
            } else {
              currentStage = 'persistence'
              let started = false
              try {
                const receipt = await stage(currentStage, Math.min(deadline - 3000, Date.now() + QUERY_BUDGET_MS), { ...fields, invoiceId: row.id }, () => {
                  started = true
                  return completeInvoiceRows(supabase, {
                    companyId: work.company_id, invoiceId: row.id, rows: prepared.plan.items,
                    header: prepared.plan.header, headerBefore: row, historyClient: supabase,
                    completionWorkerId: work.worker_id,
                    trail: { source: COMPLETE_INVOICE_LINES_SOURCE, provider: work.provider, consentId: work.consent_id,
                      correlationId: work.worker_id, actor: { type: 'cron', id: COMPLETE_INVOICE_LINES_SOURCE } },
                  })
                })
                confirmed.set(row.id, receipt)
              } catch (error) { if (started) uncertain.add(row.id); throw error }
            }
          }
        }
        pendingIds.delete(row.id)
      }
    }
  }
  try {
    // Stable source identities can avoid discovery entirely for newer imports.
    await process(true)
    const remaining = await candidates(false)
    if (remaining.length) {
      pendingIds = new Set(remaining.map(row => row.id))
      if (work.next_page !== null) {
        const resolved = await connectionForWork()
        while (work.next_page !== null) {
          currentStage = 'provider-listing'
          const page: Awaited<ReturnType<typeof fetchInvoiceCompletionPage>> = await stage(currentStage, providerDeadline, { ...fields, page: work.next_page, part: work.part }, () =>
            fetchInvoiceCompletionPage(work.provider, resolved.accessToken, resolved.providerCompanyId, work.part, work.next_page!))
          currentStage = 'discovery-checkpoint'
          await stage(currentStage, deadline - 3000, fields, () => rpc(supabase, 'save_invoice_completion_page', {
            ...args, p_scan_id: work.scan_id, p_part: work.part, p_page: work.next_page, p_records: page.sources,
            p_next_page: page.nextPage, p_next_part: page.nextPart,
          }, deadline - 3000))
          result.pages++
          work.next_page = page.nextPage; work.part = page.nextPart
        }
      }
      // No fallback match is acted on until ALL pages have established uniqueness.
      await process(false)
    }
  } catch (error) {
    if (error instanceof ExecutionBudgetExceeded) {
      result.budgetReachedAt = currentStage
      log.info('invoice completion yielded at deadline', { ...fields, stage: currentStage })
    } else {
      result.companiesFailed++
      retrySeconds = work.provider === 'fortnox' ? fortnoxCompletionRetrySeconds(error) : 3600
      const reason = work.provider === 'fortnox' ? fortnoxCompletionBlock(error) : null
      const revision = error instanceof ProviderCallError ? error.credentialRevision ?? connection?.credentialRevision : connection?.credentialRevision
      if (reason && revision) block = { reason, revision }
      log.error('invoice completion company interrupted', { ...fields, stage: currentStage, error: String(error) })
    }
  }
  // The provider deadline leaves room for receipt recovery and releasing the
  // lease. If the DB is unavailable, the lease expires and unknown writes replay.
  if (uncertain.size && Date.now() < deadline - 1000) {
    try {
      const { data, error } = await stage('receipt-reconciliation', deadline - 1000, fields, () => queryInExecutionBudget(
        supabase.from('invoice_completion_entries').select('invoice_id, receipt')
          .eq('company_id', work.company_id).eq('run_id', work.worker_id).in('invoice_id', [...uncertain]),
      ))
      if (error) throw error
      for (const row of data ?? []) { confirmed.set(row.invoice_id, row.receipt as Receipt); uncertain.delete(row.invoice_id) }
    } catch { log.warn('invoice completion receipts remain uncertain', { ...fields, count: uncertain.size }) }
  }
  result.deferred = [...pendingIds].filter(id => !confirmed.has(id) && !uncertain.has(id)).length
  result.uncertain = uncertain.size
  for (const receipt of confirmed.values()) addReceipt(result, receipt)
  try {
    if (block) {
      const blocked = await rpc<boolean>(supabase, 'block_invoice_completion_work', {
        ...args, p_consent_id: work.consent_id, p_credential_revision: block.revision, p_reason: block.reason,
      }, deadline)
      if (blocked) result.companiesBlocked++
      // A newer revision/attempt won. Release only our lease, without imposing
      // the obsolete failure's delay on renewed credentials.
      else await rpc(supabase, 'release_invoice_completion_work', { ...args, p_retry_seconds: 0 }, deadline)
    } else await rpc(supabase, 'release_invoice_completion_work', { ...args, p_retry_seconds: retrySeconds }, deadline)
  }
  catch { log.warn('invoice completion lease will expire', fields) }
  return result
}

export async function runInvoiceCompletion(supabase: SupabaseClient, deadline: number): Promise<InvoiceCompletionSummary> {
  const result = emptyCompletionSummary()
  const visited: string[] = []
  try {
    await stage('company-discovery', deadline, {}, () => rpc(supabase, 'enqueue_invoice_completion_work', {}, deadline))
    while (Date.now() < deadline - WRITE_RESERVE_MS - 5000) {
      const workerId = crypto.randomUUID()
      const work = await stage('company-selection', deadline - 5000, {}, () => rpc<InvoiceCompletionWork | null>(supabase,
        'claim_invoice_completion_work', { p_worker_id: workerId, p_exclude: visited }, deadline - 5000))
      if (!work?.company_id) break
      visited.push(work.company_id)
      const companyDeadline = Math.min(deadline - 2000, Date.now() + COMPANY_BUDGET_MS)
      const completed = await completeInvoiceCompletionWork(supabase, work, companyDeadline)
      for (const key of Object.keys(completed) as (keyof InvoiceCompletionSummary)[]) {
        if (typeof completed[key] === 'number') (result[key] as number) += completed[key] as number
      }
      if (completed.budgetReachedAt) result.budgetReachedAt = completed.budgetReachedAt
    }
    if (Date.now() >= deadline - WRITE_RESERVE_MS - 5000) result.budgetReachedAt ??= 'company-selection'
  } catch (error) {
    if (!(error instanceof ExecutionBudgetExceeded)) throw error
    result.budgetReachedAt = error.stage
  }
  return result
}

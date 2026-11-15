import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { commitSIEImportChunk, reverseSIEImportChunk } from '@/lib/bookkeeping/engine'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { applyMetadata, jobInput, prepareSIEJob, readCheckpoint, readSIEClosingBalances, readSIESourceVouchers,
  SIE_CHECKPOINTS, sieJobRPC, type SIEAppendCounts } from './sie-job-preparation'
import { getSIEJob, runsSIEJobs, SIEJobValidationError } from './sie-jobs'
import { isSIEJobUnresolved, sealedSIEFinalOrdinals, type SIEChunkResult, type SIEJob } from './sie-job-contract'
import { getMappingStats } from './account-mapper'
import { computeVoucherNumberRanges } from './sie-import'
import type { AccountMapping, ImportResult, MigrationDocumentation, OpeningBalanceDifference, ParsedSIEFile,
  SIEVoucher } from './types'
import { legacyNotices } from './notices'
import { openingBalanceSplitRefusedNotice, type OpeningBalanceSplitRefusal } from './sie-object-balances'
import { buildSIEVatDefaults } from './account-sync'
import { isoDay, sweepBankRowsAfterSIEImport } from './sie-post-import-sweep'
import { diagnoseUntransferredResults, learnFromCompletedSIEImport, vouchersForLearning } from './sie-import-learning'
import { booksMatchFilePreviousYear, continuityNotices, diagnoseCarriedForwardDifferences,
  storedOpeningBalances } from './sie-continuity'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'
import { postingPort } from '@/lib/posting/port'
import { sieImportBusinessEvent } from './import-business-events'

const log = createLogger('sie-worker')

interface CheckpointRow { phase:string; chunk_no:number; payload_hash:string; result:Record<string,unknown> | SIEChunkResult }
/** What finalize leaves for the learning after completion (sie-import-learning.ts). */
export interface FinalizeLearning { completed?:boolean; vouchers?:SIEVoucher[] }

/**
 * A continuation import never books the file's #IB (prior_activity): the year
 * opens on the carried-forward balance, or on its own IB verifikat when it has
 * one (crm#1272). Where that differs from what the file stated, the result
 * says so with the amounts (crm#1099), and names the file's #IB as the side
 * that is off when the books open on the file's own #UB -1. The #UB rows are
 * read back from the metadata groups: the root snapshot behind finalize's
 * parsed file carries none. A failed read costs that sentence, not the import.
 */
export async function carriedForwardContinuity(
  supabase: SupabaseClient,
  job: SIEJob,
  mappings: AccountMapping[],
): Promise<{ differences: OpeningBalanceDifference[]; fileOpeningOff: boolean }> {
  const yearStart = isoDay(job.fiscal_year_start)
  if (!job.manifest.prior_activity || !yearStart) return {differences:[],fileOpeningOff:false}
  const differences = await diagnoseCarriedForwardDifferences(supabase,job.company_id,yearStart,
    job.manifest.effectiveOpeningBalances,mappings,job.fiscal_period_id)
  if (differences.length === 0) return {differences,fileOpeningOff:false}
  let closing: ParsedSIEFile['closingBalances'] = []
  try { closing = await readSIEClosingBalances(supabase,job) }
  catch (err) {
    log.warn('SIE #UB rows unreadable; the opening-balance notice cannot say which side is off',
      {companyId:job.company_id,importId:job.id,message:err instanceof Error ? err.message : String(err)})
  }
  return {differences,fileOpeningOff:booksMatchFilePreviousYear(differences,
    {opening:storedOpeningBalances(job.manifest.effectiveOpeningBalances),closing},mappings)}
}

async function finalize(supabase: SupabaseClient, job: SIEJob, deadline: number, learning: FinalizeLearning): Promise<boolean> {
  const { options, mappings } = jobInput(job)
  // An append books the file's new vouchers and nothing else: the year's
  // chart, VAT defaults and year-level diagnoses stay the base import's.
  const appending = options.onExistingPeriod === 'append'
  const done = await fetchAllRows<{chunk_no:number}>(({from,to}) => supabase.from('sie_import_chunks')
    .select('chunk_no').eq('company_id',job.company_id).eq('import_id',job.id).eq('phase','prepare')
    .eq('state','completed').gte('chunk_no',40_000).lt('chunk_no',80_000).order('chunk_no').range(from,to))
  const completed = new Set(done.map(row => row.chunk_no))
  const { data: chunks, error } = await supabase.from('sie_import_chunks').select('chunk_no,state')
    .eq('company_id',job.company_id).eq('import_id',job.id).eq('phase','finalize').order('chunk_no')
  if (error) throw new Error(error.message)
  for (const chunk of chunks ?? []) {
    if (Date.now() > deadline) return false
    if (chunk.state !== 'completed') await commitSIEImportChunk(supabase,job,chunk.chunk_no,'finalize')
  }
  for (let n = 0; n < mappings.length; n += 100) {
    if (Date.now() > deadline) return false
    if (completed.has(SIE_CHECKPOINTS.mappings+n/100)) continue
    const batch = [...new Map(mappings.slice(n,n+100).map(mapping => [mapping.sourceAccount,mapping])).values()]
    await applyMetadata(supabase,job,'mappings',SIE_CHECKPOINTS.mappings+n/100,batch.map(m => ({
      source_account:m.sourceAccount,source_name:m.sourceName,target_account:m.targetAccount,confidence:m.confidence,match_type:m.matchType,
    })))
  }
  if (options.updateAccountNames !== false) {
    const names = [...new Map(mappings.filter(m => m.sourceAccount === m.targetAccount && m.sourceName.trim())
      .map(m => [m.targetAccount,m.sourceName.trim()])).entries()].map(([account_number,name]) => ({account_number,name}))
    for (let n = 0; n < names.length; n += 100) {
      if (Date.now() > deadline) return false
      if (completed.has(SIE_CHECKPOINTS.names+n/100)) continue
      await applyMetadata(supabase,job,'account_names',SIE_CHECKPOINTS.names+n/100,names.slice(n,n+100))
    }
  }
  const defaults = appending ? [] : [...buildSIEVatDefaults(mappings)].map(([account_number,value]) => ({account_number,...value}))
  for (let n = 0; n < defaults.length; n += 100) {
    if (Date.now() > deadline) return false
    if (!completed.has(70_000+n/100)) await applyMetadata(supabase,job,'vat_defaults',70_000+n/100,defaults.slice(n,n+100))
  }
  const rows = await fetchAllRows<CheckpointRow>(({from,to}) => supabase.from('sie_import_chunks')
    .select('phase,chunk_no,payload_hash,result').eq('company_id',job.company_id).eq('import_id',job.id)
    .eq('state','completed').order('phase').order('chunk_no').range(from,to))
  const entries = rows.filter(r => r.phase === 'vouchers' || r.phase === 'finalize')
    .flatMap(r => (r.result as SIEChunkResult).inserted_entries)
  if (options.markImportedNoDocRequired) {
    const ids = entries.filter(e => e.sourceType === 'import').map(e => ({id:e.id}))
    for (let n = 0; n < ids.length; n += 100) {
      if (Date.now() > deadline) return false
      if (completed.has(SIE_CHECKPOINTS.noDocuments+n/100)) continue
      await applyMetadata(supabase,job,'no_documents',SIE_CHECKPOINTS.noDocuments+n/100,ids.slice(n,n+100))
    }
  }
  const snapshot = await readCheckpoint<{parsed:ParsedSIEFile;voucherGroups:number}>(supabase,job,SIE_CHECKPOINTS.snapshot)
  if (!snapshot) throw new Error('SIE source manifest missing')
  const parsed = snapshot.parsed
  const skipped = job.manifest.skippedCounts as {empty:number;unbalanced:number;unmapped:number;singleLine:number;total:number}
  const renames = rows.filter(r => r.phase === 'prepare' && r.chunk_no >= SIE_CHECKPOINTS.names && r.chunk_no < SIE_CHECKPOINTS.noDocuments)
    .flatMap(r => ((r.result as Record<string,unknown>).renamed ?? []) as Array<{accountNumber:string;from:string;to:string}>)
  const accountsCreated = rows.filter(r => r.phase === 'prepare' && r.chunk_no < SIE_CHECKPOINTS.dimensions)
    .reduce((sum,r) => sum+Number((r.result as Record<string,unknown>).created ?? 0),0)
  const opening = entries.filter(e => e.sourceType === 'opening_balance')
  if (opening.length > 1) throw new SIEJobValidationError('Importen innehåller flera ingående balansverifikationer. Granska och ångra importen.')
  const adjustmentOrdinal = sealedSIEFinalOrdinals(job.manifest).adjustment
  const adjustment = entries.find(e => e.sourceOrdinal === adjustmentOrdinal)
  const warnings = [...(job.manifest.preparationWarnings as string[] ?? [])]
  if (skipped.total) warnings.push(`${skipped.total} verifikationer hoppades över. Behandlingshistoriken anger varje verifikation och orsak.`)
  const rounding = Number(job.manifest.openingBalanceRounding ?? 0)
  // The account preparation sealed (the form's result-closing account). Jobs
  // sealed before the manifest carried it booked the difference on 2099
  // unconditionally, so that is the account their text must name.
  const differenceAccount = typeof job.manifest.openingBalanceDifferenceAccount === 'string'
    ? job.manifest.openingBalanceDifferenceAccount : '2099'
  if (Math.abs(rounding) > 0.01) warnings.push(`Ingående balanser justerades med ${rounding} SEK på konto ${differenceAccount}.`)
  const notices = legacyNotices(warnings)
  // The IB was booked per account although the file split it per project
  // (issue #3313): the one warning here with a structured sv/en twin.
  const splitRefused = job.manifest.openingBalanceSplitRefused as OpeningBalanceSplitRefusal | undefined
  if (splitRefused) {
    const refused = openingBalanceSplitRefusedNotice(splitRefused)
    warnings.push(refused.text)
    notices.push(refused.notice)
  }
  // The untransferred-results check (#2462) the one-shot writer ran after
  // every import. Its finding belongs in the stored result: before completion.
  if (Date.now() > deadline) return false
  const isImport = (job.job_kind ?? 'import') === 'import'
  const diagnoses = isImport && !appending
  const untransferred = diagnoses ? await diagnoseUntransferredResults(supabase,job.company_id,isoDay(job.fiscal_year_start))
    : {results:[],warnings:[],notices:[]}
  warnings.push(...untransferred.warnings)
  notices.push(...untransferred.notices)
  // The opening balance against the file (carriedForwardContinuity); an ended
  // year whose file held no vouchers is missing its bookkeeping.
  const yearStart = isoDay(job.fiscal_year_start)
  const yearEnd = parsed.stats.fiscalYearEnd
  const {differences:ibDifferences,fileOpeningOff} = diagnoses ? await carriedForwardContinuity(supabase,job,mappings)
    : {differences:[],fileOpeningOff:false}
  const continuity = continuityNotices({differences:ibDifferences,fileOpeningOff,
    noVouchers:diagnoses && parsed.stats.totalVouchers === 0 && yearStart && yearEnd && yearEnd < todayIsoStockholm()
      ? {from:yearStart,to:yearEnd} : null})
  warnings.push(...continuity.warnings)
  notices.push(...continuity.notices)
  const voucherMap = entries.map(e => ({sourceId:e.sourceId,series:e.series,targetNumber:e.voucherNumber}))
  const stats = getMappingStats(mappings)
  const documentation: MigrationDocumentation = {
    sourceSystem:parsed.header.program,sourceVersion:parsed.header.programVersion,sieType:parsed.header.sieType,
    generatedDate:parsed.header.generatedDate,fiscalYear:{start:parsed.stats.fiscalYearStart!,end:parsed.stats.fiscalYearEnd!},
    importedAt:new Date().toISOString(),importedBy:job.user_id,
    accountMappings:{total:stats.total,exact:stats.exact,basRange:stats.basRange,manual:stats.manual,unmapped:stats.unmapped},
    accountRenames:renames.slice(0,200),vouchers:{total:parsed.stats.totalVouchers,imported:Number(job.manifest.preparedEntries),
      skippedEmpty:skipped.empty,skippedSingleLine:skipped.singleLine,skippedUnbalanced:skipped.unbalanced,skippedUnmapped:skipped.unmapped},
    openingBalanceRounding:rounding || null,migrationAdjustment:{created:!!adjustment,entryId:adjustment?.id ?? null,
      deltaAccounts:Number(job.manifest.migrationAdjustmentAccounts ?? 0)},
    voucherSeriesUsed:[...new Set(entries.map(e=>e.series))],voucherNumberRanges:computeVoucherNumberRanges(voucherMap),
    // Full mapping is retained in per-chunk receipts. Bound the final RPC.
    voucherNumberMapping:voucherMap.slice(0,200),
  }
  const result: ImportResult = {success:true,importId:job.id,fiscalPeriodId:job.fiscal_period_id,
    openingBalanceEntryId:opening[0]?.id ?? null,journalEntriesCreated:entries.length,
    journalEntryIds:entries.slice(0,200).map(e=>e.id),journalEntryIdsTruncated:entries.length > 200,
    errors:[],warnings,notices,accountsCreated,accountsRenamed:renames.length,
    details:{fiscalYear:documentation.fiscalYear,skippedVouchers:skipped,
      openingBalanceSkipped:job.manifest.prior_activity && options.importOpeningBalances ? 'prior_activity' : undefined,
      openingBalanceDifferences:ibDifferences.length ? ibDifferences.slice(0,200) : undefined,
      migrationAdjustment:{created:!!adjustment,accountsAdjusted:Number(job.manifest.migrationAdjustmentAccounts ?? 0)},
      untransferredResults:untransferred.results.length ? untransferred.results : undefined,
      ...(appending && job.base_import_id ? {append:{baseImportId:job.base_import_id,
        ...(job.manifest.appendCounts as SIEAppendCounts),added:entries.length}} : {}),
      retriedBatches:0,failedBatches:0}}
  // The learning after completion reads the source vouchers, and
  // complete_sie_import_job deletes them. Unreadable only costs the learning.
  if (isImport) {
    try { learning.vouchers = vouchersForLearning(await readSIESourceVouchers(supabase,job,snapshot.voucherGroups),mappings) }
    catch (err) {
      log.warn('SIE source vouchers unreadable; no templates are learned from this import',
        {companyId:job.company_id,importId:job.id,message:err instanceof Error ? err.message : String(err)})
    }
  }
  // Posting port (step 2h): the job's ONE business event, written here, after
  // every verifikat is posted and before the job completes, outside the SQL
  // writers' transactions. Idempotent per job, so a completion retried after
  // an interruption records none twice. Under shadow a failed write is logged
  // and the job completes; under strict it throws: the worker records a job
  // failure (reconciling, its phase still finalize) and the job is retried,
  // its verifikat posted and numbered already (no number is drawn here),
  // until the event is written, so a completed import always has its event.
  if (isImport) {
    await postingPort.recordEvent({supabase,companyId:job.company_id,actor:sieJobCommitActor(job),
      event:() => sieImportBusinessEvent(job,entries.length,todayIsoStockholm())})
  }
  await sieJobRPC(supabase,job,'complete_sie_import_job',{p_result:result,p_documentation:{...documentation,
    accountRenamesTruncated:renames.length > 200,
    voucherNumberMappingTruncated:entries.length > 200,entryManifest:{table:'sie_import_chunks',importId:job.id}}})
  learning.completed = true
  return true
}

const COMMIT_ACTOR_TYPES: ReadonlySet<string> = new Set<CommitActor['type']>(
  ['user','api_key','mcp_oauth','cron','system','agent_chat','service_account'])

/**
 * Who submitted the job, as its verifikat record it (the commit_actor
 * submitSIEJob sealed into the manifest, which import_sie_chunk stamps), or
 * null for a job sealed without one: the worker may run under a cron, so
 * the job's business event names the submitter, never the worker's scope.
 */
function sieJobCommitActor(job: SIEJob): CommitActor | null {
  const sealed = job.manifest.commit_actor as { type?: unknown; label?: unknown } | undefined
  if (!sealed || typeof sealed.type !== 'string' || !COMMIT_ACTOR_TYPES.has(sealed.type)) return null
  return { type: sealed.type as CommitActor['type'], ...(typeof sealed.label === 'string' ? {label:sealed.label} : {}) }
}

/**
 * Claims of one job from which it counts as looping. A finished import took
 * at most 4 claims in production (2026-11-01). A failing step is counted by
 * record_sie_job_failure, and a run that yields or loses its lease without
 * progress by sweep_stalled_sie_import_jobs (sweepStalledSIEJobs below); both
 * stop the job at 32. This alert stays as the backstop for a job that keeps
 * moving a little on every claim and still never finishes: only job_attempt,
 * raised by every claim, shows it.
 */
export const SIE_RECLAIM_ALERT_ATTEMPTS = 20

/**
 * The claims a job may take before it counts as looping. A large year needs
 * more than 20 to finish: the 4-claim import posted 195 voucher chunks, about
 * 50 a claim, so a 150 000-voucher year (about 750 chunks) needs about 15 for
 * its vouchers alone. One more claim per 25 voucher chunks is twice that rate.
 * Only an import's chunks are voucher chunks: a duplicate repair counts its
 * items in chunks_total (up to 5 000) and keeps the flat 20.
 */
export function sieReclaimAlertAttempts(job: Pick<SIEJob, 'chunks_total' | 'job_kind'>): number {
  if ((job.job_kind ?? 'import') !== 'import') return SIE_RECLAIM_ALERT_ATTEMPTS
  return SIE_RECLAIM_ALERT_ATTEMPTS + Math.floor(Math.max(Number(job.chunks_total) || 0, 0) / 25)
}

/**
 * Least budget left for claiming a further job in one invocation. A job
 * claimed with no time to run yields without progress, and the stall sweep
 * counts that as a failure of the job, though the worker caused it.
 */
export const SIE_MIN_CLAIM_BUDGET_MS = 30_000

/** One job sweep_stalled_sie_import_jobs counted as a failure (accounted#115). */
export interface SIEStalledJob {
  importId: string
  companyId: string
  jobKind: string
  phase: string
  state: string
  /** retrying: backed off like a failed step; paused or failed: stopped. */
  outcome: 'retrying' | 'paused' | 'failed'
  reason: 'yielded_without_progress' | 'lease_lapsed' | 'actor_not_member'
  consecutiveFailures: number
  attempt: number
  /** True when the job ended as failed and gave its fiscal year back. */
  holdReleased: boolean
}

function stalledJobMessage(job: SIEStalledJob): string {
  if (job.reason === 'actor_not_member') return 'SIE job actor can no longer write in the company; the job is stopped'
  return job.outcome === 'retrying'
    ? 'SIE job run ended without progress; counted as a failure'
    : 'SIE job kept ending without progress; the job is stopped'
}

/**
 * Counts every job whose last run yielded or lost its lease without moving it
 * on, and stops every job whose actor can no longer write, in the database
 * (sweep_stalled_sie_import_jobs), then logs each as an error with its
 * context. Runs before the cron claims: a stall is judged against the mark of
 * the claim that started the stalled run, and the next claim replaces it.
 * Never throws: when the sweep fails, claims run as they did before it.
 */
export async function sweepStalledSIEJobs(supabase: SupabaseClient, logger: Pick<typeof log, 'warn' | 'error'> = log): Promise<SIEStalledJob[]> {
  let result: { data: unknown; error: { message: string; code?: string } | null }
  try {
    result = await supabase.rpc('sweep_stalled_sie_import_jobs')
  } catch (err) {
    logger.error('SIE stall sweep failed; stalled jobs are judged on the next run', err as Error)
    return []
  }
  if (result.error) {
    // Code deployed ahead of migration 20261109171500: no function yet.
    if (result.error.code === 'PGRST202' || result.error.code === '42883') {
      logger.warn('SIE stall sweep is not installed yet; stalled jobs are not counted', {code: result.error.code})
    } else {
      logger.error('SIE stall sweep failed; stalled jobs are judged on the next run', new Error(result.error.message),
        {code: result.error.code})
    }
    return []
  }
  const stalled = (Array.isArray(result.data) ? result.data : []) as SIEStalledJob[]
  for (const job of stalled) {
    logger.error(stalledJobMessage(job), {
      alert: true,
      companyId: job.companyId,
      importId: job.importId,
      jobKind: job.jobKind,
      outcome: job.outcome,
      reason: job.reason,
      state: job.state,
      phase: job.phase,
      consecutiveFailures: job.consecutiveFailures,
      attempt: job.attempt,
      holdReleased: job.holdReleased,
    })
  }
  return stalled
}

/** Logs a claimed job that keeps being claimed without finishing, as an error. */
export function reportRepeatedReclaim(job: SIEJob, logger: Pick<typeof log, 'error'> = log): void {
  if (!(job.job_attempt >= sieReclaimAlertAttempts(job))) return
  logger.error('SIE job reclaimed repeatedly without finishing', {
    alert: true,
    companyId: job.company_id,
    importId: job.id,
    state: job.job_state,
    phase: job.job_phase,
    attempt: job.job_attempt,
    consecutiveFailures: job.consecutive_failures,
    chunksDone: job.chunks_done,
    chunksTotal: job.chunks_total,
  })
}

/**
 * The worker's budget ends 70 s before the platform ends the function (a
 * 240 s budget less 10 s, against maxDuration 300). What follows a completed
 * import may use the first 40 of them.
 */
export const SIE_AFTER_COMPLETION_GRACE_MS = 40_000
/** Neither step after completion starts with less time than this left to it. */
export const SIE_AFTER_COMPLETION_MIN_MS = 30_000

/**
 * The two steps that follow a completed import, inside the invocation's time.
 * Both ran after the job loop with no deadline at all, which is how one
 * invocation reached 274 s of its 300 (2026-11): the loop itself stops at
 * `deadline`.
 *
 * Learning first (counterparty templates and suggested parties,
 * sie-import-learning.ts): the file's vouchers exist only here, in the
 * invocation that completed the job, so nothing can run it later. It is
 * skipped only when even the grace after the deadline is nearly used up, and
 * that is reported as an error because it is lost for good.
 *
 * Then the bank sweep (issue #2835: the import is final and its period hold
 * released, so bank rows can be matched against the new verifikat). It starts
 * only with time left inside the budget. A sweep not started leaves no
 * receipt, and runPendingSIEBankSweeps, on the same cron every minute, runs
 * it for any import completed in the last 24 hours without one.
 *
 * Neither step throws.
 */
export async function finishCompletedSIEImport(
  supabase: SupabaseClient,
  job: SIEJob,
  learning: FinalizeLearning,
  deadline: number,
  logger: Pick<typeof log, 'info' | 'error'> = log,
): Promise<{ learned: boolean; swept: boolean }> {
  let learned = false
  let swept = false
  if (learning.completed) {
    const learnUntil = deadline + SIE_AFTER_COMPLETION_GRACE_MS
    if (learnUntil - Date.now() < SIE_AFTER_COMPLETION_MIN_MS) {
      logger.error('SIE import learning skipped: the run was out of time, and nothing runs it later', {
        alert: true,
        companyId: job.company_id,
        importId: job.id,
        vouchers: learning.vouchers?.length ?? 0,
      })
    } else {
      await learnFromCompletedSIEImport(supabase,job,learning.vouchers ?? [],learnUntil)
      learned = true
    }
  }
  if (job.job_state === 'completed') {
    if (deadline - Date.now() < SIE_AFTER_COMPLETION_MIN_MS) {
      logger.info('post-import bank sweep left to the next cron run',{companyId:job.company_id,importId:job.id})
    } else {
      await sweepBankRowsAfterSIEImport(supabase,job)
      swept = true
    }
  }
  return {learned,swept}
}

/** after() is only a fast path. Cron owns recovery, independent of the browser. */
export async function runSIEWorker(options: { importId?:string; budgetMs?:number; supabase?:SupabaseClient } = {}): Promise<{ jobs:number; chunks:number }> {
  if (!runsSIEJobs()) return {jobs:0,chunks:0}
  const supabase = options.supabase ?? createServiceClientNoCookies()
  const deadline = Date.now()+Math.min(options.budgetMs ?? 240_000,240_000)-10_000
  const worker = randomUUID()
  let jobs = 0
  let chunks = 0
  // The cron owns recovery: it counts stalled runs before it claims. A run
  // for one job (after() on a user's action) claims that job only.
  if (!options.importId) await sweepStalledSIEJobs(supabase)
  while (Date.now() < deadline && runsSIEJobs()) {
    if (jobs > 0 && deadline-Date.now() < SIE_MIN_CLAIM_BUDGET_MS) break
    const {data,error} = await supabase.rpc('claim_sie_import_job',{p_worker_id:worker,p_import_id:options.importId ?? null})
    if (error) throw new Error(error.message)
    if (!data?.id) break
    let job = data as SIEJob
    reportRepeatedReclaim(job)
    const learning: FinalizeLearning = {}
    jobs++
    try {
      while (Date.now() < deadline && runsSIEJobs() && isSIEJobUnresolved(job.job_state)) {
        const started = Date.now()
        if (job.job_phase === 'prepare') {
          if (process.env.SIE_IMPORT_CHUNK_AUDIT === 'true' && !job.manifest.auditMode) {
            await sieJobRPC(supabase,job,'set_sie_import_audit_mode',{p_mode:'chunk'})
            job = {...job,audit_mode:'chunk',manifest:{...job.manifest,auditMode:'chunk'}}
          }
          if (!await prepareSIEJob(supabase,job,deadline)) break
        } else if (job.job_phase === 'vouchers') {
          await commitSIEImportChunk(supabase,job,job.chunks_done,'vouchers')
          chunks++
        } else if (job.job_phase === 'undo') {
          await reverseSIEImportChunk(supabase,job)
          chunks++
        } else if (!await finalize(supabase,job,deadline,learning)) break
        const durationMs = Date.now()-started
        if (durationMs > 30_000) log.warn('SIE slow job step',{alert:true,companyId:job.company_id,importId:job.id,phase:job.job_phase,durationMs})
        const current = await getSIEJob(supabase,job.company_id,job.id)
        if (!current) throw new Error('SIE execution disappeared')
        job = current
        if (job.worker_id !== worker) break
      }
      if (isSIEJobUnresolved(job.job_state) && job.worker_id === worker) {
        await sieJobRPC(supabase,job,'yield_sie_import_job')
      }
      await finishCompletedSIEImport(supabase,job,learning,deadline)
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown SIE worker error'
      log.error('SIE job requires recovery',err as Error,{alert:true,companyId:job.company_id,importId:job.id,phase:job.job_phase})
      try {
        if (err instanceof SIEJobValidationError && job.job_phase === 'prepare') {
          await sieJobRPC(supabase,job,'fail_sie_preparation',{p_reason:reason})
        } else {
          // This queues behind any in-flight write and preserves its receipt.
          await sieJobRPC(supabase,job,'record_sie_job_failure',{p_error:reason})
        }
      } catch (reconciliationError) {
        // Revocation, a dead connection, or another owner winning is not a
        // rollback signal. The persisted lease/receipt remains authoritative.
        log.error('SIE recovery recording failed; lease takeover required',reconciliationError as Error,{importId:job.id})
      }
    }
    if (options.importId) break
  }
  return {jobs,chunks}
}

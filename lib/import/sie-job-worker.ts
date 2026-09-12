import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { commitSIEImportChunk, reverseSIEImportChunk } from '@/lib/bookkeeping/engine'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { applyMetadata, jobInput, prepareSIEJob, readCheckpoint, SIE_CHECKPOINTS, sieJobRPC } from './sie-job-preparation'
import { getSIEJob, runsSIEJobs, SIEJobValidationError } from './sie-jobs'
import { isSIEJobUnresolved, type SIEChunkResult, type SIEJob } from './sie-job-contract'
import { getMappingStats } from './account-mapper'
import { computeVoucherNumberRanges } from './sie-import'
import type { ImportResult, MigrationDocumentation, ParsedSIEFile } from './types'
import { legacyNotices } from './notices'
import { buildSIEVatDefaults } from './account-sync'

const log = createLogger('sie-worker')

interface CheckpointRow { phase:string; chunk_no:number; payload_hash:string; result:Record<string,unknown> | SIEChunkResult }

async function finalize(supabase: SupabaseClient, job: SIEJob, deadline: number): Promise<boolean> {
  const { options, mappings } = jobInput(job)
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
    await applyMetadata(supabase,job,'mappings',SIE_CHECKPOINTS.mappings+n/100,mappings.slice(n,n+100).map(m => ({
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
  const defaults = [...buildSIEVatDefaults(mappings)].map(([account_number,value]) => ({account_number,...value}))
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
  const snapshot = await readCheckpoint<{parsed:ParsedSIEFile}>(supabase,job,SIE_CHECKPOINTS.snapshot)
  if (!snapshot) throw new Error('SIE source manifest missing')
  const parsed = snapshot.parsed
  const skipped = job.manifest.skippedCounts as {empty:number;unbalanced:number;unmapped:number;singleLine:number;total:number}
  const renames = rows.filter(r => r.phase === 'prepare' && r.chunk_no >= SIE_CHECKPOINTS.names && r.chunk_no < SIE_CHECKPOINTS.noDocuments)
    .flatMap(r => ((r.result as Record<string,unknown>).renamed ?? []) as Array<{accountNumber:string;from:string;to:string}>)
  const accountsCreated = rows.filter(r => r.phase === 'prepare' && r.chunk_no < SIE_CHECKPOINTS.dimensions)
    .reduce((sum,r) => sum+Number((r.result as Record<string,unknown>).created ?? 0),0)
  const opening = entries.filter(e => e.sourceType === 'opening_balance')
  if (opening.length > 1) throw new SIEJobValidationError('Importen innehåller flera ingående balansverifikationer. Granska och ångra importen.')
  const adjustment = entries.find(e => e.sourceOrdinal === 50_001)
  const warnings = [...(job.manifest.preparationWarnings as string[] ?? [])]
  if (skipped.total) warnings.push(`${skipped.total} verifikationer hoppades över. Behandlingshistoriken anger varje verifikation och orsak.`)
  const rounding = Number(job.manifest.openingBalanceRounding ?? 0)
  if (Math.abs(rounding) > 0.01) warnings.push(`Ingående balanser justerades med ${rounding} SEK på konto 2099.`)
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
    errors:[],warnings,notices:legacyNotices(warnings),accountsCreated,accountsRenamed:renames.length,
    details:{fiscalYear:documentation.fiscalYear,skippedVouchers:skipped,
      openingBalanceSkipped:job.manifest.prior_activity && options.importOpeningBalances ? 'prior_activity' : undefined,
      migrationAdjustment:{created:!!adjustment,accountsAdjusted:Number(job.manifest.migrationAdjustmentAccounts ?? 0)},
      retriedBatches:0,failedBatches:0}}
  await sieJobRPC(supabase,job,'complete_sie_import_job',{p_result:result,p_documentation:{...documentation,
    accountRenamesTruncated:renames.length > 200,
    voucherNumberMappingTruncated:entries.length > 200,entryManifest:{table:'sie_import_chunks',importId:job.id}}})
  return true
}

/** after() is only a fast path. Cron owns recovery, independent of the browser. */
export async function runSIEWorker(options: { importId?:string; budgetMs?:number; supabase?:SupabaseClient } = {}): Promise<{ jobs:number; chunks:number }> {
  if (!runsSIEJobs()) return {jobs:0,chunks:0}
  const supabase = options.supabase ?? createServiceClientNoCookies()
  const deadline = Date.now()+Math.min(options.budgetMs ?? 240_000,240_000)-10_000
  const worker = randomUUID()
  let jobs = 0
  let chunks = 0
  while (Date.now() < deadline && runsSIEJobs()) {
    const {data,error} = await supabase.rpc('claim_sie_import_job',{p_worker_id:worker,p_import_id:options.importId ?? null})
    if (error) throw new Error(error.message)
    if (!data?.id) break
    let job = data as SIEJob
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
        } else if (!await finalize(supabase,job,deadline)) break
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

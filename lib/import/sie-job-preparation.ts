import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryInput } from '@/types'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'
import { buildSIEAccountRows } from './account-sync'
import { mappingsToMap } from './account-mapper'
import { collectSIEDimensionUsage } from './sie-dimensions'
import { buildSIEMigrationAdjustmentEntry, buildSIEOpeningBalanceEntry, importVouchers, validateIBBalance } from './sie-import'
import { getEffectiveOpeningBalances, parseSIEFile } from './sie-parser'
import { defaultOpeningBalanceSeries } from './opening-balance-defaults'
import { chunkSIEEntries, hashSIEPayload, SIE_JOB_VERSION, SIE_LIMITS, type SIEJob, type SIEPreparedEntry } from './sie-job-contract'
import { applySIEFiscalYear, readSIEJobSource, SIEJobValidationError, validateSIEJobInput, type SIEJobInput } from './sie-jobs'
import type { ParsedSIEFile, SIEVoucher } from './types'
import { scanSieForCp1252Artifacts, formatSieArtifactWarning } from './sie-artifact-scan'
import { SIEJobMappingsSchema, SIEJobOptionsSchema } from '@/lib/api/schemas'

// Disjoint namespaces keep immutable receipts stable when work resumes.
export const SIE_CHECKPOINTS = { accounts: 0, dimensions: 10_000, values: 20_000,
  mappings: 40_000, names: 50_000, noDocuments: 60_000, snapshot: 100_000, prepared: 200_000 } as const

type VoucherPreparation = Awaited<ReturnType<typeof importVouchers>>
interface PreparedSummary {
  entries: number
  skipped: VoucherPreparation['skippedDetails']
  movements: Array<[string, number]>
  firstChunk: number
  chunkCount: number
}
interface Snapshot { parsed: ParsedSIEFile; voucherGroups: number; hasCurrentYearIb: boolean; sourceSeries: string[];
  metadataGroups:number; artifactWarning?:string }
interface PreparationTotals {
  entries:number; movements:Array<[string,number]>; skippedSample:VoucherPreparation['skippedDetails']
  openingEntries?:number
  skippedCounts:{empty:number;unbalanced:number;unmapped:number;singleLine:number;total:number}
}

export async function sieJobRPC<T = unknown>(supabase: SupabaseClient, job: SIEJob, name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > SIE_LIMITS.chunkBytes) {
    throw new SIEJobValidationError(`Importsteget ${name} överskrider gränsen på 1 MB. Dela upp filens metadata och försök igen.`)
  }
  const { data, error } = await supabase.rpc(name, { p_company_id: job.company_id, p_import_id: job.id,
    p_worker_id: job.worker_id, p_attempt: job.job_attempt, ...args })
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
  return data as T
}

export async function readCheckpoint<T>(supabase: SupabaseClient, job: SIEJob, number: number): Promise<T | null> {
  const { data, error } = await supabase.from('sie_import_chunks').select('payload').eq('company_id', job.company_id)
    .eq('import_id',job.id).eq('phase','prepare').eq('chunk_no',number).maybeSingle()
  if (error) throw new Error(error.message)
  return data ? data.payload?.[0] as T : null
}

async function saveCheckpoint(supabase: SupabaseClient, job: SIEJob, number: number, value: unknown): Promise<void> {
  await sieJobRPC(supabase,job,'save_sie_import_chunk',{p_phase:'prepare',p_chunk_no:number,p_payload:[value]})
}

export async function applyMetadata(supabase: SupabaseClient, job: SIEJob, kind: string, number: number, payload: unknown[]): Promise<Record<string, unknown>> {
  return sieJobRPC(supabase,job,'apply_sie_import_metadata',{p_kind:kind,p_chunk_no:number,p_payload:payload})
}

async function checkpointProgress(supabase: SupabaseClient, job: SIEJob, manifest: Record<string, unknown>, position: number): Promise<void> {
  await sieJobRPC(supabase,job,'checkpoint_sie_preparation',{p_manifest:manifest,p_position:position})
  job.manifest = manifest
  job.prepared_through = position
}

/** No parser or mapping upgrade may reinterpret an accepted execution. */
export function jobInput(job: SIEJob): SIEJobInput {
  const input = job.manifest.input as SIEJobInput | undefined
  if (!input || input.version !== SIE_JOB_VERSION || input.sourceHash !== job.file_hash) {
    throw new SIEJobValidationError('Importens formatversion stöds inte av denna driftsättning. Återställ rätt version eller ångra importen.')
  }
  const mappings = SIEJobMappingsSchema.safeParse(input.mappings)
  const options = SIEJobOptionsSchema.safeParse(input.options)
  if (!mappings.success || !options.success) throw new SIEJobValidationError('Importens kontomappningar eller inställningar är ogiltiga.')
  return { ...input, mappings:mappings.data, options:{...options.data,filename:input.options.filename} }
}

function reviveVoucher(value: SIEVoucher): SIEVoucher {
  return { ...value, date: new Date(value.date), registrationDate: value.registrationDate ? new Date(value.registrationDate) : undefined }
}

const SNAPSHOT_ARRAYS = ['accounts','openingBalances','closingBalances','resultBalances','dimensions','dimensionValues','issues'] as const
const SNAPSHOT_METADATA = 300_000
type MetadataItem = {sourceId:string; key:typeof SNAPSHOT_ARRAYS[number]; value:unknown}

export async function readSIESnapshot(supabase:SupabaseClient,job:SIEJob):Promise<Snapshot> {
  const snapshot = await readCheckpoint<Snapshot>(supabase,job,SIE_CHECKPOINTS.snapshot)
  if (!snapshot) throw new Error('SIE source checkpoint missing')
  const groups = await fetchAllRows<{payload:[MetadataItem[]]}>(({from,to}) => supabase.from('sie_import_chunks')
    .select('payload').eq('company_id',job.company_id).eq('import_id',job.id).eq('phase','prepare')
    .gte('chunk_no',SNAPSHOT_METADATA).lt('chunk_no',SNAPSHOT_METADATA+snapshot.metadataGroups).order('chunk_no').range(from,to))
  if (groups.length !== snapshot.metadataGroups) throw new Error('SIE metadata checkpoint missing')
  for (const group of groups) for (const item of group.payload[0]) {
    (snapshot.parsed[item.key] as unknown[]).push(item.value)
  }
  return snapshot
}

function boundedChunks<T extends {sourceId:string;lines:unknown[]}>(entries:T[]):T[][] {
  try { return [...chunkSIEEntries(entries)] }
  catch (error) { throw new SIEJobValidationError(error instanceof Error ? error.message : 'SIE-posten är för stor.') }
}

/**
 * The bounded parser runs before ledger work. Its output is checkpointed in
 * bounded immutable groups. Once sealed, subsequent workers use that output,
 * including the original global IB classification, without parsing again.
 */
async function snapshotSource(supabase: SupabaseClient, job: SIEJob, deadline: number): Promise<Snapshot | null> {
  const input = jobInput(job)
  if (job.manifest.snapshotComplete) {
    return readSIESnapshot(supabase,job)
  }
  const content = await readSIEJobSource(supabase,job)
  const parsed = parseSIEFile(content)
  applySIEFiscalYear(parsed,input.fiscalYear)
  validateSIEJobInput(content,parsed,input.mappings,input.options)
  if (parsed.stats.fiscalYearStart! < job.fiscal_year_start || parsed.stats.fiscalYearEnd! > job.fiscal_year_end) {
    throw new SIEJobValidationError('SIE-filens räkenskapsår stämmer inte med importens period.')
  }
  const groups = boundedChunks(parsed.vouchers.map(v => ({ ...v, sourceId: `${v.series}${v.number}` })))
  const metadata = boundedChunks(SNAPSHOT_ARRAYS.flatMap(key => parsed[key].map((value,index) => ({sourceId:`${key}:${index+1}`,key,value,lines:[]}))))
  const artifactScan = scanSieForCp1252Artifacts(parsed)
  const snapshot: Snapshot = { parsed: { ...parsed, vouchers: [] }, voucherGroups: groups.length,
    metadataGroups:metadata.length,artifactWarning:artifactScan.flagged ? formatSieArtifactWarning(artifactScan) : undefined,
    sourceSeries:[...new Set(parsed.vouchers.map(v => v.series || input.options.voucherSeries || 'B'))],
    hasCurrentYearIb: getEffectiveOpeningBalances(parsed).balances.length > 0 }
  // Save the effective set as well: the global OB-voucher check must not be
  // repeated on a subset of the file during mapping/finalization.
  const effective = getEffectiveOpeningBalances(parsed)
  const root = {...snapshot,parsed:{...snapshot.parsed}}
  for (const key of SNAPSHOT_ARRAYS) root.parsed[key] = []
  await saveCheckpoint(supabase,job,SIE_CHECKPOINTS.snapshot,root)
  for (let n = Number(job.manifest.snapshotMetadataThrough ?? 0); n < metadata.length; n++) {
    if (Date.now() > deadline) return null
    await saveCheckpoint(supabase,job,SNAPSHOT_METADATA+n,metadata[n])
    await checkpointProgress(supabase,job,{...job.manifest,snapshotMetadataThrough:n+1},job.prepared_through)
  }
  const saved = Number(job.manifest.snapshotThrough ?? 0)
  for (let n = saved; n < groups.length; n++) {
    if (Date.now() > deadline) return null
    await saveCheckpoint(supabase,job,SIE_CHECKPOINTS.snapshot+1+n,groups[n])
    await checkpointProgress(supabase,job,{...job.manifest,snapshotThrough:n+1},job.prepared_through)
  }
  await checkpointProgress(supabase,job,{...job.manifest,snapshotComplete:true,
    effectiveOpeningBalances:effective.balances,derivedFromPriorYearUB:effective.derivedFromPriorYearUB},job.prepared_through)
  return snapshot
}

async function createMetadata(supabase: SupabaseClient, job: SIEJob, snapshot: Snapshot, deadline: number): Promise<boolean> {
  const input = jobInput(job)
  const extras = ['3741','2099'].map(number => ({ sourceAccount:number,targetAccount:number,sourceName:'',targetName:'',confidence:1,matchType:'exact' as const,isOverride:false }))
  const rows = buildSIEAccountRows(job.company_id,job.user_id,[...extras,...input.mappings])
  for (let n = Number(job.manifest.accountsThrough ?? 0); n < rows.length; n += 100) {
    if (Date.now() > deadline) return false
    await applyMetadata(supabase,job,'accounts',SIE_CHECKPOINTS.accounts+n/100,rows.slice(n,n+100))
    await checkpointProgress(supabase,job,{...job.manifest,accountsThrough:n+100},job.prepared_through)
  }
  // Include object-list references, even if the file omitted #OBJEKT.
  // Declared names land first; later groups only fill undeclared references.
  for (let group = Number(job.manifest.dimensionsGroup ?? -1); group < snapshot.voucherGroups; group++) {
    if (Date.now() > deadline) return false
    const vouchers = group < 0 ? [] : await readCheckpoint<SIEVoucher[]>(supabase,job,SIE_CHECKPOINTS.snapshot+1+group)
    if (!vouchers) throw new Error('SIE voucher snapshot missing')
    const usage = collectSIEDimensionUsage(group < 0 ? snapshot.parsed : {...snapshot.parsed,dimensions:[],dimensionValues:[],vouchers})
    if (usage.invalidCodes.size) throw new SIEJobValidationError(`Ogiltiga dimensionskoder: ${[...usage.invalidCodes].slice(0,5).join(', ')}`)
    const dimensions = [...usage.dims].map(([sie_dim_no,v]) => ({sie_dim_no,name:v.name,parent_sie_dim_no:v.parent ?? null}))
    const values = [...usage.values.values()].map(v => ({sie_dim_no:v.sieDimNo,code:v.code,name:v.name}))
    const plans = [['dimensions',dimensions],['dimension_values',values]] as const
    for (let kindIndex = Number(job.manifest.dimensionKind ?? 0); kindIndex < plans.length; kindIndex++) {
      const [kind,payload] = plans[kindIndex]
      for (let n = Number(job.manifest.dimensionRows ?? 0); n < payload.length; n += 100) {
        if (Date.now() > deadline) return false
        await applyMetadata(supabase,job,kind,1_000_000+(group+1)*20_000+kindIndex*10_000+n/100,payload.slice(n,n+100))
        await checkpointProgress(supabase,job,{...job.manifest,dimensionRows:n+100},job.prepared_through)
      }
      await checkpointProgress(supabase,job,{...job.manifest,dimensionKind:kindIndex+1,dimensionRows:0},job.prepared_through)
    }
    await checkpointProgress(supabase,job,{...job.manifest,dimensionsGroup:group+1,dimensionKind:0,dimensionRows:0,
      taggedLines:Number(job.manifest.taggedLines ?? 0)+usage.taggedLines},job.prepared_through)
  }
  await checkpointProgress(supabase,job,{...job.manifest,metadataComplete:true},job.prepared_through)
  return true
}

export async function jobAccountIds(supabase: SupabaseClient, job: SIEJob): Promise<Map<string,string>> {
  const rows = await fetchAllRows<{ id:string;account_number:string }>(({from,to}) => supabase.from('chart_of_accounts')
    .select('id,account_number').eq('company_id',job.company_id).order('account_number').range(from,to))
  return new Map(rows.map(r => [r.account_number,r.id]))
}

function toPrepared(input: CreateJournalEntryInput, job: SIEJob, ordinal: number, accountIds: Map<string,string>): SIEPreparedEntry {
  // Generated vouchers contain one net line per mapped account, keeping the
  // finalization payload bounded even when many source accounts map together.
  const net = new Map<string,number>()
  for (const line of input.lines) net.set(line.account_number,roundOre((net.get(line.account_number) ?? 0)+line.debit_amount-line.credit_amount))
  return { sourceId:ordinal === 50_000 ? 'IB' : 'MIGRATION_ADJUSTMENT',sourceOrdinal:ordinal,
    sieImportId:job.id,series:input.voucher_series ?? 'M',date:input.entry_date,description:input.description,
    sourceSeries:null,sourceNumber:null,sourceType:input.source_type === 'opening_balance' ? 'opening_balance' : 'import',
    lines:[...net].filter(([,amount]) => amount !== 0).map(([number,amount],index) => ({account_number:number,
      account_id:accountIds.get(number) ?? null,debit_amount:Math.max(amount,0),credit_amount:Math.max(-amount,0),
      currency:'SEK',line_description:input.description,sort_order:index,dimensions:{}})) }
}

/** Returns false when the invocation budget is spent; the next lease resumes. */
export async function prepareSIEJob(supabase: SupabaseClient, job: SIEJob, deadline: number): Promise<boolean> {
  const input = jobInput(job)
  const snapshot = await snapshotSource(supabase,job,deadline)
  if (!snapshot) return false
  if (!job.manifest.metadataComplete && !await createMetadata(supabase,job,snapshot,deadline)) return false
  const accountIds = await jobAccountIds(supabase,job)
  const accountMap = mappingsToMap(input.mappings)
  const totals: PreparationTotals = job.manifest.preparationTotals as PreparationTotals ?? {
    entries:0,movements:[],skippedSample:[],skippedCounts:{empty:0,unbalanced:0,unmapped:0,singleLine:0,total:0},
  }
  let chunkNo = Number(job.manifest.preparedChunks ?? 0)
  let sourceOrdinal = job.prepared_through
  for (let group = Number(job.manifest.preparedGroups ?? 0); group < snapshot.voucherGroups; group++) {
    if (Date.now() > deadline) return false
    const raw = await readCheckpoint<SIEVoucher[]>(supabase,job,SIE_CHECKPOINTS.snapshot+1+group)
    if (!raw) throw new Error('SIE source group missing')
    const prepared = input.options.importTransactions ? await importVouchers(supabase,job.company_id,
      job.execution_actor_id ?? job.user_id,job.fiscal_period_id,{...snapshot.parsed,vouchers:raw.map(reviveVoucher)},
      accountMap,input.options.voucherSeries ?? 'B',job.id,{startOrdinal:sourceOrdinal,only:true,
        hasCurrentYearIb:snapshot.hasCurrentYearIb,accountIds}) : null
    const entries = prepared?.preparedEntries ?? []
    totals.openingEntries = (totals.openingEntries ?? 0)+entries.filter(entry => entry.sourceType === 'opening_balance').length
    if (totals.openingEntries > 1) throw new SIEJobValidationError('Filen innehåller flera ingående balansverifikationer. Granska dem före import.')
    const summary: PreparedSummary = {entries:entries.length,skipped:prepared?.skippedDetails ?? [],movements:[],firstChunk:chunkNo,chunkCount:0}
    const movements = new Map<string,number>()
    for (const entry of entries) for (const line of entry.lines) movements.set(line.account_number,
      roundOre((movements.get(line.account_number) ?? 0)+line.debit_amount-line.credit_amount))
    summary.movements = [...movements]
    for (const payload of boundedChunks(entries)) {
      await sieJobRPC(supabase,job,'save_sie_import_chunk',{p_phase:'vouchers',p_chunk_no:chunkNo++,p_payload:payload})
      summary.chunkCount++
    }
    await saveCheckpoint(supabase,job,SIE_CHECKPOINTS.prepared+group,summary)
    sourceOrdinal += raw.length
    totals.entries += summary.entries
    const aggregate = new Map(totals.movements)
    for (const [account,amount] of summary.movements) aggregate.set(account,roundOre((aggregate.get(account) ?? 0)+amount))
    totals.movements = [...aggregate]
    for (const skipped of summary.skipped) {
      totals.skippedCounts.total++
      const key = skipped.reason === 'unmapped' ? 'unmapped' : skipped.reason === 'unbalanced' ? 'unbalanced' :
        skipped.reason === 'single_line' ? 'singleLine' : 'empty'
      totals.skippedCounts[key]++
    }
    const adjustment = [...totals.skippedSample,...summary.skipped.filter(s=>['unbalanced','unmapped','single_line'].includes(s.reason))]
    // The complete list remains in immutable group checkpoints. Retain only
    // boundary references needed in the generated voucher's description.
    totals.skippedSample = adjustment.length > 8 ? [adjustment[0],...adjustment.slice().sort((a,b)=>a.date.localeCompare(b.date)).slice(0,1),
      ...adjustment.slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,1),adjustment[adjustment.length-1]] : adjustment
    await checkpointProgress(supabase,job,{...job.manifest,preparedGroups:group+1,preparedChunks:chunkNo,preparationTotals:totals},sourceOrdinal)
  }
  const movements = new Map(totals.movements)
  // Use the globally resolved IB set from the sealed parse, including the
  // explicit absence of IB when a source voucher represents it instead.
  const parsed = {...snapshot.parsed,openingBalances:job.manifest.effectiveOpeningBalances as ParsedSIEFile['openingBalances']}
  if (!snapshot.hasCurrentYearIb) parsed.closingBalances = parsed.closingBalances.filter(b => b.yearIndex !== -1)
  const finalEntries: SIEPreparedEntry[] = []
  let rounding = 0
  if (input.options.importOpeningBalances && !job.manifest.prior_activity && snapshot.hasCurrentYearIb) {
    const validation = validateIBBalance(parsed,accountMap)
    rounding = validation.roundingAdjustment
    const used = new Set(snapshot.sourceSeries)
    const series = input.options.openingBalanceSeries?.trim().toUpperCase() || defaultOpeningBalanceSeries(used)
    const opening = buildSIEOpeningBalanceEntry(job.fiscal_period_id,parsed,accountMap,rounding,series)
    if (opening) {
      if (job.manifest.derivedFromPriorYearUB) opening.description += ' (härledda från föregående års utgående balans)'
      finalEntries.push(toPrepared(opening,job,50_000,accountIds))
    }
  }
  const adjustmentCount = totals.skippedCounts.unbalanced+totals.skippedCounts.unmapped+totals.skippedCounts.singleLine
  const adjustment = adjustmentCount ? buildSIEMigrationAdjustmentEntry(job.fiscal_period_id,parsed,accountMap,movements,totals.skippedSample,adjustmentCount) : null
  if (adjustment?.input) finalEntries.push(toPrepared(adjustment.input,job,50_001,accountIds))
  if (input.options.importTransactions && snapshot.parsed.stats.totalVouchers > 0 && totals.entries === 0 && !finalEntries.length) {
    throw new SIEJobValidationError('Importen skulle skapa 0 verifikationer. Granska kontomappningen och filen.')
  }
  let finalChunk = 0
  for (const payload of boundedChunks(finalEntries)) await sieJobRPC(supabase,job,'save_sie_import_chunk',{
    p_phase:'finalize',p_chunk_no:finalChunk++,p_payload:payload})
  const manifest = {...job.manifest,parserVersion:SIE_JOB_VERSION,mappingVersion:SIE_JOB_VERSION,
    openingBalanceRounding:rounding,migrationAdjustmentAccounts:adjustment?.deltaAccounts ?? 0,
    preparationWarnings:[...(adjustment?.warnings ?? []),...(snapshot.artifactWarning ? [snapshot.artifactWarning] : [])],finalChunks:finalChunk,
    skippedCounts:totals.skippedCounts,
    preparedEntries:totals.entries,approvedInputHash:hashSIEPayload(input)}
  await sieJobRPC(supabase,job,'seal_sie_import_preparation',{p_manifest:manifest,p_chunks_total:chunkNo})
  job.manifest = manifest
  return true
}

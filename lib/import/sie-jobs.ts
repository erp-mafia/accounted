import { createHash } from 'node:crypto'
import { userFacing } from '@/lib/errors/user-facing'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountMapping, ImportResult, ParsedSIEFile, SIEVoucher } from './types'
import { calculateFileHash, getEffectiveOpeningBalances, hasOpeningBalanceVoucherCandidate, isBalanceSheetAccount, parseSIEFile } from './sie-parser'
import { ensureFiscalPeriod } from './sie-import'
import { SIE_JOB_VERSION, SIE_LIMITS, type SIEJob } from './sie-job-contract'
import { SIEJobMappingsSchema, SIEJobOptionsSchema } from '@/lib/api/schemas'
import { isAccountNumber } from '@/lib/invariants/account-number'
import { isValidBASRange } from './account-mapper'
import { SIELegacyReviewRequiredError } from './sie-legacy-recovery'

export interface SIEJobOptions {
  filename: string
  createFiscalPeriod: boolean
  importOpeningBalances: boolean
  importTransactions: boolean
  voucherSeries?: string
  openingBalanceSeries?: string
  updateAccountNames?: boolean
  markImportedNoDocRequired?: boolean
  onExistingPeriod?: 'block' | 'replace'
  supersedesImportId?: string
}

export interface SIEJobInput {
  version: number
  mappings: AccountMapping[]
  options: SIEJobOptions
  sourceHash: string
  fiscalYear?: {start:string;end:string}
}

/**
 * Every message this class carries is a finished Swedish sentence naming the
 * file, the setting or the choice the reader has to change, so it is marked
 * user-facing: without that the registry answers its code with "Förfrågan
 * innehåller ogiltiga uppgifter" and the specific half is lost. Observed on a
 * paused import, where the truth was that SIE_IMPORT_JOBS was unset.
 */
export class SIEJobValidationError extends Error {
  constructor(
    message: string,
    readonly code: string = 'VALIDATION_ERROR',
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    userFacing(this, code)
  }
}

/** Accounted's financial reports classify targets by BAS classes 1-8. */
export function assertSIEReportingAccounts(accounts: Iterable<string>): void {
  const unsupported = [...new Set(accounts)].filter(account => !isValidBASRange(account))
  if (unsupported.length) {
    throw new SIEJobValidationError(
      `Målkonton ${unsupported.slice(0, 5).join(', ')} stöds inte i balans- och resultatrapporterna. ` +
      'Mappa konton med belopp till konton 1000-8999 innan importen startas. Oanvända kontodefinitioner kan behållas.',
      'SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS',
      { account_numbers: unsupported },
    )
  }
}

/** Format validation admits chart-only definitions; financial use needs a reportable target. */
export function validateSIEReportingMappings(parsed: ParsedSIEFile, accountMap: ReadonlyMap<string, string>,
  selection: { importTransactions: boolean; importOpeningBalances: boolean },
): void {
  const used = new Set<string>()
  if (selection.importTransactions) for (const voucher of parsed.vouchers) {
    for (const line of voucher.lines) if (line.amount !== 0) used.add(line.account)
  }
  // Current-year report balances can drive a migration adjustment even when
  // opening-balance import is deselected. Do not call such definitions unused.
  if (selection.importTransactions || selection.importOpeningBalances) {
    for (const balance of [...getEffectiveOpeningBalances(parsed).balances,
      ...parsed.closingBalances.filter(balance => balance.yearIndex === 0),
      ...parsed.resultBalances.filter(balance => balance.yearIndex === 0)]) {
      if (balance.amount !== 0) used.add(balance.account)
    }
  }
  const targets = [...used].map(account => accountMap.get(account)).filter((target): target is string => Boolean(target))
  assertSIEReportingAccounts(targets)
}

function jobDatabaseError(error:{code?:string;message:string}):Error {
  const codes:Record<string,string> = {P0002:'NOT_FOUND','42501':'DB_PERMISSION_DENIED','22P02':'VALIDATION_ERROR',
    '22023':'VALIDATION_ERROR','23505':'CONFLICT','55000':'CONFLICT','55P03':'CONFLICT'}
  return Object.assign(new Error(error.message),{code:codes[error.code ?? ''] ?? error.code})
}

export function acceptsSIEJobs(): boolean { return process.env.SIE_IMPORT_JOBS === 'true' }
export function runsSIEJobs(): boolean { return process.env.SIE_IMPORT_WORKER_PAUSED !== 'true' }

/** Warnings remain useful in previews; selected accounting records must be complete. */
export function validateSIEAccountingAmounts(parsed: ParsedSIEFile, accountMap: ReadonlyMap<string, string>, selection: {
  importTransactions: boolean
  importOpeningBalances: boolean
  migrationAdjustment?: boolean
  openingBalanceVoucherCandidate?: boolean
}): void {
  // No adjustment is generated without current-year report balances. Include
  // omitted damaged records, so an all-invalid report cannot disable the guard.
  const usesAdjustment = selection.migrationAdjustment && (parsed.closingBalances.some(balance => balance.yearIndex === 0) ||
    parsed.resultBalances.some(balance => balance.yearIndex === 0) || parsed.issues.some(issue =>
      issue.code === 'invalid_amount' && issue.yearIndex === 0 && (issue.tag === 'UB' || issue.tag === 'RES')))
  const usesOpeningBalances = selection.importOpeningBalances || usesAdjustment
  const hasExplicitIB = parsed.openingBalances.some(balance => balance.yearIndex === 0)
  const hasOpeningVoucher = selection.openingBalanceVoucherCandidate ?? hasOpeningBalanceVoucherCandidate(parsed)
  const invalid = parsed.issues.filter(issue => {
    if (issue.code !== 'invalid_amount') return false
    if (issue.tag === 'TRANS') {
      // Without explicit IB, active lines also decide whether an opening
      // voucher suppresses the prior-year UB fallback, even for IB-only jobs.
      return selection.importTransactions || (usesOpeningBalances && !hasExplicitIB)
    }
    if (issue.tag === 'IB' && issue.yearIndex === 0) return usesOpeningBalances
    const target = accountMap.get(issue.account ?? '')
    if (issue.tag === 'UB' && issue.yearIndex === -1) {
      return usesOpeningBalances && !hasExplicitIB && !hasOpeningVoucher && isBalanceSheetAccount(issue.account ?? '') &&
        (selection.importOpeningBalances || !!target && isBalanceSheetAccount(target))
    }
    if (!usesAdjustment || issue.yearIndex !== 0 || !target) return false
    // The adjustment selects current-year UB/RES by the mapped account class.
    return issue.tag === 'UB' && isBalanceSheetAccount(target) || issue.tag === 'RES' && !isBalanceSheetAccount(target)
  })
  if (invalid.length) {
    const details = invalid.slice(0, 5).map(issue => `Rad ${issue.line}: ${issue.message}`).join(' ')
    throw new SIEJobValidationError(`SIE-filen innehåller ${invalid.length} ogiltiga belopp i bokföringsunderlaget. ${details}`)
  }
}

export function validateSIEJobInput(content: string, parsed: ParsedSIEFile, mappings: AccountMapping[], options: SIEJobOptions): void {
  if (!content || Buffer.byteLength(content, 'utf8') > SIE_LIMITS.fileBytes) {
    throw new SIEJobValidationError('SIE-filen måste vara högst 50 MB och får inte vara tom.')
  }
  const parseErrors = parsed.issues.filter(issue => issue.severity === 'error')
  if (parseErrors.length) {
    const details = parseErrors.slice(0, 5).map(issue => `Rad ${issue.line}: ${issue.message}`).join(' ')
    throw new SIEJobValidationError(`SIE-filen innehåller ${parseErrors.length} tolkningsfel. ${details}`)
  }
  validateSIEAccountingAmounts(parsed, new Map(mappings.map(mapping => [mapping.sourceAccount, mapping.targetAccount])), options)
  validateSIEReportingMappings(parsed, new Map(mappings.map(mapping => [mapping.sourceAccount, mapping.targetAccount])), options)
  if (parsed.vouchers.length > SIE_LIMITS.fileVouchers) throw new SIEJobValidationError('SIE-filen har fler än 50 000 verifikationer.')
  if (!parsed.stats.fiscalYearStart || !parsed.stats.fiscalYearEnd) throw new SIEJobValidationError('SIE-filen saknar räkenskapsår.')
  if (!options.importOpeningBalances && !options.importTransactions) throw new SIEJobValidationError('Välj vad som ska importeras.')
  const mapped = new Set(mappings.filter(m => isAccountNumber(m.targetAccount)).map(m => m.sourceAccount))
  const required = new Set<string>()
  if (options.importTransactions) for (const voucher of parsed.vouchers) {
    for (const line of voucher.lines) required.add(line.account)
    const source = `${voucher.series}${voucher.number}`
    if (voucher.lines.length > SIE_LIMITS.chunkLines || Buffer.byteLength(JSON.stringify(voucher),'utf8') > SIE_LIMITS.chunkBytes) {
      throw new SIEJobValidationError(`SIE-verifikation ${source} överskrider gränsen på 2 000 rader eller 1 MB.`)
    }
    const date = voucherDate(voucher)
    if (date < parsed.stats.fiscalYearStart || date > parsed.stats.fiscalYearEnd) {
      throw new SIEJobValidationError(`SIE-verifikation ${source} (${date}) ligger utanför räkenskapsåret.`)
    }
  }
  if (options.importOpeningBalances) for (const balance of getEffectiveOpeningBalances(parsed).balances) required.add(balance.account)
  if (required.size && ![...required].some(a => mapped.has(a))) throw new SIEJobValidationError('Kontomappningarna täcker inga konton i SIE-filen.')
  if (mappings.some(m => m.targetAccount && !isAccountNumber(m.targetAccount))) throw new SIEJobValidationError('Alla målkonton måste vara giltiga kontonummer.')
  if (/^\s*#VER\b/m.test(content) && !parsed.vouchers.length) throw new SIEJobValidationError('Filens verifikationer kunde inte tolkas.')
}

export function voucherDate(voucher: SIEVoucher): string {
  const d = voucher.date
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new SIEJobValidationError('Verifikationsdatum saknas.')
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

/** SIE4I may omit #RAR. Resolve only an existing period containing every date. */
export async function resolveSIEFiscalYear(supabase:SupabaseClient,companyId:string,parsed:ParsedSIEFile):Promise<void> {
  if (parsed.stats.fiscalYearStart && parsed.stats.fiscalYearEnd) return
  if (!parsed.vouchers.length) throw new SIEJobValidationError('SIE-filen saknar räkenskapsår.')
  const dates = parsed.vouchers.map(voucherDate).sort()
  const {data,error} = await supabase.from('fiscal_periods').select('period_start,period_end')
    .eq('company_id',companyId).lte('period_start',dates[0]).gte('period_end',dates[dates.length-1]).limit(2)
  if (error) throw error
  if (data?.length !== 1) throw new SIEJobValidationError('SIE-filen saknar #RAR. Skapa ett räkenskapsår som omfattar filens datum först.')
  applySIEFiscalYear(parsed,{start:data[0].period_start,end:data[0].period_end})
}

export function applySIEFiscalYear(parsed:ParsedSIEFile,period?:{start:string;end:string}):void {
  if (parsed.stats.fiscalYearStart && parsed.stats.fiscalYearEnd || !period) return
  parsed.header.fiscalYears.push({yearIndex:0,...period})
  parsed.stats.fiscalYearStart = period.start
  parsed.stats.fiscalYearEnd = period.end
}

export async function getSIEJob(supabase: SupabaseClient, companyId: string, importId: string): Promise<SIEJob | null> {
  const { data, error } = await supabase.from('sie_imports').select('*').eq('company_id', companyId).eq('id', importId).maybeSingle()
  if (error) throw jobDatabaseError(error)
  return data?.job_state ? data as SIEJob : null
}

/** Archive before reserving the execution. The path is immutable and tenant scoped. */
export async function submitSIEJob(supabase: SupabaseClient, companyId: string, userId: string,
  content: string, mappings: AccountMapping[], options: SIEJobOptions,
  originalFile?: File,
): Promise<SIEJob> {
  if (!acceptsSIEJobs()) throw new SIEJobValidationError('Nya SIE-importer är tillfälligt pausade. Pågående importer fortsätter.')
  const checkedOptions = SIEJobOptionsSchema.safeParse(options)
  const checkedMappings = SIEJobMappingsSchema.safeParse(mappings)
  if (!checkedOptions.success || !checkedMappings.success) throw new SIEJobValidationError('Importinställningarna eller kontomappningen är ogiltiga.')
  options = {...checkedOptions.data,filename:options.filename}
  mappings = checkedMappings.data
  const parsed = parseSIEFile(content)
  await resolveSIEFiscalYear(supabase,companyId,parsed)
  validateSIEJobInput(content, parsed, mappings, options)
  const sourceHash = await calculateFileHash(content)
  const input: SIEJobInput = { version: SIE_JOB_VERSION, sourceHash, mappings, options,
    fiscalYear:{start:parsed.stats.fiscalYearStart!,end:parsed.stats.fiscalYearEnd!} }
  if (Buffer.byteLength(JSON.stringify(input),'utf8') > 900_000) throw new SIEJobValidationError('Kontomappningen är för stor. Dela upp importen.')
  const path = `${companyId}/sie-jobs/${sourceHash}.se`
  const { error: uploadError } = await supabase.storage.from('sie-files').upload(path, new Blob([content],{type:'text/plain'}),{upsert:false})
  if (uploadError) {
    // Only an identical, already archived object is a safe retry.
    const { data, error } = await supabase.storage.from('sie-files').download(path)
    if (error || !data || await calculateFileHash(await data.text()) !== sourceHash) throw new Error('SIE-filen kunde inte arkiveras.')
  }
  let originalSource:Record<string,unknown> = {format:'provided_text',path,sha256:sourceHash}
  if (originalFile) {
    if (originalFile.size > SIE_LIMITS.fileBytes) throw new SIEJobValidationError('SIE-filen är större än 50 MB.')
    const bytes = await originalFile.arrayBuffer()
    const rawHash = createHash('sha256').update(new Uint8Array(bytes)).digest('hex')
    const originalPath = `${companyId}/sie-originals/${rawHash}.se`
    const uploaded = await supabase.storage.from('sie-files').upload(originalPath,originalFile,{upsert:false})
    if (uploaded.error) {
      const existing = await supabase.storage.from('sie-files').download(originalPath)
      if (existing.error || !existing.data || createHash('sha256').update(new Uint8Array(await existing.data.arrayBuffer())).digest('hex') !== rawHash) {
        throw new Error('SIE-originalet kunde inte arkiveras.')
      }
    }
    originalSource = {format:'original_bytes',path:originalPath,sha256:rawHash,bytes:originalFile.size,filename:originalFile.name}
  }
  let periodId: string
  if (options.createFiscalPeriod) {
    periodId = await ensureFiscalPeriod(supabase,companyId,parsed.stats.fiscalYearStart!,parsed.stats.fiscalYearEnd!)
  } else {
    const { data, error } = await supabase.from('fiscal_periods').select('id').eq('company_id',companyId)
      .lte('period_start',parsed.stats.fiscalYearStart!).gte('period_end',parsed.stats.fiscalYearEnd!).single()
    if (error || !data) throw new SIEJobValidationError('Inget matchande räkenskapsår hittades.')
    periodId = data.id
  }
  if (options.onExistingPeriod === 'replace' && !options.supersedesImportId) {
    throw new SIEJobValidationError('Välj den import som ska ersättas. Granska importhistoriken och försök igen.')
  }
  const {data: predecessor, error: predecessorError} = await supabase.from('sie_imports')
    .select('id,job_state,file_hash').eq('company_id',companyId).eq('fiscal_period_id',periodId).eq('job_kind','import')
    .in('job_state',['undone'])
    .order('created_at',{ascending:false}).limit(1).maybeSingle()
  if (predecessorError) throw new Error(predecessorError.message)
  const replacing = options.onExistingPeriod === 'replace'
  const { data, error } = await supabase.rpc(replacing ? 'replace_sie_import_job' : 'start_sie_import_job', {
    p_company_id: companyId, p_actor: userId, p_period_id: periodId, p_filename: options.filename,
    p_file_hash: sourceHash, p_manifest: { input, file_storage_path: path, originalSource },
    p_supersedes_import_id: replacing ? options.supersedesImportId : predecessor?.id ?? null,
  })
  if (error) throw jobDatabaseError(error)
  return data as SIEJob
}

/** Reject untracked legacy attempts before forwarding durable actions to guarded RPCs. */
export async function requestSIEJobAction(supabase: SupabaseClient, companyId: string, userId: string,
  importId: string, action: 'resume' | 'undo',
): Promise<SIEJob> {
  // A legacy row exists but cannot be acted on by the durable job RPCs.
  // Keep this preflight read-only; the RPC still rechecks durable authorization and locks.
  const lookup = await supabase.from('sie_imports').select('id,job_state')
    .eq('company_id', companyId).eq('id', importId).maybeSingle()
  if (lookup.error) throw lookup.error
  if (!lookup.data) throw Object.assign(new Error('SIE import not found'), { code: 'NOT_FOUND' })
  if (!lookup.data.job_state) throw new SIELegacyReviewRequiredError()
  const { data, error } = await supabase.rpc(action === 'undo' ? 'request_sie_import_undo' : 'resume_sie_import_job', {
    p_company_id: companyId, p_import_id: importId, p_actor: userId,
  })
  if (error) throw jobDatabaseError(error)
  return data as SIEJob
}

/** A worker never downloads a caller-selected arbitrary storage path. */
export async function readSIEJobSource(supabase: SupabaseClient, job: SIEJob): Promise<string> {
  const expected = `${job.company_id}/sie-jobs/${job.file_hash}.se`
  if (job.file_storage_path !== expected || !/^[a-f0-9]{64}$/.test(job.file_hash)) throw new SIEJobValidationError('Importens arkivlänk är ogiltig.')
  const { data, error } = await supabase.storage.from('sie-files').download(expected)
  if (error || !data || data.size > SIE_LIMITS.fileBytes) throw new Error('Importens arkivfil kunde inte läsas.')
  const content = await data.text()
  if (createHash('sha256').update(content).digest('hex') !== job.file_hash) throw new SIEJobValidationError('Importens arkivfil har ändrats.')
  return content
}

export function completedSIEJobResult(job: SIEJob): ImportResult | null {
  return job.job_state === 'completed' ? job.job_result as unknown as ImportResult : null
}

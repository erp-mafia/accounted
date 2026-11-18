import { createHash } from 'node:crypto'
import { userFacing } from '@/lib/errors/user-facing'
import { isSelfHosted } from '@/lib/env/public-flags'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountMapping, ParsedSIEFile, SIEVoucher } from './types'
import { calculateFileHash, getEffectiveOpeningBalances, hasOpeningBalanceVoucherCandidate, isBalanceSheetAccount, parseSIEFile, sieCurrencyRefusal } from './sie-parser'
import { ensureFiscalPeriod } from './sie-import'
import { NO_MATCHING_FISCAL_YEAR } from './sie-admission'
import { SIE_JOB_VERSION, SIE_LIMITS, type SIEJob } from './sie-job-contract'
import { SIEJobMappingsSchema, SIEJobOptionsSchema } from '@/lib/api/schemas'
import { isAccountNumber } from '@/lib/invariants/account-number'
import { isValidBASRange } from './account-mapper'
import { onlyUsedSIEMappings } from './sie-preview-mappings'
import { findSIEAmountsWithoutTarget, sieAmountsWithoutTargetSentence } from './sie-amounts-without-target'
import { SIELegacyReviewRequiredError } from './sie-legacy-recovery'
import { checkSourceOrgNumber } from '@/lib/company/org-number'
import { isVoucherOnlySIE } from './sie-voucher-only'
import { getActor, type CommitActor } from '@/lib/bookkeeping/actor-context'
import { rpcWithActor } from '@/lib/bookkeeping/actor-rpc'
import { appSIEArrivalDoor, recordSIEImportArrival, type SIEArchivedOriginal, type SIEArrivalDoor } from './sie-arrival'
import { findLiveCorrections, liveCorrectionSentence } from './sie-live-corrections'
import { planSIEAppend, type SIEAppendRefusal } from './sie-append'

export interface SIEJobOptions {
  filename: string
  createFiscalPeriod: boolean
  importOpeningBalances: boolean
  importTransactions: boolean
  voucherSeries?: string
  openingBalanceSeries?: string
  updateAccountNames?: boolean
  markImportedNoDocRequired?: boolean
  /** Create only the accounts the file uses (#63). The mappings of every
   *  other #KONTO definition are dropped at submit, so the sealed input and
   *  every resumed preparation create the same accounts. */
  onlyUsedAccounts?: boolean
  /** 'append' adds only the file's vouchers the year's import does not hold, as their own batch (sie-append.ts). */
  onExistingPeriod?: 'block' | 'replace' | 'append'
  supersedesImportId?: string
  /** Append: also book the possible duplicates (same date and lines as a posted entry). */
  includePossibleDuplicates?: boolean
  /** Append: a source series booked in another series ({ K: 'A' }). */
  seriesMap?: Record<string, string>
  /** Import a file whose #ORGNR is not the company's (ombildning, a company
   *  registered under the wrong number). Checked at submit, never stored in
   *  the job's input: that input is the identity an identical retry matches. */
  confirmOrgNumberMismatch?: boolean
}

/** Which import a job's verifikat name in their commit label. */
export type SIEImportSource = 'sie_file' | 'provider_migration'

const SIE_IMPORT_SOURCE_LABELS: Record<SIEImportSource, string> = {
  sie_file: 'SIE import',
  provider_migration: 'Provider migration (SIE import)',
}

/** The commit actor sealed into a job's manifest as commit_actor. */
export interface SIEImportCommitActor {
  type: CommitActor['type']
  label: string
}

/**
 * WHO the verifikat of an SIE import (a file upload or a provider migration)
 * record as their committer: the actor that submitted the job (the user, the
 * API key or the OAuth client), with a label saying they came from an import.
 * The chunks are written later by the job worker, which may run under a cron,
 * so the actor is read here at submit and sealed into the job manifest;
 * import_sie_chunk hands it to write_sie_job_entries, which stamps
 * committed_actor_* (and commit_method 'migration') when it posts each chunk
 * (migration 20261015235000). Null outside an actor scope: no stamp, as
 * before.
 */
export function sieImportCommitActor(
  actor: CommitActor | undefined,
  source: SIEImportSource = 'sie_file',
): SIEImportCommitActor | null {
  if (!actor) return null
  const base = SIE_IMPORT_SOURCE_LABELS[source]
  return { type: actor.type, label: actor.label ? `${base}: ${actor.label}` : base }
}

/**
 * WHO the stornos of an SIE undo record as their committer: the actor that
 * asked for the undo, labelled as an undo. request_sie_import_undo records it
 * on the job and undo_sie_import_chunk stamps it on each storno (commit_method
 * 'migration', migration 20261016005200). Undefined outside an actor scope:
 * no stamp, as before.
 */
export function sieUndoCommitActor(actor: CommitActor | undefined): CommitActor | undefined {
  if (!actor) return undefined
  return { type: actor.type, label: actor.label ? `SIE undo: ${actor.label}` : 'SIE undo' }
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
 * file, the setting or the choice the reader has to change. Under the generic
 * VALIDATION_ERROR code it is marked user-facing: without that the registry
 * answers the code with "Förfrågan innehåller ogiltiga uppgifter" and the
 * specific half is lost. A code with its own registry entry
 * (SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS) is left unmarked so it keeps that
 * bilingual text, the same split sieJobValidationResponse makes.
 */
export class SIEJobValidationError extends Error {
  constructor(
    message: string,
    readonly code: string = 'VALIDATION_ERROR',
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    if (code === 'VALIDATION_ERROR') userFacing(this, code)
  }
}

/**
 * A path that is not `<companyId>/sie-intake/<id>.se` for the ACTIVE company
 * (readSIEIntakeFile): another company's file, a traversal attempt or a
 * made-up key. Never read. Still a SIEJobValidationError, so a caller that
 * only knows the parent answers exactly as before.
 */
export class SIEIntakePathError extends SIEJobValidationError {}

/** A well-formed intake path with no readable file behind it. */
export class SIEIntakeNotFoundError extends SIEJobValidationError {}

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

/**
 * A SIE job RPC answered with a SQLSTATE: the database ran the call and
 * refused it, so its transaction rolled back and nothing started. `code` is
 * the application code every door answers with; the raw SQLSTATE stays on
 * `pgCode` for the logs.
 */
export class SIEJobDatabaseError extends Error {
  constructor(message: string, readonly code: string | undefined, readonly pgCode: string | undefined) { super(message) }
}

// 55000 alone does not say which guard refused: start_sie_import_job raises it
// for several reasons. A refusal whose raised sentence has its own registry
// entry keeps that meaning instead of the generic CONFLICT.
const JOB_REFUSALS: Record<string,string> = {
  'Existing SIE import requires reviewed replacement or reconciliation':'SIE_IMPORT_PERIOD_ALREADY_IMPORTED',
  'Legacy SIE import requires reviewed reconciliation before replacement':'SIE_IMPORT_LEGACY_REVIEW_REQUIRED',
  // request_sie_import_undo, also run by replace_sie_import_job (PH 223).
  'SIE undo requires review: an imported voucher has a live correction':'SIE_IMPORT_HAS_LIVE_CORRECTION',
  // request_sie_import_undo (also run by replace_sie_import_job): the import
  // has an append that is not undone (issue #108).
  'SIE undo requires review: an append batch is live':'SIE_IMPORT_HAS_LIVE_APPEND',
  // start_sie_append_job: the year's import is gone or not finished.
  'SIE append requires a completed base import of the year':'SIE_IMPORT_APPEND_NO_BASE',
  // start_sie_import_job and start_sie_append_job: another import of the
  // company is queued, running or stopped mid-way, or another run holds the
  // year. Waiting for it, or resuming or undoing it, is the way on.
  'SIE import is unfinished: resume or undo it':'SIE_IMPORT_UNFINISHED',
  // replace_sie_import_job: the import to replace is itself queued, running
  // or stopped mid-way. Same way on, so the same code and sentence. Reached
  // from the import page and the v1 import; an approval never replaces.
  'SIE import is unfinished: resume or undo it first':'SIE_IMPORT_UNFINISHED',
}

/**
 * Refusals the database words for the reader: it writes a Swedish sentence
 * after the code and a colon, naming what is in the way and what to change,
 * so the sentence reaches the reader as is through every door.
 *
 *   SIE_IMPORT_PERIOD_LOCKED: the undo, the resume of an undo and the
 *     replacement refuse a locked fiscal year or company lock date before
 *     anything is queued (migration 20261005193558, crm#1022).
 *   SIE_IMPORT_PERIOD_HAS_OPENING_BALANCE: the year already has an IB
 *     verifikat no import owns and the import would book the file's IB on
 *     top of it (sie_import_admission_refusal, crm#1272).
 */
const PREFIXED_REFUSALS = ['SIE_IMPORT_PERIOD_LOCKED','SIE_IMPORT_PERIOD_HAS_OPENING_BALANCE'] as const

const CHANGED_RETRY_RAISE = 'SIE retry has different mapping or options'
const CHANGED_RETRY_SENTENCE = 'Den här filen har redan en import för räkenskapsåret, med en annan kontomappning eller andra ' +
  'inställningar än de du valde nu. Ska filen läsas in med de nya valen: öppna importhistoriken och ångra den tidigare importen först.'

export function jobDatabaseError(error:{code?:string;message:string}):SIEJobDatabaseError {
  const prefixed = error.code === '55000'
    ? PREFIXED_REFUSALS.find(code => error.message.startsWith(`${code}: `)) : undefined
  if (prefixed) {
    return userFacing(new SIEJobDatabaseError(error.message.slice(prefixed.length + 2),prefixed,error.code),prefixed)
  }
  // The same file is already imported, or being imported, into this year
  // with another mapping or other options (23505 from start_sie_import_job
  // and start_sie_append_job). As a bare CONFLICT the reader got "the request
  // conflicts" and no way on; the year holds an import, and undoing it is
  // how the file is read again with the new choices.
  if (error.code === '23505' && error.message === CHANGED_RETRY_RAISE) {
    return userFacing(new SIEJobDatabaseError(CHANGED_RETRY_SENTENCE,'SIE_IMPORT_PERIOD_ALREADY_IMPORTED',error.code),
      'SIE_IMPORT_PERIOD_ALREADY_IMPORTED')
  }
  // 55P03 (lock not available) frees itself: the same request succeeds on a
  // retry, which is what TRANSIENT_ERROR says. It is never an existing import.
  const codes:Record<string,string> = {P0002:'NOT_FOUND','42501':'DB_PERMISSION_DENIED','22P02':'VALIDATION_ERROR',
    '22023':'VALIDATION_ERROR','23505':'CONFLICT','55000':'CONFLICT','55P03':'TRANSIENT_ERROR'}
  const refusal = error.code === '55000' && Object.hasOwn(JOB_REFUSALS,error.message) ? JOB_REFUSALS[error.message] : undefined
  return new SIEJobDatabaseError(error.message,refusal ?? codes[error.code ?? ''] ?? error.code,error.code)
}

/**
 * The live-correction refusal of an undo or a replacement, worded for the
 * reader: which imported verifikat were corrected, by which correction, and
 * what to do (sie-live-corrections.ts, PH 223). Any other error is returned
 * as it came. Without the import id, or when the read fails or finds
 * nothing, the code stays and the registry's static sentence answers: a
 * lookup error never masks the refusal.
 */
export async function nameLiveCorrections(error: SIEJobDatabaseError, supabase: SupabaseClient, companyId: string,
  importId: string | undefined, action: 'undo' | 'replace',
): Promise<SIEJobDatabaseError> {
  if (error.code !== 'SIE_IMPORT_HAS_LIVE_CORRECTION' || !importId) return error
  const corrections = await findLiveCorrections(supabase, companyId, importId).catch(() => [])
  if (corrections.length === 0) return error
  return userFacing(new SIEJobDatabaseError(liveCorrectionSentence(corrections, action), error.code, error.pgCode), error.code)
}

/**
 * Whether new SIE imports are admitted (SIE_IMPORT_JOBS).
 *
 * Hosted: off unless the flag is 'true'. It was the last step of the
 * production cutover to the job backbone and stays the hosted kill switch
 * (docs/operations/sie-import-backbone.md).
 *
 * Self-hosted: on unless the operator sets the flag to 'false'. An install has
 * no cutover to stage: the migrations, the after() fast path and the worker
 * cron (docker/crontab.self-hosted) ship together, and the import RPCs from
 * before the backbone are retired, so with admission off there is no SIE
 * import at all. Off by default only meant that it never worked until
 * someone found a variable no file mentioned.
 */
export function acceptsSIEJobs(): boolean {
  const flag = process.env.SIE_IMPORT_JOBS
  return isSelfHosted() ? flag !== 'false' : flag === 'true'
}

/**
 * The admission refusal, worded for the reader who can act on it. On a
 * self-hosted install that is the operator, and the only way to get here is
 * the flag set to 'false', so the sentence names it. A hosted user cannot
 * change anything and is told only that the pause is temporary.
 */
function sieAdmissionRefusal(): string {
  return isSelfHosted()
    ? 'SIE-importen är avstängd på den här installationen: SIE_IMPORT_JOBS=false i appens miljö (.env). ' +
      'Ta bort raden eller sätt SIE_IMPORT_JOBS=true och starta om appen. Pågående importer fortsätter.'
    : 'Nya SIE-importer är tillfälligt pausade. Pågående importer fortsätter.'
}

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
  const currencyRefusal = sieCurrencyRefusal(parsed.header)
  if (currencyRefusal) throw new SIEJobValidationError(currencyRefusal)
  const parseErrors = parsed.issues.filter(issue => issue.severity === 'error')
  if (parseErrors.length) {
    const details = parseErrors.slice(0, 5).map(issue => `Rad ${issue.line}: ${issue.message}`).join(' ')
    throw new SIEJobValidationError(`SIE-filen innehåller ${parseErrors.length} tolkningsfel. ${details}`)
  }
  validateSIEAccountingAmounts(parsed, new Map(mappings.map(mapping => [mapping.sourceAccount, mapping.targetAccount])), options)
  validateSIEReportingMappings(parsed, new Map(mappings.map(mapping => [mapping.sourceAccount, mapping.targetAccount])), options)
  if (parsed.vouchers.length > SIE_LIMITS.fileVouchers) {
    throw new SIEJobValidationError(
      `SIE-filen har ${parsed.vouchers.length.toLocaleString('sv-SE')} verifikationer, fler än de ${SIE_LIMITS.fileVouchers.toLocaleString('sv-SE')} som en import tar emot. ` +
      'Hör av dig till supporten, så hjälper vi dig att få in räkenskapsåret.',
    )
  }
  if (!parsed.stats.fiscalYearStart || !parsed.stats.fiscalYearEnd) throw new SIEJobValidationError('SIE-filen saknar räkenskapsår.')
  if (!options.importOpeningBalances && !options.importTransactions) throw new SIEJobValidationError('Välj vad som ska importeras.')
  const mapped = new Set(mappings.filter(m => isAccountNumber(m.targetAccount)).map(m => m.sourceAccount))
  const required = new Set<string>()
  if (options.importTransactions) for (const voucher of parsed.vouchers) {
    // A voucher without lines (#BTRANS only, or an empty block) is skipped at
    // preparation as empty and never posted, so neither its size nor its date
    // can refuse the file. One such voucher dated in the previous year refused
    // the same file three times (Easy Online Stores, 2026-09-16).
    if (!voucher.lines.length) continue
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
  // Every amount the file states has a target, or the import stops and names
  // the accounts (sie-amounts-without-target.ts). A voucher that moves no
  // balance may still go without one: it is skipped and nothing is lost.
  const withoutTarget = findSIEAmountsWithoutTarget(parsed, mapped, options)
  if (withoutTarget.length) {
    throw userFacing(new SIEJobValidationError(sieAmountsWithoutTargetSentence(withoutTarget), 'SIE_IMPORT_UNMAPPED_ACCOUNTS', {
      // Not `unmappedAccounts`: the wizard lists that key per account under
      // the sentence, which already names them.
      accounts_without_target: withoutTarget.slice(0, 200).map(({ account, name, vouchers, firstVoucher, openingBalance }) => ({
        account, name, vouchers, first_voucher: firstVoucher, opening_balance: openingBalance,
      })),
      accounts_without_target_count: withoutTarget.length,
    }), 'SIE_IMPORT_UNMAPPED_ACCOUNTS')
  }
  if (/^\s*#VER\b/m.test(content) && !parsed.vouchers.length) throw new SIEJobValidationError('Filens verifikationer kunde inte tolkas.')
}

export function voucherDate(voucher: SIEVoucher): string {
  const d = voucher.date
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new SIEJobValidationError('Verifikationsdatum saknas.')
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

/**
 * The longest a fiscal year can be: an extended first or changed year runs up
 * to 18 months (SIE skill, validation-rules "Broken fiscal year validation").
 * Verifikat dated further apart than that cannot share one year.
 */
const MAX_FISCAL_YEAR_MONTHS = 18

function spansMoreThanAFiscalYear(first: string, last: string): boolean {
  const [year, month, day] = first.split('-').map(Number)
  const limit = new Date(Date.UTC(year, month - 1 + MAX_FISCAL_YEAR_MONTHS, day)).toISOString().slice(0, 10)
  return last >= limit
}

/**
 * SIE4I may omit #RAR. Resolve only an existing period containing every date.
 *
 * A file without #RAR whose verifikat run over more than one fiscal year
 * (Fortnox's "Kundfakturor och inbetalningar" export, spans of up to ten
 * years) can never be resolved this way, and creating a year, which the
 * generic refusal asked for, does not help. Such a file is a partial export:
 * customer invoices and payments only, verifikat a full SIE of the same years
 * already carries. The refusal says what the file is and what to export
 * instead; importing it into whichever years exist would book those verifikat
 * a second time.
 */
export async function resolveSIEFiscalYear(supabase:SupabaseClient,companyId:string,parsed:ParsedSIEFile):Promise<void> {
  if (parsed.stats.fiscalYearStart && parsed.stats.fiscalYearEnd) return
  if (!parsed.vouchers.length) throw new SIEJobValidationError('SIE-filen saknar räkenskapsår.')
  const dates = parsed.vouchers.map(voucherDate).sort()
  const first = dates[0]
  const last = dates[dates.length-1]
  // Every company year the file's dates touch; the containing one is among them.
  const {data,error} = await supabase.from('fiscal_periods').select('period_start,period_end')
    .eq('company_id',companyId).lte('period_start',last).gte('period_end',first).order('period_start')
  if (error) throw error
  const periods = (data ?? []) as Array<{period_start:string;period_end:string}>
  const containing = periods.filter(p => p.period_start <= first && p.period_end >= last)
  if (containing.length === 1) {
    applySIEFiscalYear(parsed,{start:containing[0].period_start,end:containing[0].period_end})
    return
  }
  if (containing.length === 0 && (periods.length > 1 || spansMoreThanAFiscalYear(first,last))) {
    throw new SIEJobValidationError(
      `SIE-filen saknar räkenskapsår (#RAR) och verifikationerna sträcker sig över mer än ett räkenskapsår (${first} till ${last}). ` +
      'En sådan fil, till exempel Fortnox export Kundfakturor och inbetalningar, är en delexport med bara en del av bokföringen. ' +
      'Exportera i stället hela bokföringen som SIE typ 4, en fil per räkenskapsår. ' +
      'Är räkenskapsåren redan importerade finns verifikationerna redan i bokföringen: importera inte filen ovanpå, då bokförs de två gånger. ' +
      'Ska bara filens verifikationer läggas till, exportera en fil per räkenskapsår.',
    )
  }
  throw new SIEJobValidationError(`SIE-filen saknar #RAR. Skapa ett räkenskapsår som omfattar filens datum (${first} till ${last}) först.`)
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

/**
 * Archive before reserving the execution. The path is immutable and tenant
 * scoped. `arrival` names the door the file came through (the app's by
 * default); the admitted job is recorded as an arrival pointing at the
 * archived original, best effort.
 */
export async function submitSIEJob(supabase: SupabaseClient, companyId: string, userId: string,
  content: string, mappings: AccountMapping[], options: SIEJobOptions,
  originalFile?: File, source: SIEImportSource = 'sie_file', arrival?: SIEArrivalDoor,
): Promise<SIEJob> {
  if (!acceptsSIEJobs()) throw new SIEJobValidationError(sieAdmissionRefusal())
  const checkedOptions = SIEJobOptionsSchema.safeParse(options)
  const checkedMappings = SIEJobMappingsSchema.safeParse(mappings)
  if (!checkedOptions.success || !checkedMappings.success) throw new SIEJobValidationError('Importinställningarna eller kontomappningen är ogiltiga.')
  const { confirmOrgNumberMismatch, ...jobOptions } = checkedOptions.data
  options = {...jobOptions,filename:options.filename}
  mappings = checkedMappings.data
  const parsed = parseSIEFile(content)
  // Decided here, before the input is sealed, so the job's account pass and
  // every resumed checkpoint read the same mappings (#63).
  if (options.onlyUsedAccounts) mappings = onlyUsedSIEMappings(parsed, mappings)
  // A verifikat-only file (a card provider's, payroll's or POS system's) never
  // replaces a year's import: the replacement would drop every verifikat the
  // file does not carry (crm#1049). Without "replace" the database refuses an
  // imported year itself (SIE_IMPORT_PERIOD_ALREADY_IMPORTED).
  if (options.onExistingPeriod === 'replace' && isVoucherOnlySIE(parsed)) {
    throw new SIEJobValidationError(
      'SIE-filen innehåller bara verifikationer och kan inte ersätta räkenskapsårets import.',
      'SIE_IMPORT_VOUCHERS_ONLY_FILE',
      {
        existing_import_id: options.supersedesImportId ?? null,
        fiscal_year_start: parsed.stats.fiscalYearStart,
        fiscal_year_end: parsed.stats.fiscalYearEnd,
        vouchers: parsed.vouchers.length,
      },
    )
  }
  await resolveSIEFiscalYear(supabase,companyId,parsed)
  const appending = options.onExistingPeriod === 'append'
  if (appending) options = appendJobOptions(options, parsed)
  else { delete options.includePossibleDuplicates; delete options.seriesMap }
  validateSIEJobInput(content, parsed, mappings, options)
  // Every door passes here (dashboard, onboarding, v1, MCP approval, provider
  // migration), so this is where another organisation's books are stopped.
  // Not a hard block: an ombildning or a company registered under the wrong
  // number is legitimate, so the user confirms instead.
  const orgCheck = await checkSourceOrgNumber(supabase, companyId, parsed.header.orgNumber)
  if (orgCheck.mismatch && !confirmOrgNumberMismatch) {
    throw new SIEJobValidationError(
      `SIE-filen gäller organisationsnummer ${orgCheck.fileOrgNumber}, inte företagets (${orgCheck.companyOrgNumber}).`,
      'SIE_IMPORT_ORG_NUMBER_MISMATCH',
      { file_org_number: orgCheck.fileOrgNumber, company_org_number: orgCheck.companyOrgNumber,
        file_company_name: parsed.header.companyName },
    )
  }
  // The append's verdicts, refused before anything is archived or queued.
  // The job plans again per voucher group and writes what that plan keeps.
  const appendPlan = appending ? await planSIEAppend(supabase, companyId, parsed, mappings, options) : null
  if (appendPlan?.refusal) throw sieAppendRefusalError(appendPlan.refusal)
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
  // The file's #ORGNR as written, so an import into another organisation's
  // company can be counted afterwards. It lives here rather than in input,
  // which an identical retry must match byte for byte.
  const orgNumber = orgCheck.fileOrgNumber
  let originalSource:Record<string,unknown> = {format:'provided_text',path,sha256:sourceHash,orgNumber}
  let archived:SIEArchivedOriginal = {format:'provided_text',path,sha256:sourceHash,
    size:Buffer.byteLength(content,'utf8'),mime:'text/plain'}
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
    originalSource = {format:'original_bytes',path:originalPath,sha256:rawHash,bytes:originalFile.size,filename:originalFile.name,orgNumber}
    archived = {format:'original_bytes',path:originalPath,sha256:rawHash,size:bytes.byteLength,
      mime:originalFile.type || 'application/octet-stream'}
  }
  let periodId: string
  if (appendPlan?.fiscalPeriodId) {
    periodId = appendPlan.fiscalPeriodId
  } else if (options.createFiscalPeriod) {
    periodId = await ensureFiscalPeriod(supabase,companyId,parsed.stats.fiscalYearStart!,parsed.stats.fiscalYearEnd!)
  } else {
    const { data, error } = await supabase.from('fiscal_periods').select('id').eq('company_id',companyId)
      .lte('period_start',parsed.stats.fiscalYearStart!).gte('period_end',parsed.stats.fiscalYearEnd!).single()
    if (error || !data) throw new SIEJobValidationError(NO_MATCHING_FISCAL_YEAR)
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
  // commit_actor lives beside input, not in it: an identical retry by
  // another actor is still the same import.
  const commitActor = sieImportCommitActor(getActor(), source)
  const { data, error } = appendPlan ? await supabase.rpc('start_sie_append_job', {
    p_company_id: companyId, p_actor: userId, p_period_id: periodId, p_filename: options.filename,
    p_file_hash: sourceHash, p_manifest: { input, file_storage_path: path, originalSource,
      source_program: parsed.header.program ?? null, ...(commitActor ? { commit_actor: commitActor } : {}) },
    p_base_import_id: appendPlan.baseImportId,
  }) : await supabase.rpc(replacing ? 'replace_sie_import_job' : 'start_sie_import_job', {
    p_company_id: companyId, p_actor: userId, p_period_id: periodId, p_filename: options.filename,
    p_file_hash: sourceHash, p_manifest: { input, file_storage_path: path, originalSource,
      ...(commitActor ? { commit_actor: commitActor } : {}) },
    p_supersedes_import_id: replacing ? options.supersedesImportId : predecessor?.id ?? null,
  })
  if (error) throw await nameLiveCorrections(jobDatabaseError(error), supabase, companyId,
    replacing ? options.supersedesImportId : undefined, 'replace')
  const job = data as SIEJob
  // How the file came in. An identical retry gets this job back and finds
  // its arrival; nothing here can fail the submission.
  if (job?.id) {
    await recordSIEImportArrival(supabase, { companyId, importId: job.id, filename: options.filename,
      fileHash: sourceHash, fiscalYear: input.fiscalYear ?? null, original: archived,
      door: arrival ?? appSIEArrivalDoor(userId) })
  }
  return job
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
  const params = { p_company_id: companyId, p_import_id: importId, p_actor: userId }
  // An undo records who asked for it, so its stornos can name them; a resume
  // keeps the actor the undo request recorded.
  const { data, error } = action === 'undo'
    ? await rpcWithActor(supabase, 'request_sie_import_undo', params, sieUndoCommitActor(getActor()))
    : await supabase.rpc('resume_sie_import_job', params)
  if (error) throw await nameLiveCorrections(jobDatabaseError(error), supabase, companyId, importId, 'undo')
  return data as SIEJob
}

/**
 * An append refusal (sie-append.ts) as the error every door answers with:
 * the planner's sentence names the vouchers, so it is the message.
 */
export function sieAppendRefusalError(refusal: SIEAppendRefusal): SIEJobValidationError {
  return userFacing(new SIEJobValidationError(refusal.message, refusal.code, refusal.details), refusal.code)
}

/**
 * The options an append seals: it never creates a year, never books the
 * file's IB and never renames the year's accounts; it books vouchers. The
 * same input for an identical retry, whatever the door sent.
 */
export function appendJobOptions(options: SIEJobOptions, parsed: Pick<ParsedSIEFile, 'vouchers'>): SIEJobOptions {
  // A voucher without a series in the file goes to voucherSeries, as in a
  // first import, and the series map moves a series after that (crm#1751).
  // Sealed only where it changes what is booked: B is the job's own fallback,
  // and a file whose every voucher has a series uses none.
  const { supersedesImportId: _replaced, voucherSeries, openingBalanceSeries: _ibSeries, ...rest } = options
  const fallback = voucherSeries && voucherSeries !== 'B' && parsed.vouchers.some(v => !v.series?.trim())
    ? { voucherSeries } : {}
  return { ...rest, ...fallback, onExistingPeriod: 'append', createFiscalPeriod: false, importOpeningBalances: false,
    importTransactions: true, updateAccountNames: false }
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

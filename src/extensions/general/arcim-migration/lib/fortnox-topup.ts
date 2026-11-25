/**
 * The nightly top-up from Fortnox. A company that keeps booking in Fortnox
 * for a while after it moved its books to Accounted turns it on on its
 * Fortnox connection, and every night the SIE file of each year it imported
 * from Fortnox is fetched again and only the vouchers the books do not hold
 * yet are added. Off until someone turns it on; nothing goes back to Fortnox.
 *
 * Nothing here books anything itself. Each year's file goes through the
 * append every other door uses (lib/import/sie-append.ts through
 * submitSIEJob with onExistingPeriod 'append'): its plan gives every voucher
 * a verdict, the job writes the new ones with write_sie_job_entries, voucher
 * numbers continue per series, and the night's vouchers of a year are an
 * import batch of their own that is undone alone. No posted entry changes.
 *
 * Which years: appendableSIEYears with the Fortnox program, the years whose
 * import came from a Fortnox SIE file and that are neither closed nor locked.
 * A new voucher dated behind the company lock date is refused by the plan.
 *
 * Stopping. A refusal answers the same the next night: a changed voucher, an
 * #IB that differs, a new voucher behind the lock date, an unbalanced or
 * unmapped new voucher, no open year left, a connection Fortnox refuses or one
 * that is gone, a member who can no longer book. The top-up stops at once,
 * keeps why, and the connection says so until someone turns it on again.
 * Anything else (Fortnox not answering, another import of the company
 * running, a run the platform ended) is tried again the next night, and the
 * third such night in a row stops it too. What a run added before it stopped
 * stands.
 *
 * Two rows in extension_data per company, each with one writer: the setting
 * (FORTNOX_TOPUP_KEY), which only the connection's route writes, and the
 * latest run (FORTNOX_TOPUP_RUN_KEY), which only this worker writes. A run
 * that stopped outranks the setting until the setting changes again
 * (fortnoxTopupView), so the two never have to be written together.
 *
 * The run acts as the member who turned it on: the import is theirs, as if
 * they had started it, and it stops once they can no longer book.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExtensionSettings } from '@/lib/extensions/types'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { readLiveMembership } from '@/lib/company/company-access'
import { isBookkeepingWriterRole } from '@/lib/auth/invoicer-role'
import { resolveConsent } from '@/lib/providers/resolve-consent'
import { classifyProviderError, isProviderRefusal, ProviderCallError } from '@/lib/providers/with-provider-call'
import { ExecutionBudgetExceeded, withExecutionDeadline } from '@/lib/http/execution-budget'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { userFacingCode } from '@/lib/errors/user-facing'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { appendableSIEYears, type SIEAppendYear } from '@/lib/import/sie-append'
import { loadMappings } from '@/lib/import/sie-import'
import { parseSIEFile } from '@/lib/import/sie-parser'
import { suggestSIEMappings } from '@/lib/import/sie-preview-mappings'
import { isSIEJobUnresolved, type SIEJob } from '@/lib/import/sie-job-contract'
import { runSIEWorker } from '@/lib/import/sie-job-worker'
import {
  acceptsSIEJobs,
  getSIEJob,
  runsSIEJobs,
  SIEJobDatabaseError,
  SIEJobValidationError,
  submitSIEJob,
} from '@/lib/import/sie-jobs'
import { FiscalYearSelectionError, fetchProviderSieFiles, type ProviderSieFile } from './sie-fetcher'

const log = createLogger('extensions/arcim-migration/fortnox-topup')

const EXTENSION_ID = 'arcim-migration'
export const FORTNOX_TOPUP_KEY = 'fortnox_topup'
export const FORTNOX_TOPUP_RUN_KEY = 'fortnox_topup_run'
/** The #PROGRAM of a Fortnox SIE export, as the import of a year recorded it. */
export const FORTNOX_SIE_PROGRAM = 'Fortnox'

/** A company's run is due again after this, so a second delivery of the same night's cron finds nothing to do. */
const DUE_AFTER_MS = 12 * 3_600_000
/** A run claimed this long ago that never finished was ended by the platform (the cron's maxDuration is 800 s). */
const CLAIM_STALE_MS = 20 * 60_000
/** Failed nights in a row that stop the top-up. */
export const FORTNOX_TOPUP_MAX_FAILURES = 3
/** The most one company's run takes, its imports included. */
const COMPANY_BUDGET_MS = 5 * 60_000
/** Kept free of the provider calls for the imports after them. */
const IMPORT_RESERVE_MS = 60_000
/** How often a run reads an import of its own that another worker carries. */
const JOB_POLL_MS = 3_000

/** The setting on the connection. */
export interface FortnoxTopupSetting {
  enabled: boolean
  /** The Fortnox connection it fetches through. */
  consentId: string
  /** Who changed it last: while it is on, the member the run acts as. */
  changedBy: string
  changedAt: string
}

/** Why a run stopped or failed, for the connection: getErrorMessage reads it (message_en where there is one). */
export interface FortnoxTopupReason {
  code: string
  message: string
  message_en?: string
}

export type FortnoxTopupOutcome = 'running' | 'added' | 'nothing_new' | 'failed' | 'stopped'

export interface FortnoxTopupRun {
  /**
   * The changedAt of the setting the run ran under: the run belongs to that
   * choice, and to no later one (compared as a token, never as a time, so two
   * writers' clocks never have to agree).
   */
  settingChangedAt: string
  startedAt: string
  /** Null while the run goes on, or when the platform ended it. */
  finishedAt: string | null
  outcome: FortnoxTopupOutcome
  /** Vouchers added, every year together. */
  added: number
  /** Vouchers left out for looking like posted ones (same date and lines, no matching number). */
  skippedDuplicates: number
  /** Failed nights in a row, this one included. */
  failures: number
  reason: FortnoxTopupReason | null
  /** The import the run left going when it ended (outcome running). */
  importId?: string
}

export interface FortnoxTopupView {
  consentId: string
  /** On, and not stopped since it was turned on. */
  enabled: boolean
  /** The latest run since it was turned on, the one that stopped it included. */
  lastRun: FortnoxTopupRun | null
}

const OWN_REASONS = {
  actor: {
    code: 'FORTNOX_TOPUP_ACTOR_CANNOT_BOOK',
    message: 'Den som slog på hämtningen kan inte längre bokföra i företaget. Slå på hämtningen igen för att fortsätta.',
    message_en: 'The person who turned the fetch on can no longer book in the company. Turn it on again to continue.',
  },
  providerDown: {
    code: 'FORTNOX_TOPUP_PROVIDER_UNAVAILABLE',
    message: 'Fortnox svarade inte som väntat.',
    message_en: 'Fortnox did not answer as expected.',
  },
  unfinished: {
    code: 'FORTNOX_TOPUP_UNFINISHED',
    message: 'Hämtningen hann inte bli klar.',
    message_en: 'The fetch did not finish in time.',
  },
  importFailed: {
    code: 'FORTNOX_TOPUP_IMPORT_FAILED',
    message: 'Importen av de nya verifikationerna misslyckades. Den finns i importhistoriken.',
    message_en: 'The import of the new vouchers failed. It is in the import history.',
  },
  unexpected: {
    code: 'FORTNOX_TOPUP_UNEXPECTED',
    message: 'Ett oväntat fel uppstod.',
    message_en: 'An unexpected error occurred.',
  },
} satisfies Record<string, FortnoxTopupReason>

const REPEATED_SV = 'Hämtningen stoppades efter tre misslyckade nätter i rad.'
const REPEATED_EN = 'The fetch was stopped after three failed nights in a row.'

/** A reason the run found on its way: it stops the top-up. */
class TopupStop extends Error {
  constructor(readonly reason: FortnoxTopupReason) {
    super(reason.message)
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

/** The registry's sentence for a code, in both languages. */
function registryReason(code: string): FortnoxTopupReason {
  const entry = getErrorEntry(code)
  return entry ? { code, message: entry.message_sv, message_en: entry.message_en } : { ...OWN_REASONS.unexpected, code }
}

/**
 * An error's own sentence when its author wrote it for the reader (an append
 * refusal names the vouchers), else the registry's for its code. English is
 * the registry's for the code, as an English reader of the same refusal gets
 * it at every other door; the generic VALIDATION_ERROR has none worth more
 * than the Swedish sentence itself.
 */
function errorReason(code: string, error: Error): FortnoxTopupReason {
  if (!userFacingCode(error)) return registryReason(code)
  const english = code === 'VALIDATION_ERROR' ? undefined : getErrorEntry(code)?.message_en
  return { code, message: error.message, ...(english ? { message_en: english } : {}) }
}

function plainStatus(error: unknown): number | null {
  if (error instanceof Error || !error || typeof error !== 'object') return null
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

/**
 * Whether a run's error stops the top-up, and the reason the connection
 * shows. A stop is an answer that will be the same tomorrow; everything else
 * is tried again the next night.
 */
export function fortnoxTopupErrorVerdict(error: unknown): { stop: boolean; reason: FortnoxTopupReason } {
  if (error instanceof TopupStop) return { stop: true, reason: error.reason }
  // The file or the books refuse the top-up: an append refusal (a changed
  // voucher, an #IB that differs, an unbalanced or unmapped new voucher, a
  // closed period or the lock date), or a file the import does not take.
  if (error instanceof SIEJobValidationError) return { stop: true, reason: errorReason(error.code, error) }
  if (error instanceof SIEJobDatabaseError) {
    // Another import of the company still going, or a lock that was not free:
    // both free themselves. Every other database refusal is the books' state.
    const passing = error.code === 'SIE_IMPORT_UNFINISHED' || error.code === 'TRANSIENT_ERROR'
    return { stop: !passing, reason: errorReason(error.code ?? 'CONFLICT', error) }
  }
  if (error instanceof FiscalYearSelectionError) {
    const years = error.unknownYears.join(', ')
    return {
      stop: true,
      reason: {
        code: 'FORTNOX_TOPUP_SOURCE_YEAR_MISSING',
        message: `Räkenskapsår ${years} finns inte längre i Fortnox.`,
        message_en: `Fiscal year ${years} no longer exists in Fortnox.`,
      },
    }
  }
  // resolveConsent's own answers: the connection is gone or unfinished, or
  // holds no token.
  const status = plainStatus(error)
  if (status === 401) return { stop: true, reason: registryReason('PROVIDER_AUTH_EXPIRED') }
  if (status !== null && status >= 400 && status < 500) return { stop: true, reason: registryReason('PROVIDER_CONSENT_NOT_FOUND') }
  // A dead token, a closed register, a missing licence: Fortnox refused.
  const providerCode = classifyProviderError(error)
  if (providerCode && isProviderRefusal(error)) return { stop: true, reason: registryReason(providerCode) }
  if (error instanceof ExecutionBudgetExceeded) return { stop: false, reason: OWN_REASONS.unfinished }
  if (providerCode) return { stop: false, reason: OWN_REASONS.providerDown }
  return { stop: false, reason: OWN_REASONS.unexpected }
}

function parseSetting(value: unknown): FortnoxTopupSetting | null {
  const v = value as Partial<FortnoxTopupSetting> | null
  if (!v || typeof v !== 'object' || typeof v.enabled !== 'boolean' || typeof v.consentId !== 'string' ||
    typeof v.changedBy !== 'string' || typeof v.changedAt !== 'string') return null
  return { enabled: v.enabled, consentId: v.consentId, changedBy: v.changedBy, changedAt: v.changedAt }
}

const OUTCOMES: ReadonlySet<string> = new Set<FortnoxTopupOutcome>(['running', 'added', 'nothing_new', 'failed', 'stopped'])

function parseRun(value: unknown): FortnoxTopupRun | null {
  const v = value as Partial<FortnoxTopupRun> | null
  if (!v || typeof v !== 'object' || typeof v.settingChangedAt !== 'string' || typeof v.startedAt !== 'string' ||
    typeof v.outcome !== 'string' || !OUTCOMES.has(v.outcome)) return null
  const count = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0
  const reason = v.reason && typeof v.reason.code === 'string' && typeof v.reason.message === 'string' ? v.reason : null
  return {
    settingChangedAt: v.settingChangedAt,
    startedAt: v.startedAt,
    finishedAt: typeof v.finishedAt === 'string' ? v.finishedAt : null,
    outcome: v.outcome,
    added: count(v.added),
    skippedDuplicates: count(v.skippedDuplicates),
    failures: count(v.failures),
    reason,
    ...(typeof v.importId === 'string' ? { importId: v.importId } : {}),
  }
}

/**
 * What the connection shows, and the one reading of whether the top-up is on:
 * the setting is on and no run has stopped it since it was turned on. A run
 * under an earlier version of the setting belongs to an earlier choice.
 */
export function fortnoxTopupView(setting: FortnoxTopupSetting | null, run: FortnoxTopupRun | null): FortnoxTopupView | null {
  if (!setting) return null
  const lastRun = setting.enabled && run && run.settingChangedAt === setting.changedAt ? run : null
  return { consentId: setting.consentId, enabled: setting.enabled && lastRun?.outcome !== 'stopped', lastRun }
}

/** What the vouchers of a completed append job came to. */
function appendCounts(job: SIEJob): { added: number; skippedDuplicates: number } {
  const result = (job.job_result ?? {}) as { journalEntriesCreated?: unknown; details?: { append?: { added?: unknown; possibleDuplicatesSkipped?: unknown } } }
  const append = result.details?.append
  const number = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0
  return { added: number(append?.added ?? result.journalEntriesCreated), skippedDuplicates: number(append?.possibleDuplicatesSkipped) }
}

/** A run that left an import going, once that import has ended. */
function settledRun(run: FortnoxTopupRun, job: SIEJob): FortnoxTopupRun {
  if (job.job_state === 'failed') return { ...run, outcome: 'failed', reason: OWN_REASONS.importFailed }
  const counts = appendCounts(job)
  const added = run.added + counts.added
  return { ...run, outcome: added > 0 ? 'added' : 'nothing_new', added,
    skippedDuplicates: run.skippedDuplicates + counts.skippedDuplicates }
}

/**
 * The connection's top-up for the status route, or null when it was never
 * turned on. A run that ended with its import still going reads that import:
 * it has most often finished since.
 */
export async function readFortnoxTopup(
  settings: ExtensionSettings,
  supabase: SupabaseClient,
  companyId: string,
): Promise<FortnoxTopupView | null> {
  const view = fortnoxTopupView(
    parseSetting(await settings.get(FORTNOX_TOPUP_KEY)),
    parseRun(await settings.get(FORTNOX_TOPUP_RUN_KEY)),
  )
  const run = view?.lastRun
  if (view && run?.outcome === 'running' && run.finishedAt && run.importId) {
    const job = await getSIEJob(supabase, companyId, run.importId)
    if (job && !isSIEJobUnresolved(job.job_state)) view.lastRun = settledRun(run, job)
  }
  return view
}

/** The failed nights in a row before this one: a run the platform ended counts as one. */
function priorFailures(setting: FortnoxTopupSetting, previous: FortnoxTopupRun | null): number {
  if (!previous || previous.settingChangedAt !== setting.changedAt) return 0
  if (previous.outcome === 'failed') return previous.failures
  if (previous.outcome === 'running' && previous.finishedAt === null) return previous.failures + 1
  return 0
}

function isDue(run: FortnoxTopupRun | null, now: number): boolean {
  if (!run) return true
  const age = now - Date.parse(run.startedAt)
  return run.finishedAt === null ? age >= CLAIM_STALE_MS : age >= DUE_AFTER_MS
}

/** The Fortnox year a year's import came from, as the fetcher selects years: by the year its first day is in. */
function sourceSelectionYear(year: SIEAppendYear): number {
  return Number((year.sourceYear?.start ?? year.start).slice(0, 4))
}

/**
 * The export of every selected Fortnox year. A year Fortnox could not serve
 * is the night's error. Fortnox ends an access token a moment before the
 * expiry stamped on it, so a refusal of the token asks once for a new one and
 * tries again, as the register import does.
 */
async function fetchFortnoxYears(companyId: string, consentId: string, years: number[]): Promise<ProviderSieFile[]> {
  const attempt = async (accessToken: string, providerCompanyId: string | undefined) => {
    const fetched = await fetchProviderSieFiles('fortnox', accessToken, providerCompanyId, { years })
    const failure = fetched.failedYears[0]
    if (failure) {
      throw failure.code === 'PROVIDER_SIE_FETCH_FAILED'
        ? new Error(`Fortnox SIE export failed for ${failure.year}: ${failure.error}`)
        : new ProviderCallError(failure.code, 'fortnox', `Fortnox SIE export failed for ${failure.year}: ${failure.error}`)
    }
    return fetched.files
  }
  const connection = await resolveConsent(companyId, consentId)
  if (connection.consent.provider !== 'fortnox') throw new TopupStop(registryReason('PROVIDER_CONSENT_NOT_FOUND'))
  try {
    return await attempt(connection.accessToken, connection.providerCompanyId)
  } catch (error) {
    if (classifyProviderError(error) !== 'PROVIDER_AUTH_EXPIRED') throw error
    const replacement = await resolveConsent(companyId, consentId, { rejectedAccessToken: connection.accessToken })
    if (replacement.accessToken === connection.accessToken) throw error
    log.info('fortnox top-up token replaced after a refusal', { companyId })
    return attempt(replacement.accessToken, replacement.providerCompanyId)
  }
}

/** The fetched file that holds a year's vouchers: the one whose #RAR lies within it. */
function fileForYear(year: SIEAppendYear, files: { parsed: ReturnType<typeof parseSIEFile>; raw: string }[]) {
  const file = files.find(({ parsed }) => {
    const start = parsed.stats.fiscalYearStart
    const end = parsed.stats.fiscalYearEnd
    return !!start && !!end && start >= year.start && end <= year.end
  })
  if (!file) {
    throw new TopupStop({
      code: 'FORTNOX_TOPUP_SOURCE_YEAR_MISSING',
      message: `Fortnox har inget räkenskapsår som motsvarar räkenskapsåret ${year.name}.`,
      message_en: `Fortnox has no fiscal year matching the fiscal year ${year.name}.`,
    })
  }
  if (file.parsed.header.program !== FORTNOX_SIE_PROGRAM) {
    // The plan matches source numbers within one program: under another
    // name every voucher of the year would read as new.
    throw new TopupStop({
      code: 'FORTNOX_TOPUP_PROGRAM_CHANGED',
      message: `SIE-filen för ${year.name} anger programmet ${file.parsed.header.program ?? 'inget'}, inte Fortnox som importen av året. Verifikationerna kan inte jämföras säkert.`,
      message_en: `The SIE file for ${year.name} names the program ${file.parsed.header.program ?? 'none'}, not Fortnox as the import of the year did. Its vouchers cannot be compared safely.`,
    })
  }
  return file
}

interface Worker {
  supabase: SupabaseClient
  deadline: number
  hardDeadline: number
  now: () => number
  sleep: (ms: number) => Promise<void>
}

/** Run an import the top-up started, here or by waiting for the worker that holds it, until it ends or the run's time does. */
async function settleImport(worker: Worker, companyId: string, importId: string, until: number): Promise<SIEJob | null> {
  const { supabase, now, sleep } = worker
  await runSIEWorker({ importId, supabase, budgetMs: Math.max(0, until - now()) }).catch((error: unknown) => {
    // The SIE worker cron carries the job on; the reads below see where it got.
    log.warn('fortnox top-up import not run here', { companyId, importId, reason: error instanceof Error ? error.message : String(error) })
  })
  for (;;) {
    const job = await getSIEJob(supabase, companyId, importId)
    if (!job || !isSIEJobUnresolved(job.job_state) || now() + JOB_POLL_MS >= until) return job
    await sleep(JOB_POLL_MS)
  }
}

interface Candidate {
  companyId: string
  setting: FortnoxTopupSetting
  run: FortnoxTopupRun | null
  runRow: { id: string; updated_at: string } | null
}

/** One company's night. Never throws: every way out is a run to record. */
async function topUpCompany(worker: Worker, candidate: Candidate, startedAt: string, failuresBefore: number): Promise<FortnoxTopupRun> {
  const { supabase, now } = worker
  const { companyId, setting } = candidate
  const until = Math.min(worker.hardDeadline, now() + COMPANY_BUDGET_MS)
  let added = 0
  let skippedDuplicates = 0
  const end = (outcome: FortnoxTopupOutcome, reason: FortnoxTopupReason | null, extra: Partial<FortnoxTopupRun> = {}): FortnoxTopupRun =>
    ({ settingChangedAt: setting.changedAt, startedAt, finishedAt: iso(now()), outcome, added, skippedDuplicates, failures: 0,
      reason, ...extra })
  // Tried again the next night, until the third failed night in a row.
  const fail = (reason: FortnoxTopupReason): FortnoxTopupRun => {
    const failures = failuresBefore + 1
    return failures < FORTNOX_TOPUP_MAX_FAILURES ? end('failed', reason, { failures }) : end('stopped', repeated(reason), { failures })
  }
  try {
    const member = await readLiveMembership(supabase, setting.changedBy, companyId)
    if (!member || !isBookkeepingWriterRole(member.role)) throw new TopupStop(OWN_REASONS.actor)
    const years = await appendableSIEYears(supabase, companyId, FORTNOX_SIE_PROGRAM)
    if (!years.length) throw new TopupStop(registryReason('PROVIDER_TOPUP_NO_OPEN_YEAR'))
    const selection = [...new Set(years.map(sourceSelectionYear))].sort((a, b) => a - b)
    // The provider calls get the run's time less the imports' share, as a
    // deadline on the clock the execution budget keeps.
    const fetched = await withExecutionDeadline(Date.now() + (until - now()) - IMPORT_RESERVE_MS, 'fortnox-topup',
      () => fetchFortnoxYears(companyId, setting.consentId, selection))
    const files = fetched.map((file) => ({ raw: file.rawContent, parsed: parseSIEFile(file.rawContent) }))
    const stored = await loadMappings(supabase, companyId)
    for (const year of years) {
      const file = fileForYear(year, files)
      let job: SIEJob
      try {
        job = await submitSIEJob(supabase, companyId, setting.changedBy, file.raw,
          suggestSIEMappings(file.parsed, BAS_REFERENCE, stored).mappings,
          { filename: `fortnox-${todayIsoStockholm(new Date(now()))}.se`, createFiscalPeriod: false,
            importOpeningBalances: false, importTransactions: true, onExistingPeriod: 'append' },
          undefined, 'provider_migration',
          { source: 'migration', via: 'provider_migration', fetchedBy: { type: 'cron', user_id: setting.changedBy, label: 'fortnox-topup' } })
      } catch (error) {
        if (!(error instanceof SIEJobValidationError) || error.code !== 'SIE_IMPORT_APPEND_NOTHING_NEW') throw error
        // Every voucher of the year is booked already: nothing to add tonight.
        skippedDuplicates += Number(error.details?.possible_duplicates ?? 0) || 0
        continue
      }
      const settled = await settleImport(worker, companyId, job.id, until)
      if (!settled || isSIEJobUnresolved(settled.job_state)) return end('running', null, { importId: job.id })
      if (settled.job_state === 'failed') {
        log.warn('fortnox top-up import failed', { companyId, importId: job.id, reason: settled.error_message })
        return fail(OWN_REASONS.importFailed)
      }
      const counts = appendCounts(settled)
      added += counts.added
      skippedDuplicates += counts.skippedDuplicates
    }
    return end(added > 0 ? 'added' : 'nothing_new', null)
  } catch (error) {
    const verdict = fortnoxTopupErrorVerdict(error)
    // A refusal or Fortnox's own state is the company's, recorded on the
    // connection; only an error nobody expected is ours to look at.
    if (verdict.reason.code === OWN_REASONS.unexpected.code) log.error('fortnox top-up failed', error as Error, { companyId })
    return verdict.stop ? end('stopped', verdict.reason) : fail(verdict.reason)
  }
}

/** The reason of the third failed night in a row, which stops the top-up. */
function repeated(reason: FortnoxTopupReason): FortnoxTopupReason {
  return {
    code: reason.code,
    message: `${reason.message} ${REPEATED_SV}`,
    ...(reason.message_en ? { message_en: `${reason.message_en} ${REPEATED_EN}` } : {}),
  }
}

/**
 * Take a company's run: compare-and-set on the run row's updated_at, which
 * every write moves, so a second delivery of the cron that read the same row
 * gets nothing. The first run of a company inserts the row; a unique
 * violation means another delivery did.
 */
async function claimRun(supabase: SupabaseClient, candidate: Candidate, claim: FortnoxTopupRun): Promise<string | null> {
  if (candidate.runRow) {
    const { data, error } = await supabase.from('extension_data').update({ value: claim })
      .eq('id', candidate.runRow.id).eq('updated_at', candidate.runRow.updated_at).select('id')
    if (error) throw new Error(`fortnox top-up claim failed: ${error.message}`)
    return ((data ?? []) as { id: string }[])[0]?.id ?? null
  }
  const { data, error } = await supabase.from('extension_data')
    .insert({ company_id: candidate.companyId, user_id: candidate.setting.changedBy, extension_id: EXTENSION_ID,
      key: FORTNOX_TOPUP_RUN_KEY, value: claim })
    .select('id').single()
  if (error) {
    if ((error as { code?: string }).code === '23505') return null
    throw new Error(`fortnox top-up claim failed: ${error.message}`)
  }
  return (data as { id: string }).id
}

export interface FortnoxTopupSweepResult {
  /** Companies whose top-up is on and whose run was due. */
  due: number
  ran: number
  added: number
  nothingNew: number
  failed: number
  stopped: number
  running: number
  /** SIE imports are paused on this installation: nothing ran and nothing was recorded. */
  paused?: true
}

export interface FortnoxTopupSweepOptions {
  /** The service-role client. */
  supabase: SupabaseClient
  /** No company is started after this. */
  deadline: number
  /** Bounds the company in progress. */
  hardDeadline: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

interface ExtensionRow {
  id: string
  company_id: string
  key: string
  value: unknown
  updated_at: string
}

/** Every company whose top-up is on and due, the longest waiting first, until the deadline. */
export async function runFortnoxTopups(options: FortnoxTopupSweepOptions): Promise<FortnoxTopupSweepResult> {
  const worker: Worker = {
    supabase: options.supabase,
    deadline: options.deadline,
    hardDeadline: options.hardDeadline,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  }
  const { supabase, now } = worker
  const result: FortnoxTopupSweepResult = { due: 0, ran: 0, added: 0, nothingNew: 0, failed: 0, stopped: 0, running: 0 }
  // A pause of the installation's SIE imports is not the company's failure.
  if (!acceptsSIEJobs() || !runsSIEJobs()) return { ...result, paused: true }

  const rows = await fetchAllRows<ExtensionRow>(({ from, to }) => supabase.from('extension_data')
    .select('id,company_id,key,value,updated_at').eq('extension_id', EXTENSION_ID)
    .in('key', [FORTNOX_TOPUP_KEY, FORTNOX_TOPUP_RUN_KEY]).order('id').range(from, to))
  const runRows = new Map(rows.filter((row) => row.key === FORTNOX_TOPUP_RUN_KEY).map((row) => [row.company_id, row]))
  const candidates: Candidate[] = []
  for (const row of rows) {
    if (row.key !== FORTNOX_TOPUP_KEY) continue
    const setting = parseSetting(row.value)
    const runRow = runRows.get(row.company_id) ?? null
    const run = runRow ? parseRun(runRow.value) : null
    if (!setting || !fortnoxTopupView(setting, run)?.enabled || !isDue(run, now())) continue
    candidates.push({ companyId: row.company_id, setting, run,
      runRow: runRow ? { id: runRow.id, updated_at: runRow.updated_at } : null })
  }
  candidates.sort((a, b) => (a.run?.startedAt ?? '').localeCompare(b.run?.startedAt ?? ''))
  result.due = candidates.length

  for (const candidate of candidates) {
    if (now() >= worker.deadline) break
    try {
      const startedAt = iso(now())
      const settingChangedAt = candidate.setting.changedAt
      const failuresBefore = priorFailures(candidate.setting, candidate.run)
      const claimedId = await claimRun(supabase, candidate, { settingChangedAt, startedAt, finishedAt: null, outcome: 'running',
        added: 0, skippedDuplicates: 0, failures: failuresBefore, reason: null })
      if (!claimedId) continue
      result.ran++
      const run: FortnoxTopupRun = failuresBefore >= FORTNOX_TOPUP_MAX_FAILURES
        // The platform ended the last runs before they finished.
        ? { settingChangedAt, startedAt, finishedAt: iso(now()), outcome: 'stopped', added: 0, skippedDuplicates: 0,
            failures: failuresBefore, reason: repeated(OWN_REASONS.unfinished) }
        : await topUpCompany(worker, candidate, startedAt, failuresBefore)
      const { error } = await supabase.from('extension_data').update({ value: run }).eq('id', claimedId)
      if (error) throw new Error(`fortnox top-up result not saved: ${error.message}`)
      if (run.outcome === 'added') result.added++
      else if (run.outcome === 'nothing_new') result.nothingNew++
      else if (run.outcome === 'failed') result.failed++
      else if (run.outcome === 'stopped') result.stopped++
      else result.running++
      log.info('fortnox top-up run finished', { companyId: candidate.companyId, outcome: run.outcome, added: run.added,
        ...(run.reason ? { reason: run.reason.code } : {}) })
    } catch (error) {
      // A claim or a result the database refused: this company waits for the
      // next run, the others still get theirs.
      log.error('fortnox top-up run could not be recorded', error as Error, { companyId: candidate.companyId })
    }
  }
  return result
}

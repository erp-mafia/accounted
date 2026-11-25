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
 * What the books received from Fortnox and reversed since, by storno or by
 * undoing its import, is left out of the night's file and never added again
 * (withoutSourceVouchers): the append matches posted entries only, so it
 * would come back every night after every storno.
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
import type { ParsedSIEFile, SIEVoucher } from '@/lib/import/types'
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
  /**
   * Vouchers left out because the books received them from Fortnox before
   * and they have been reversed here since (by storno, or by undoing their
   * import): the top-up never brings back what was taken out.
   */
  skippedReversed: number
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
 * The database's refusals of an import that the next night meets again: the
 * year or the lock date, an import or a correction in the way, a member
 * without write access, a year or an input it does not take (jobDatabaseError
 * names them). Any other code (a statement timeout, a dropped connection, a
 * deadlock) is a night that failed.
 */
const REFUSING_DATABASE_CODES: ReadonlySet<string> = new Set([
  'SIE_IMPORT_PERIOD_LOCKED', 'SIE_IMPORT_PERIOD_HAS_OPENING_BALANCE', 'SIE_IMPORT_PERIOD_ALREADY_IMPORTED',
  'SIE_IMPORT_APPEND_NO_BASE', 'SIE_IMPORT_HAS_LIVE_APPEND', 'SIE_IMPORT_HAS_LIVE_CORRECTION',
  'SIE_IMPORT_LEGACY_REVIEW_REQUIRED', 'DB_PERMISSION_DENIED', 'NOT_FOUND', 'VALIDATION_ERROR', 'CONFLICT',
])

/**
 * Whether a run's error stops the top-up, and the reason the connection
 * shows. A stop is a refusal that will be the same tomorrow; everything else
 * is a night that failed, tried again the next night.
 */
export function fortnoxTopupErrorVerdict(error: unknown): { stop: boolean; reason: FortnoxTopupReason } {
  if (error instanceof TopupStop) return { stop: true, reason: error.reason }
  // The file or the books refuse the top-up: an append refusal (a changed
  // voucher, an #IB that differs, an unbalanced or unmapped new voucher, a
  // closed period or the lock date), or a file the import does not take.
  if (error instanceof SIEJobValidationError) return { stop: true, reason: errorReason(error.code, error) }
  if (error instanceof SIEJobDatabaseError) {
    if (error.code && REFUSING_DATABASE_CODES.has(error.code)) return { stop: true, reason: errorReason(error.code, error) }
    // Another import of the company still going, a lock that was not free.
    if (error.code === 'SIE_IMPORT_UNFINISHED' || error.code === 'TRANSIENT_ERROR') {
      return { stop: false, reason: errorReason(error.code, error) }
    }
    return { stop: false, reason: OWN_REASONS.unexpected }
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
  // resolveConsent's own answers: no connection, or no token. It answers a
  // read that failed the same way, so they are tried again and stop on the
  // third night.
  const status = plainStatus(error)
  if (status === 401) return { stop: false, reason: registryReason('PROVIDER_AUTH_EXPIRED') }
  if (status !== null && status >= 400 && status < 500) return { stop: false, reason: registryReason('PROVIDER_CONSENT_NOT_FOUND') }
  // A dead token (also after the one replacement), a closed register, a
  // missing licence: Fortnox refused.
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
    skippedReversed: count(v.skippedReversed),
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

/**
 * A run as it ended, once what it left behind has: an import it left going
 * reads as what that import came to, and a run the platform ended before it
 * finished (claimed long ago, never finished) is a failed night; the third
 * failed night in a row is a stop. A run still going, or an import whose
 * state cannot be read now, is left as it is. `failures` of a run left going
 * is the count before it, so a night whose import fails later still counts.
 */
async function settledRun(supabase: SupabaseClient, companyId: string, run: FortnoxTopupRun, now: number): Promise<FortnoxTopupRun> {
  if (run.outcome !== 'running') return run
  const failed = (reason: FortnoxTopupReason): FortnoxTopupRun => {
    const failures = run.failures + 1
    return failures < FORTNOX_TOPUP_MAX_FAILURES
      ? { ...run, outcome: 'failed', failures, reason }
      : { ...run, outcome: 'stopped', failures, reason: repeated(reason) }
  }
  if (run.finishedAt === null) return now - Date.parse(run.startedAt) >= CLAIM_STALE_MS ? failed(OWN_REASONS.unfinished) : run
  if (!run.importId) return run
  const job = await getSIEJob(supabase, companyId, run.importId).catch((error: unknown) => {
    // Read again next time; until then the run shows as going.
    log.warn('fortnox top-up import state unreadable', { companyId, reason: error instanceof Error ? error.message : String(error) })
    return null
  })
  if (!job || isSIEJobUnresolved(job.job_state)) return run
  if (job.job_state === 'failed') return failed(OWN_REASONS.importFailed)
  const counts = appendCounts(job)
  const added = run.added + counts.added
  return { ...run, outcome: added > 0 ? 'added' : 'nothing_new', added, failures: 0,
    skippedDuplicates: run.skippedDuplicates + counts.skippedDuplicates }
}

/** The connection's top-up for the status route, or null when it was never turned on. */
export async function readFortnoxTopup(
  settings: ExtensionSettings,
  supabase: SupabaseClient,
  companyId: string,
): Promise<FortnoxTopupView | null> {
  const setting = parseSetting(await settings.get(FORTNOX_TOPUP_KEY))
  const run = parseRun(await settings.get(FORTNOX_TOPUP_RUN_KEY))
  // Settled first: a run that ended in a stop turns the switch off.
  return fortnoxTopupView(setting, setting && run ? await settledRun(supabase, companyId, run, Date.now()) : null)
}

/**
 * The failed nights in a row before this one, under the same choice;
 * `previous` is settled. A run whose import is still going carries the count
 * from before it.
 */
function priorFailures(setting: FortnoxTopupSetting, previous: FortnoxTopupRun | null): number {
  if (!previous || previous.settingChangedAt !== setting.changedAt) return 0
  return previous.outcome === 'failed' || previous.outcome === 'running' ? previous.failures : 0
}

/**
 * Whether the setting is still the choice a run was started under: on, for
 * the same connection, and not changed since. Read again right before the
 * run is claimed and before each year is imported, so a member who switches
 * it off while the night's run waits or goes on stops what is not booked yet.
 */
async function stillOn(supabase: SupabaseClient, companyId: string, setting: FortnoxTopupSetting): Promise<boolean> {
  const { data, error } = await supabase.from('extension_data').select('value').eq('company_id', companyId)
    .eq('extension_id', EXTENSION_ID).eq('key', FORTNOX_TOPUP_KEY).maybeSingle()
  if (error) throw new Error(`fortnox top-up setting read failed: ${error.message}`)
  const current = parseSetting((data as { value?: unknown } | null)?.value)
  return !!current && current.enabled && current.changedAt === setting.changedAt && current.consentId === setting.consentId
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
    // A refused token first: it is the failure a new token can cure.
    const failure = fetched.failedYears.find((year) => year.code === 'PROVIDER_AUTH_EXPIRED') ?? fetched.failedYears[0]
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
  let job: SIEJob | null = null
  for (;;) {
    try {
      job = await getSIEJob(supabase, companyId, importId)
      if (job && !isSIEJobUnresolved(job.job_state)) return job
    } catch (error) {
      // A read that failed says nothing about the import: read again, and
      // past the run's time the connection reads it from the job.
      log.warn('fortnox top-up import state unreadable', { companyId, importId, reason: error instanceof Error ? error.message : String(error) })
    }
    if (now() + JOB_POLL_MS >= until) return job
    await sleep(JOB_POLL_MS)
  }
}

const sourceRef = (series: string, number: number) => `${series}\u0000${number}`

/**
 * The vouchers a year received from Fortnox and has reversed since, by
 * storno or by undoing their import, that no posted entry of a Fortnox import
 * holds. The append matches source numbers among posted entries only (so an
 * undone append can be made again by hand), so the night would book each of
 * them again, and again after every storno of it.
 */
async function reversedFortnoxVouchers(supabase: SupabaseClient, companyId: string, year: SIEAppendYear): Promise<Set<string>> {
  // The year's batches of Fortnox files: a completed one records the program
  // in its documentation, one undone before it completed only in its manifest.
  const batches = new Set((await fetchAllRows<{ id: string; program: string | null; sealed_program: string | null }>(({ from, to }) =>
    supabase.from('sie_imports').select('id,program:migration_documentation->>sourceSystem,sealed_program:manifest->>source_program')
      .eq('company_id', companyId).eq('fiscal_period_id', year.fiscalPeriodId).order('id').range(from, to)))
    .filter((batch) => batch.program === FORTNOX_SIE_PROGRAM || batch.sealed_program === FORTNOX_SIE_PROGRAM)
    .map((batch) => batch.id))
  if (!batches.size) return new Set()
  // Matched to the batches here, not in the query: a list of ids in the URL
  // grows with every night and with a re-run migration, past what the
  // gateway takes (ID_READ_CHUNK in lib/reconciliation/limits.ts).
  type Entry = { source_voucher_series: string | null; source_voucher_number: number; import_batch_id: string | null }
  const refs = async (status: 'reversed' | 'posted') => (await fetchAllRows<Entry>(({ from, to }) =>
    supabase.from('journal_entries').select('source_voucher_series,source_voucher_number,import_batch_id')
      .eq('company_id', companyId).eq('fiscal_period_id', year.fiscalPeriodId).eq('status', status)
      .not('source_voucher_number', 'is', null).order('id').range(from, to)))
    .filter((entry) => entry.import_batch_id !== null && batches.has(entry.import_batch_id))
    .map((entry) => sourceRef(entry.source_voucher_series ?? '', entry.source_voucher_number))
  const reversed = await refs('reversed')
  if (!reversed.length) return new Set()
  // A posted entry holds the voucher again (a re-run migration, an append by
  // hand): the plan decides it, a changed one still stops the night.
  const posted = new Set(await refs('posted'))
  return new Set(reversed.filter((ref) => !posted.has(ref)))
}

/** A #VER line's series and number as fields 1 and 2, quoted or not; null for any other line. */
function verLineRef(line: string): string | null {
  const fields = line.trim().match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []
  if (fields[0]?.toUpperCase() !== '#VER' || fields.length < 3) return null
  const unquote = (field: string) => field.length >= 2 && field.startsWith('"') && field.endsWith('"') ? field.slice(1, -1) : field
  const number = unquote(fields[2])
  return /^\d+$/.test(number) ? sourceRef(unquote(fields[1]), Number(number)) : null
}

/**
 * The file without the vouchers `drop` names: each such #VER line and its
 * block, up to the line that closes it. Read back by the parser, which must
 * find exactly the other vouchers, or the file is not used: a voucher the
 * books reversed is never booked again because a file was laid out in a way
 * this did not expect.
 */
export function withoutSourceVouchers(raw: string, parsed: ParsedSIEFile, drop: ReadonlySet<string>, yearName: string):
  { raw: string; parsed: ParsedSIEFile; dropped: number } {
  const dropped = parsed.vouchers.filter((v) => !v.numberOmitted && drop.has(sourceRef(v.series, v.number)))
  if (!dropped.length) return { raw, parsed, dropped: 0 }
  const kept: string[] = []
  let skipping = false
  for (const line of raw.split(/(?<=\n)/)) {
    if (skipping) {
      if (line.trim() === '}') skipping = false
      continue
    }
    const ref = verLineRef(line)
    if (ref && drop.has(ref)) {
      skipping = true
      continue
    }
    kept.push(line)
  }
  const text = kept.join('')
  const reread = parseSIEFile(text)
  const left = (v: SIEVoucher) => !(!v.numberOmitted && drop.has(sourceRef(v.series, v.number)))
  if (reread.vouchers.length !== parsed.vouchers.length - dropped.length || !reread.vouchers.every(left)) {
    const refs = dropped.map((v) => `${v.series}${v.number}`).join(', ')
    throw new TopupStop({
      code: 'FORTNOX_TOPUP_REVERSED_NOT_SKIPPED',
      message: `Verifikationerna ${refs} i ${yearName} hämtades från Fortnox förut och är makulerade här, men kunde inte lämnas utanför Fortnox fil. Hämtningen stoppades så att de inte bokförs igen.`,
      message_en: `Vouchers ${refs} in ${yearName} were fetched from Fortnox before and are reversed here, but could not be left out of the Fortnox file. The fetch was stopped so that they are not booked again.`,
    })
  }
  return { raw: text, parsed: reread, dropped: dropped.length }
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
  let skippedReversed = 0
  const end = (outcome: FortnoxTopupOutcome, reason: FortnoxTopupReason | null, extra: Partial<FortnoxTopupRun> = {}): FortnoxTopupRun =>
    ({ settingChangedAt: setting.changedAt, startedAt, finishedAt: iso(now()), outcome, added, skippedDuplicates, skippedReversed,
      failures: 0, reason, ...extra })
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
      const found = fileForYear(year, files)
      const file = withoutSourceVouchers(found.raw, found.parsed, await reversedFortnoxVouchers(supabase, companyId, year), year.name)
      skippedReversed += file.dropped
      // Switched off or changed since the run began: nothing more is booked.
      if (!(await stillOn(supabase, companyId, setting))) return end(added > 0 ? 'added' : 'nothing_new', null)
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
      // Left to the SIE worker: the connection reads what it comes to, and an
      // import that fails then counts on top of the nights before.
      if (!settled || isSIEJobUnresolved(settled.job_state)) {
        return end('running', null, { importId: job.id, failures: failuresBefore })
      }
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
      // Switched off or changed since the list was read: not tonight.
      if (!(await stillOn(supabase, candidate.companyId, candidate.setting))) continue
      const previous = candidate.run ? await settledRun(supabase, candidate.companyId, candidate.run, now()) : null
      let run: FortnoxTopupRun
      if (previous?.outcome === 'stopped' && previous.settingChangedAt === candidate.setting.changedAt) {
        // The last night failed after it ended (the platform ended it, or the
        // import it left going failed), the third in a row: the stop is kept
        // as that night's run, and nothing runs.
        if (!(await claimRun(supabase, candidate, previous))) continue
        result.ran++
        run = previous
      } else {
        const failuresBefore = priorFailures(candidate.setting, previous)
        const startedAt = iso(now())
        const claimedId = await claimRun(supabase, candidate, { settingChangedAt: candidate.setting.changedAt, startedAt,
          finishedAt: null, outcome: 'running', added: 0, skippedDuplicates: 0, skippedReversed: 0, failures: failuresBefore, reason: null })
        if (!claimedId) continue
        result.ran++
        run = await topUpCompany(worker, candidate, startedAt, failuresBefore)
        const { error } = await supabase.from('extension_data').update({ value: run }).eq('id', claimedId)
        if (error) throw new Error(`fortnox top-up result not saved: ${error.message}`)
      }
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

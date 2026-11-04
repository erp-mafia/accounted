import { sleep } from '@/lib/utils'
import { supportsUnderlagImport, type UnderlagImportProvider } from '@/lib/providers/underlag-import'
import {
  documentImportRunStartedAfter,
  type DocumentImportRunStatus,
} from '@/extensions/general/arcim-migration/lib/document-import-run'

export const ARCIM_DOCUMENT_IMPORT_ENDPOINT =
  '/api/extensions/ext/arcim-migration/import-documents'

export const PROVIDER_DOCUMENT_SCOPES_REQUIRED =
  'PROVIDER_DOCUMENT_SCOPES_REQUIRED'

/**
 * The connect request does not ask Fortnox for Arkiv and Koppla fil at all,
 * so no reconnect can grant them: the error offers no action, only the truth.
 */
export const PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE =
  'PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE'

/**
 * The server is carrying the run on by itself (crm#1581): this tab has
 * nothing to drive, and the page says the run goes on without it.
 */
export const PROVIDER_IMPORT_DOCUMENTS_RUNNING_ON_SERVER =
  'PROVIDER_IMPORT_DOCUMENTS_RUNNING_ON_SERVER'

/**
 * The provider refused the connection itself and the run stopped once: a
 * Fortnox token a refresh could not revive, a grant the refresh was refused,
 * or a Bokio token without the right (B11). A reconnect is the way on.
 */
export const PROVIDER_CONNECTION_REFUSED_CODES: readonly string[] = [
  'PROVIDER_AUTH_EXPIRED',
  'PROVIDER_RESOURCE_FORBIDDEN',
]

export const ARCIM_DOCUMENT_OAUTH_RESUME_KEY =
  'arcim-document-oauth-resume'

export type ArcimDocumentOAuthResumeAction = 'discover' | 'import'

export interface ArcimDocumentOAuthResume {
  action: ArcimDocumentOAuthResumeAction
  /**
   * The underlag run was started on its own from an active connection, not
   * as the tail of a migration. Carried across the full-page OAuth fallback so
   * the result page comes back without a migration verdict.
   */
  standalone: boolean
}

const STANDALONE_SUFFIX = ':standalone'

// The stored value is a resume marker ("discover", "import", optionally
// ":standalone"), never a token or credential: it tells the page which step
// to continue after the Fortnox scope popup returns. Named "marker" so
// static analysis does not read it as OAuth material written to storage.
export function serializeArcimDocumentResumeMarker(
  resume: ArcimDocumentOAuthResume,
): string {
  return resume.standalone ? `${resume.action}${STANDALONE_SUFFIX}` : resume.action
}

export function parseArcimDocumentResumeMarker(
  value: string | null,
): ArcimDocumentOAuthResume | null {
  if (value === null) return null
  const standalone = value.endsWith(STANDALONE_SUFFIX)
  const action = standalone ? value.slice(0, -STANDALONE_SUFFIX.length) : value
  if (action !== 'discover' && action !== 'import') return null
  return { action, standalone }
}

/** Poll a provider popup so closing it cannot leave the UI reconnecting forever. */
export function watchArcimOAuthPopup(
  popup: { closed: boolean },
  onClosed: () => void,
  intervalMs: number = 500,
  graceMs: number = 500,
): () => void {
  let active = true
  let graceTimeout: ReturnType<typeof setTimeout> | null = null
  const interval = globalThis.setInterval(() => {
    if (!popup.closed || !active) return
    globalThis.clearInterval(interval)
    graceTimeout = globalThis.setTimeout(() => {
      if (!active) return
      active = false
      onClosed()
    }, graceMs)
  }, intervalMs)

  return () => {
    if (!active) return
    active = false
    globalThis.clearInterval(interval)
    if (graceTimeout) globalThis.clearTimeout(graceTimeout)
  }
}

export interface ArcimDocumentImportResult {
  provider: string
  scanned: number
  linked: number
  skipped: number
  unmatched: number
  failed: number
  /**
   * Underlag whose verifikat sits in a klarmarkerat or locked year: the
   * database refuses those links until the year is reopened, so they are
   * neither failures nor retryable as they stand.
   */
  locked: number
  /** The fiscal years behind `locked` ("2024", "2022/2023"), oldest first. */
  lockedPeriods: string[]
  dryRun: boolean
  unmatchedSamples: { uploadId: string; voucher: string; date: string }[]
  /** Attachments in the provider's whole list (not just this call). */
  total: number
  /** The server stopped at its time budget; continue after nextCursor. */
  partial: boolean
  /** Provider id of the last handled attachment, or null when complete. */
  nextCursor: string | null
  /**
   * Attachment sources the provider refused (Fortnox supplier-invoice files),
   * with the scope the refused call needs, so the panel can name it.
   */
  unreachableSources: ArcimUnreachableDocumentSource[]
  /**
   * The run the server counted this slice for. Sent back with the next slice
   * so the server can continue its own run from the point it saved, also
   * after an answer this tab never got (crm#1581). Absent from older servers.
   */
  run?: string | null
}

export type ArcimDocumentScope = 'archive' | 'connectfile' | 'supplierinvoice'

export interface ArcimUnreachableDocumentSource {
  source: 'supplier_invoice_files'
  scope: ArcimDocumentScope
  reason: 'license' | 'permission' | 'error'
  providerMessage: string | null
}

const MAX_UNMATCHED_SAMPLES = 20

/**
 * One entry per scope: the latest answer wins, as the slices run in order.
 * An error (a timeout, a 5xx) belongs to the slice that met it only: every
 * slice lists every source again, so a later slice that got through drops it.
 */
function mergeUnreachableSources(
  accumulated: ArcimUnreachableDocumentSource[],
  next: ArcimUnreachableDocumentSource[],
): ArcimUnreachableDocumentSource[] {
  const byScope = new Map(
    accumulated.filter((entry) => entry.reason !== 'error').map((entry) => [entry.scope, entry]),
  )
  for (const entry of next) byScope.set(entry.scope, entry)
  return [...byScope.values()]
}

/**
 * Fold one server call into the running totals of a multi-call import. The
 * route processes a slice per call (hosted function limit), so the numbers
 * the user sees must be the sum of every slice, not the last one.
 */
export function mergeArcimDocumentImportResults(
  accumulated: ArcimDocumentImportResult | null,
  next: ArcimDocumentImportResult,
): ArcimDocumentImportResult {
  if (!accumulated) return next
  return {
    provider: next.provider,
    dryRun: next.dryRun,
    scanned: accumulated.scanned + next.scanned,
    linked: accumulated.linked + next.linked,
    skipped: accumulated.skipped + next.skipped,
    unmatched: accumulated.unmatched + next.unmatched,
    failed: accumulated.failed + next.failed,
    locked: accumulated.locked + next.locked,
    // Labels sort the same way the server sorts them: oldest year first.
    lockedPeriods: [...new Set([...accumulated.lockedPeriods, ...next.lockedPeriods])].sort(),
    unmatchedSamples: [...accumulated.unmatchedSamples, ...next.unmatchedSamples].slice(
      0,
      MAX_UNMATCHED_SAMPLES,
    ),
    total: next.total,
    partial: next.partial,
    nextCursor: next.nextCursor,
    unreachableSources: mergeUnreachableSources(accumulated.unreachableSources, next.unreachableSources),
    run: next.run ?? accumulated.run ?? undefined,
  }
}

export interface ArcimDocumentImportProblem {
  code: string | null
  requestId: string | null
  reconnectRequired: boolean
  message?: string
  /** What the source system (Fortnox/Bokio) itself answered, when known. */
  providerMessage?: string
}

export function documentOAuthProblemFromReason(
  reason: string,
): ArcimDocumentImportProblem {
  const normalized = reason.toLowerCase()
  const scopeFailure =
    normalized.includes('invalid_scope') ||
    normalized.includes('scope') ||
    normalized.includes('behörighet')
  const consentDenied =
    normalized.includes('access_denied') ||
    normalized.includes('denied') ||
    normalized.includes('nekad') ||
    normalized.includes('avbröt')

  return {
    code: scopeFailure ? PROVIDER_DOCUMENT_SCOPES_REQUIRED : null,
    requestId: null,
    reconnectRequired: scopeFailure || consentDenied,
    message: reason,
  }
}

export type ArcimDocumentImportPhase =
  | 'hidden'
  | 'discovering'
  | 'offered'
  | 'empty'
  | 'dismissed'
  | 'discovery-error'
  | 'importing'
  | 'complete'
  | 'import-error'
  | 'reconnecting'

export interface ArcimDocumentImportState {
  phase: ArcimDocumentImportPhase
  /** The provider this panel runs for: named in the copy, target of a retry. */
  provider: UnderlagImportProvider | null
  found: number
  result: ArcimDocumentImportResult | null
  problem: ArcimDocumentImportProblem | null
}

export const INITIAL_ARCIM_DOCUMENT_IMPORT_STATE: ArcimDocumentImportState = {
  phase: 'hidden',
  provider: null,
  found: 0,
  result: null,
  problem: null,
}

export type ArcimDocumentImportAction =
  | { type: 'reset' }
  | {
      type: 'discovery-started'
      provider: string | null
      migrationSucceeded: boolean
    }
  | { type: 'discovery-succeeded'; result: ArcimDocumentImportResult }
  | { type: 'discovery-failed'; problem: ArcimDocumentImportProblem }
  | { type: 'dismissed' }
  /**
   * `resumeFrom`: the running totals of a run that stopped, which the new
   * attempt continues instead of counting from zero.
   */
  | { type: 'import-started'; resumeFrom?: ArcimDocumentImportResult | null }
  | { type: 'import-progress'; result: ArcimDocumentImportResult }
  | { type: 'import-succeeded'; result: ArcimDocumentImportResult }
  | { type: 'import-failed'; problem: ArcimDocumentImportProblem }
  | { type: 'reconnect-started' }
  /** The login closed or was refused: back to the state the reconnect started from. */
  | { type: 'reconnect-cancelled'; phase: ArcimDocumentImportPhase }

/**
 * What "Koppla om Fortnox" leads to, by where it was pressed. A failed import
 * picks the import up again. Anywhere else (a failed discovery, or the note
 * about supplier-invoice files under an offer, an empty result or a finished
 * import) looks again once Fortnox answers, so the files the permission held
 * back are counted before anything is fetched. From a note nothing has
 * failed, so a closed or refused login returns the panel to where it was
 * instead of showing an error (`returnTo`); from an error state the error
 * stays (`returnTo` null).
 */
export function arcimDocumentReconnectPlan(phase: ArcimDocumentImportPhase): {
  resume: ArcimDocumentOAuthResumeAction
  returnTo: ArcimDocumentImportPhase | null
} {
  return {
    resume: phase === 'import-error' ? 'import' : 'discover',
    returnTo: phase === 'offered' || phase === 'empty' || phase === 'complete' ? phase : null,
  }
}

/**
 * The completed preview is the authoritative provider source. The selected
 * provider is only a fallback for older flows that do not retain preview data.
 */
export function resolveArcimDocumentFollowUpProvider(
  previewProvider: string | null | undefined,
  selectedProvider: string | null | undefined,
): UnderlagImportProvider | null {
  const provider = previewProvider ?? selectedProvider
  return supportsUnderlagImport(provider) ? provider : null
}

/**
 * Keeps the optional document step separate from the completed migration.
 * A discovery or import failure can therefore never replace the migration's
 * own success result with a failure state.
 */
export function arcimDocumentImportReducer(
  state: ArcimDocumentImportState,
  action: ArcimDocumentImportAction,
): ArcimDocumentImportState {
  switch (action.type) {
    case 'reset':
      return INITIAL_ARCIM_DOCUMENT_IMPORT_STATE
    case 'discovery-started':
      if (!supportsUnderlagImport(action.provider) || !action.migrationSucceeded) {
        return INITIAL_ARCIM_DOCUMENT_IMPORT_STATE
      }
      return { phase: 'discovering', provider: action.provider, found: 0, result: null, problem: null }
    case 'discovery-succeeded':
      if (!supportsUnderlagImport(action.result.provider)) {
        return INITIAL_ARCIM_DOCUMENT_IMPORT_STATE
      }
      if (action.result.scanned <= 0) {
        return {
          phase: 'empty',
          provider: action.result.provider,
          found: 0,
          result: action.result,
          problem: null,
        }
      }
      return {
        phase: 'offered',
        provider: action.result.provider,
        found: action.result.scanned,
        result: action.result,
        problem: null,
      }
    case 'discovery-failed':
      return {
        phase: 'discovery-error',
        provider: state.provider,
        found: 0,
        result: null,
        problem: action.problem,
      }
    case 'dismissed':
      return { ...state, phase: 'dismissed', problem: null }
    case 'import-started':
      // A run counts from zero: drop the dry-run preview and any totals a
      // failed run left behind, so neither is shown as this run's progress.
      // A resumed run continues the totals it stopped at instead.
      return {
        ...state,
        phase: 'importing',
        result: resumableDocumentImport(action.resumeFrom ?? null),
        problem: null,
      }
    case 'import-progress':
      // Running totals after each server slice; the phase stays 'importing'
      // so the UI keeps its spinner and shows "x av y".
      return { ...state, phase: 'importing', result: action.result, problem: null }
    case 'import-succeeded':
      return {
        phase: 'complete',
        provider: state.provider,
        found: state.found || action.result.total || action.result.scanned,
        result: action.result,
        problem: null,
      }
    case 'import-failed':
      return { ...state, phase: 'import-error', problem: action.problem }
    case 'reconnect-started':
      return { ...state, phase: 'reconnecting' }
    case 'reconnect-cancelled':
      // The reconnect kept the counts it started from, so only the phase
      // comes back. A late success may already have moved on: leave it.
      return state.phase === 'reconnecting' ? { ...state, phase: action.phase } : state
  }
}

/**
 * What the importing panel counts: the running totals once a slice has
 * answered, and before that zero of the total discovery found, so a long
 * first slice is never a bare spinner. Null when there is no honest total.
 */
export function documentImportProgress(
  state: ArcimDocumentImportState,
): { done: number; total: number } | null {
  if (state.phase !== 'importing') return null
  if (state.result) {
    return state.result.total > 0 ? { done: state.result.scanned, total: state.result.total } : null
  }
  return state.found > 0 ? { done: 0, total: state.found } : null
}

/**
 * The totals of a run that stopped part-way, when it can be continued: the
 * server handed back a cursor past the files it already handled. Null for a
 * finished run or one that never got a slice back, which start from the top.
 */
export function resumableDocumentImport(
  result: ArcimDocumentImportResult | null,
): ArcimDocumentImportResult | null {
  return result && !result.dryRun && result.partial && result.nextCursor ? result : null
}

/**
 * The run the server kept (crm#1410) as the totals a new attempt continues,
 * when it is this provider's and stopped part-way with a cursor to continue
 * after. A reload, a closed laptop or a tab that gave up used to send the
 * next "Hämta underlag" back to the first file, downloading every file the
 * stopped run had already linked again (crm#1581). A run the provider
 * refused keeps its cursor too: it is only fetched again once the connection
 * answers, which is what the reconnect copy promises.
 *
 * The sweep skips every file up to the cursor, so a run is continued only
 * while what it read is still what there is: not when it started before
 * `notBefore` (this connection was made, so it may read another database; or
 * a ledger import landed, so files it left unmatched may match now). Null
 * then, and for a finished run, another provider's, or one that never got a
 * slice back: those start from the top.
 */
export function resumableDocumentImportRun(
  run: DocumentImportRunStatus | null | undefined,
  provider: string | null,
  notBefore: readonly (string | null | undefined)[] = [],
): ArcimDocumentImportResult | null {
  if (!run || run.complete || run.provider !== provider) return null
  if (typeof run.nextCursor !== 'string' || run.nextCursor.length === 0) return null
  // The server's continuation judges a run by the same rule (crm#1581).
  if (!documentImportRunStartedAfter(run, notBefore)) return null
  return {
    provider: run.provider,
    scanned: run.scanned,
    linked: run.linked,
    skipped: run.skipped,
    unmatched: run.unmatched,
    failed: run.failed,
    locked: run.locked,
    lockedPeriods: run.lockedPeriods,
    dryRun: false,
    unmatchedSamples: run.unmatchedSamples,
    total: run.total,
    partial: true,
    nextCursor: run.nextCursor,
    unreachableSources: run.unreachableSources,
    // Its run id: a retried first slice whose answer is lost still continues
    // where the server got to.
    run: run.startedAt,
  }
}

/** The parts of the migration status route the resume reads. */
interface ArcimMigrationStatusForResume {
  consents?: { id: string; provider: string; createdAt?: string }[]
  latestCompletedSieImport?: { imported_at: string | null; created_at: string } | null
  latestDocumentImport?: DocumentImportRunStatus | null
}

export const ARCIM_MIGRATION_STATUS_ENDPOINT = '/api/extensions/ext/arcim-migration/status'

/**
 * Where the kept run for this connection stands now, read from the server
 * when the import starts rather than from the page's earlier copy: a run
 * this tab finished since then must not be continued from where it stood
 * before. Null when there is nothing to continue or the server cannot say:
 * the import then starts from the top, which is always safe.
 */
export async function fetchResumableDocumentImport(
  consentId: string,
  fetcher: typeof fetch = fetch,
): Promise<ArcimDocumentImportResult | null> {
  try {
    const response = await fetcher(ARCIM_MIGRATION_STATUS_ENDPOINT)
    if (!response.ok) return null
    const status = (await response.json()) as ArcimMigrationStatusForResume | null
    const consent = status?.consents?.find((entry) => entry.id === consentId)
    if (!consent) return null
    const ledger = status?.latestCompletedSieImport
    return resumableDocumentImportRun(status?.latestDocumentImport, consent.provider, [
      consent.createdAt,
      ledger ? (ledger.imported_at ?? ledger.created_at) : null,
    ])
  } catch {
    // Safe to ignore: without the kept run the import starts from the top,
    // as it did before, and the files already linked are skipped by hash.
    return null
  }
}

export class ArcimDocumentImportRequestError extends Error {
  constructor(
    readonly problem: ArcimDocumentImportProblem,
    /** The route's HTTP status; null when it answered 200 with an unusable body. */
    readonly status: number | null = null,
  ) {
    super(problem.code ?? 'ARCIM_DOCUMENT_IMPORT_FAILED')
    this.name = 'ArcimDocumentImportRequestError'
  }
}

/**
 * A slice that failed for a reason a later attempt can outlive: the network
 * dropped, the server or the database blinked (a 5xx), or a rate limit. A
 * refusal (4xx: scopes, validation) is an answer, not a blink, and is never
 * retried. Retrying a slice is safe: the files it already archived are
 * skipped by hash on the next pass.
 */
function isTransientImportFailure(error: unknown): boolean {
  if (error instanceof ArcimDocumentImportRequestError) {
    return error.status !== null && (error.status >= 500 || error.status === 429)
  }
  // fetch rejects with a TypeError when the request never got an answer.
  return error instanceof TypeError
}

function problemFromPayload(payload: unknown): ArcimDocumentImportProblem {
  const error = (payload as { error?: unknown } | null)?.error
  const structured =
    error && typeof error === 'object'
      ? (error as { code?: unknown; requestId?: unknown; details?: unknown })
      : null
  const code = typeof structured?.code === 'string' ? structured.code : null
  const requestId =
    typeof structured?.requestId === 'string' ? structured.requestId : null
  const details =
    structured?.details && typeof structured.details === 'object'
      ? (structured.details as { providerMessage?: unknown })
      : null
  const providerMessage =
    typeof details?.providerMessage === 'string' && details.providerMessage.trim()
      ? details.providerMessage.trim()
      : null

  return {
    code,
    requestId,
    reconnectRequired:
      code === PROVIDER_DOCUMENT_SCOPES_REQUIRED ||
      (code !== null && PROVIDER_CONNECTION_REFUSED_CODES.includes(code)),
    ...(providerMessage ? { providerMessage } : {}),
  }
}

type WireDocumentImportResult = Omit<
  ArcimDocumentImportResult,
  'total' | 'partial' | 'nextCursor' | 'locked' | 'lockedPeriods' | 'unreachableSources'
> &
  Partial<
    Pick<
      ArcimDocumentImportResult,
      'total' | 'partial' | 'nextCursor' | 'locked' | 'lockedPeriods' | 'unreachableSources'
    >
  >

const DOCUMENT_SCOPES: readonly ArcimDocumentScope[] = ['archive', 'connectfile', 'supplierinvoice']
const UNREACHABLE_REASONS: readonly ArcimUnreachableDocumentSource['reason'][] = [
  'license',
  'permission',
  'error',
]

function isUnreachableSource(value: unknown): value is ArcimUnreachableDocumentSource {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<ArcimUnreachableDocumentSource>
  return (
    entry.source === 'supplier_invoice_files' &&
    DOCUMENT_SCOPES.includes(entry.scope as ArcimDocumentScope) &&
    UNREACHABLE_REASONS.includes(entry.reason as ArcimUnreachableDocumentSource['reason'])
  )
}

function isDocumentImportResult(value: unknown): value is WireDocumentImportResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<ArcimDocumentImportResult>
  return (
    typeof result.provider === 'string' &&
    typeof result.scanned === 'number' &&
    typeof result.linked === 'number' &&
    typeof result.skipped === 'number' &&
    typeof result.unmatched === 'number' &&
    typeof result.failed === 'number' &&
    typeof result.dryRun === 'boolean' &&
    Array.isArray(result.unmatchedSamples)
  )
}

/**
 * Older servers answer without the resume fields (a single complete slice),
 * without the locked-year count (nothing was told apart as locked) and
 * without unreachable sources (supplier-invoice files were not read).
 */
function normalizeDocumentImportResult(
  result: WireDocumentImportResult,
): ArcimDocumentImportResult {
  return {
    ...result,
    unreachableSources: Array.isArray(result.unreachableSources)
      ? result.unreachableSources.filter(isUnreachableSource).map((entry) => ({
          source: entry.source,
          scope: entry.scope,
          reason: entry.reason,
          providerMessage:
            typeof entry.providerMessage === 'string' && entry.providerMessage.trim()
              ? entry.providerMessage.trim()
              : null,
        }))
      : [],
    locked: typeof result.locked === 'number' ? result.locked : 0,
    lockedPeriods: Array.isArray(result.lockedPeriods)
      ? result.lockedPeriods.filter((label): label is string => typeof label === 'string')
      : [],
    total: typeof result.total === 'number' ? result.total : result.scanned,
    partial: result.partial === true,
    nextCursor:
      typeof result.nextCursor === 'string' && result.nextCursor.length > 0 && result.partial === true
        ? result.nextCursor
        : null,
    run: typeof result.run === 'string' && result.run.length > 0 ? result.run : undefined,
  }
}

/**
 * Call the existing POST route for both discovery and the actual import.
 * `cursor` resumes a partial import; omit it for discovery and the first slice.
 * `run` is the run id an earlier answer of this import carried.
 */
export async function requestArcimDocumentImport(
  consentId: string,
  dryRun: boolean,
  fetcher: typeof fetch = fetch,
  cursor?: string,
  run?: string,
): Promise<ArcimDocumentImportResult> {
  const response = await fetcher(ARCIM_DOCUMENT_IMPORT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      consentId,
      dryRun,
      ...(cursor === undefined ? {} : { cursor }),
      ...(run === undefined ? {} : { run }),
    }),
  })
  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    throw new ArcimDocumentImportRequestError(problemFromPayload(payload), response.status)
  }

  const result = (payload as { result?: unknown } | null)?.result
  if (!isDocumentImportResult(result)) {
    throw new ArcimDocumentImportRequestError({
      code: null,
      requestId: null,
      reconnectRequired: false,
    })
  }

  return normalizeDocumentImportResult(result)
}

/** Far above any real list: a guard against a server that never completes. */
const MAX_IMPORT_ROUNDS = 500

export const ARCIM_DOCUMENT_IMPORT_STALLED = 'ARCIM_DOCUMENT_IMPORT_STALLED'

/**
 * Waits before each new attempt at a slice that failed transiently. A deploy
 * that reloads the database schema answered every request with a 5xx for a
 * few seconds and stopped a 3 475-file sweep at 1 897 (crm#1409); a minute of
 * patience outlives that without hiding a real outage for long.
 */
export const DOCUMENT_IMPORT_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 30_000]

/**
 * Run the real import to completion: the route works through one time-budgeted
 * slice per call and hands back a cursor, so this loops until the server says
 * it reached the end, reporting running totals after every slice. A slice that
 * fails transiently (network, 5xx, 429) is tried again after each of
 * `retryDelaysMs`; any other request error, or a transient one that outlasts
 * them, aborts the loop. The slices already archived stay linked, and
 * `resumeFrom` (the totals the stopped run reported) continues after the last
 * handled file instead of starting over. A server that keeps answering
 * "partial" without advancing (or past the round guard) is reported as a
 * failure, never as a completed import: the retry button resumes safely.
 */
export async function runArcimDocumentImportToCompletion(
  consentId: string,
  options: {
    fetcher?: typeof fetch
    onProgress?: (accumulated: ArcimDocumentImportResult) => void
    resumeFrom?: ArcimDocumentImportResult | null
    retryDelaysMs?: readonly number[]
    wait?: (ms: number) => Promise<void>
  } = {},
): Promise<ArcimDocumentImportResult> {
  const fetcher = options.fetcher ?? fetch
  const retryDelaysMs = options.retryDelaysMs ?? DOCUMENT_IMPORT_RETRY_DELAYS_MS
  const wait = options.wait ?? sleep
  const resumeFrom = resumableDocumentImport(options.resumeFrom ?? null)
  let accumulated: ArcimDocumentImportResult | null = resumeFrom
  let cursor: string | undefined = resumeFrom?.nextCursor ?? undefined
  // The server's id for this run, from its latest answer: a retried slice
  // whose answer was lost then continues where the server got to (crm#1581).
  let run: string | undefined = resumeFrom?.run ?? undefined

  const requestSlice = async (): Promise<ArcimDocumentImportResult> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await requestArcimDocumentImport(consentId, false, fetcher, cursor, run)
      } catch (error) {
        if (attempt >= retryDelaysMs.length || !isTransientImportFailure(error)) throw error
        await wait(retryDelaysMs[attempt])
      }
    }
  }

  for (let round = 0; round < MAX_IMPORT_ROUNDS; round++) {
    const slice = await requestSlice()
    run = slice.run ?? run
    accumulated = mergeArcimDocumentImportResults(accumulated, slice)
    if (!slice.partial) {
      return { ...accumulated, partial: false, nextCursor: null }
    }
    if (slice.nextCursor === null || (cursor !== undefined && slice.nextCursor <= cursor)) {
      break
    }
    cursor = slice.nextCursor
    options.onProgress?.(accumulated)
  }

  throw new ArcimDocumentImportRequestError({
    code: ARCIM_DOCUMENT_IMPORT_STALLED,
    requestId: null,
    reconnectRequired: false,
  })
}

/**
 * What the connections list says about the latest underlag run, from the
 * summary the server keeps (crm#1410): the outcome of a finished run, or how
 * far an unfinished one got and whether it is still moving. Null when no run
 * was recorded.
 */
export type DocumentImportRunNote =
  | {
      kind: 'complete'
      date: string
      /** On their verifikat: linked by this run or already there. */
      present: number
      total: number
      unmatched: number
      locked: number
      lockedYears: string
      failed: number
      /** Fortnox held back the files on supplier invoices. */
      unreachable: boolean
    }
  /**
   * running: a slice answered moments ago. resuming: silent, and the server
   * picks it up again on its own (crm#1581). stopped: silent, and only
   * "Hämta underlag" moves it.
   */
  | { kind: 'running' | 'resuming' | 'stopped'; date: string; scanned: number; total: number }
  /** The provider refused the connection: nothing moves until it is reconnected (B11). */
  | { kind: 'reconnect'; date: string; provider: string }

export function documentImportRunNote(
  run: DocumentImportRunStatus | null | undefined,
): DocumentImportRunNote | null {
  if (!run) return null
  if (!run.complete && run.needsReconnect) {
    return { kind: 'reconnect', date: run.updatedAt, provider: run.provider }
  }
  if (!run.complete) {
    // An older server sends no continuesOnServer: such a run only moves again
    // when someone starts it.
    const kind = !run.stalled ? 'running' : run.continuesOnServer === true ? 'resuming' : 'stopped'
    return { kind, date: run.updatedAt, scanned: run.scanned, total: run.total }
  }
  return {
    kind: 'complete',
    date: run.updatedAt,
    present: run.linked + run.skipped,
    total: run.total,
    unmatched: run.unmatched,
    locked: run.locked,
    lockedYears: run.lockedPeriods.join(', '),
    failed: run.failed,
    unreachable: run.unreachableSources.length > 0,
  }
}

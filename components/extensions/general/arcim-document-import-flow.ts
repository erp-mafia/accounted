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

export const ARCIM_DOCUMENT_OAUTH_RESUME_KEY =
  'arcim-document-oauth-resume'

export type ArcimDocumentOAuthResumeAction = 'discover' | 'import'

export interface ArcimDocumentOAuthResume {
  action: ArcimDocumentOAuthResumeAction
}

export function parseArcimDocumentOAuthResume(
  value: string | null,
): ArcimDocumentOAuthResume | null {
  if (value !== 'discover' && value !== 'import') return null
  return { action: value }
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
  dryRun: boolean
  unmatchedSamples: { uploadId: string; voucher: string; date: string }[]
  /** Attachments in the provider's whole list (not just this call). */
  total: number
  /** The server stopped at its time budget; continue from nextCursor. */
  partial: boolean
  nextCursor: number | null
}

const MAX_UNMATCHED_SAMPLES = 20

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
    unmatchedSamples: [...accumulated.unmatchedSamples, ...next.unmatchedSamples].slice(
      0,
      MAX_UNMATCHED_SAMPLES,
    ),
    total: next.total,
    partial: next.partial,
    nextCursor: next.nextCursor,
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
  found: number
  result: ArcimDocumentImportResult | null
  problem: ArcimDocumentImportProblem | null
}

export const INITIAL_ARCIM_DOCUMENT_IMPORT_STATE: ArcimDocumentImportState = {
  phase: 'hidden',
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
  | { type: 'import-started' }
  | { type: 'import-progress'; result: ArcimDocumentImportResult }
  | { type: 'import-succeeded'; result: ArcimDocumentImportResult }
  | { type: 'import-failed'; problem: ArcimDocumentImportProblem }
  | { type: 'reconnect-started' }

/**
 * The completed preview is the authoritative provider source. The selected
 * provider is only a fallback for older flows that do not retain preview data.
 */
export function resolveArcimDocumentFollowUpProvider(
  previewProvider: string | null | undefined,
  selectedProvider: string | null | undefined,
): 'fortnox' | null {
  const provider = previewProvider ?? selectedProvider
  return provider === 'fortnox' ? provider : null
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
      if (action.provider !== 'fortnox' || !action.migrationSucceeded) {
        return INITIAL_ARCIM_DOCUMENT_IMPORT_STATE
      }
      return { phase: 'discovering', found: 0, result: null, problem: null }
    case 'discovery-succeeded':
      if (action.result.provider !== 'fortnox') {
        return INITIAL_ARCIM_DOCUMENT_IMPORT_STATE
      }
      if (action.result.scanned <= 0) {
        return {
          phase: 'empty',
          found: 0,
          result: action.result,
          problem: null,
        }
      }
      return {
        phase: 'offered',
        found: action.result.scanned,
        result: action.result,
        problem: null,
      }
    case 'discovery-failed':
      return {
        phase: 'discovery-error',
        found: 0,
        result: null,
        problem: action.problem,
      }
    case 'dismissed':
      return { ...state, phase: 'dismissed', problem: null }
    case 'import-started':
      return { ...state, phase: 'importing', problem: null }
    case 'import-progress':
      // Running totals after each server slice; the phase stays 'importing'
      // so the UI keeps its spinner and shows "x av y".
      return { ...state, phase: 'importing', result: action.result, problem: null }
    case 'import-succeeded':
      return {
        phase: 'complete',
        found: state.found || action.result.total || action.result.scanned,
        result: action.result,
        problem: null,
      }
    case 'import-failed':
      return { ...state, phase: 'import-error', problem: action.problem }
    case 'reconnect-started':
      return { ...state, phase: 'reconnecting' }
  }
}

export class ArcimDocumentImportRequestError extends Error {
  constructor(readonly problem: ArcimDocumentImportProblem) {
    super(problem.code ?? 'ARCIM_DOCUMENT_IMPORT_FAILED')
    this.name = 'ArcimDocumentImportRequestError'
  }
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
    reconnectRequired: code === PROVIDER_DOCUMENT_SCOPES_REQUIRED,
    ...(providerMessage ? { providerMessage } : {}),
  }
}

type WireDocumentImportResult = Omit<
  ArcimDocumentImportResult,
  'total' | 'partial' | 'nextCursor'
> &
  Partial<Pick<ArcimDocumentImportResult, 'total' | 'partial' | 'nextCursor'>>

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

/** Older servers answer without the resume fields: a single complete slice. */
function normalizeDocumentImportResult(
  result: WireDocumentImportResult,
): ArcimDocumentImportResult {
  return {
    ...result,
    total: typeof result.total === 'number' ? result.total : result.scanned,
    partial: result.partial === true,
    nextCursor:
      typeof result.nextCursor === 'number' && result.partial === true ? result.nextCursor : null,
  }
}

/**
 * Call the existing POST route for both discovery and the actual import.
 * `cursor` resumes a partial import; omit it for discovery and the first slice.
 */
export async function requestArcimDocumentImport(
  consentId: string,
  dryRun: boolean,
  fetcher: typeof fetch = fetch,
  cursor?: number,
): Promise<ArcimDocumentImportResult> {
  const response = await fetcher(ARCIM_DOCUMENT_IMPORT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      cursor === undefined ? { consentId, dryRun } : { consentId, dryRun, cursor },
    ),
  })
  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    throw new ArcimDocumentImportRequestError(problemFromPayload(payload))
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

/**
 * Run the real import to completion: the route works through one time-budgeted
 * slice per call and hands back a cursor, so this loops until the server says
 * it reached the end, reporting running totals after every slice. A thrown
 * request error aborts the loop; the slices already archived stay linked and
 * the next attempt skips them by hash.
 */
export async function runArcimDocumentImportToCompletion(
  consentId: string,
  options: {
    fetcher?: typeof fetch
    onProgress?: (accumulated: ArcimDocumentImportResult) => void
  } = {},
): Promise<ArcimDocumentImportResult> {
  const fetcher = options.fetcher ?? fetch
  let accumulated: ArcimDocumentImportResult | null = null
  let cursor: number | undefined

  for (let round = 0; round < MAX_IMPORT_ROUNDS; round++) {
    const slice = await requestArcimDocumentImport(consentId, false, fetcher, cursor)
    accumulated = mergeArcimDocumentImportResults(accumulated, slice)
    // Complete, or a cursor that would not advance (the server always makes
    // progress; treat anything else as the end rather than spinning).
    if (
      !slice.partial ||
      slice.nextCursor === null ||
      (cursor !== undefined && slice.nextCursor <= cursor)
    ) {
      return { ...accumulated, partial: false, nextCursor: null }
    }
    cursor = slice.nextCursor
    options.onProgress?.(accumulated)
  }

  return accumulated as ArcimDocumentImportResult
}

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
    case 'import-succeeded':
      return {
        phase: 'complete',
        found: state.found || action.result.scanned,
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

function isDocumentImportResult(value: unknown): value is ArcimDocumentImportResult {
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

/** Call the existing POST route for both discovery and the actual import. */
export async function requestArcimDocumentImport(
  consentId: string,
  dryRun: boolean,
  fetcher: typeof fetch = fetch,
): Promise<ArcimDocumentImportResult> {
  const response = await fetcher(ARCIM_DOCUMENT_IMPORT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ consentId, dryRun }),
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

  return result
}

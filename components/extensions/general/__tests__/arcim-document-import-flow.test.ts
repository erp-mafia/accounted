import { describe, expect, it, vi } from 'vitest'
import {
  ARCIM_DOCUMENT_OAUTH_RESUME_KEY,
  INITIAL_ARCIM_DOCUMENT_IMPORT_STATE,
  PROVIDER_DOCUMENT_SCOPES_REQUIRED,
  ArcimDocumentImportRequestError,
  arcimDocumentImportReducer,
  parseArcimDocumentOAuthResume,
  requestArcimDocumentImport,
  serializeArcimDocumentOAuthResume,
  watchArcimOAuthPopup,
  type ArcimDocumentImportResult,
} from '../arcim-document-import-flow'

function result(
  overrides: Partial<ArcimDocumentImportResult> = {},
): ArcimDocumentImportResult {
  return {
    provider: 'fortnox',
    scanned: 7,
    linked: 5,
    skipped: 0,
    unmatched: 2,
    failed: 0,
    dryRun: true,
    unmatchedSamples: [],
    ...overrides,
  }
}

describe('Fortnox document follow-up state', () => {
  it('offers the prompt after a successful Fortnox migration using the honest found count', () => {
    const discovering = arcimDocumentImportReducer(
      INITIAL_ARCIM_DOCUMENT_IMPORT_STATE,
      { type: 'discovery-started', provider: 'fortnox', migrationSucceeded: true },
    )
    const offered = arcimDocumentImportReducer(discovering, {
      type: 'discovery-succeeded',
      result: result({ scanned: 7, linked: 5, unmatched: 2 }),
    })

    expect(offered.phase).toBe('offered')
    expect(offered.found).toBe(7)
  })

  it('does not start discovery for a non-Fortnox migration', () => {
    expect(
      arcimDocumentImportReducer(INITIAL_ARCIM_DOCUMENT_IMPORT_STATE, {
        type: 'discovery-started',
        provider: 'bokio',
        migrationSucceeded: true,
      }),
    ).toEqual(INITIAL_ARCIM_DOCUMENT_IMPORT_STATE)
  })

  it('does not interrupt the completed migration when Fortnox has no attachments', () => {
    const discovering = arcimDocumentImportReducer(
      INITIAL_ARCIM_DOCUMENT_IMPORT_STATE,
      { type: 'discovery-started', provider: 'fortnox', migrationSucceeded: true },
    )
    expect(
      arcimDocumentImportReducer(discovering, {
        type: 'discovery-succeeded',
        result: result({ scanned: 0, linked: 0, unmatched: 0 }),
      }),
    ).toEqual(INITIAL_ARCIM_DOCUMENT_IMPORT_STATE)
  })

  it('keeps a dry-run failure in a retryable document state, separate from migration success', () => {
    const problem = { code: 'TRANSIENT_ERROR', requestId: 'req_test', reconnectRequired: false }
    const state = arcimDocumentImportReducer(
      { phase: 'discovering', found: 0, result: null, problem: null },
      { type: 'discovery-failed', problem },
    )

    expect(state).toEqual({
      phase: 'discovery-error',
      found: 0,
      result: null,
      problem,
    })
  })

  it('keeps all outcome counts after a successful import', () => {
    const imported = result({
      dryRun: false,
      scanned: 7,
      linked: 3,
      skipped: 2,
      unmatched: 1,
      failed: 1,
    })
    const state = arcimDocumentImportReducer(
      { phase: 'importing', found: 7, result: null, problem: null },
      { type: 'import-succeeded', result: imported },
    )

    expect(state.phase).toBe('complete')
    expect(state.result).toMatchObject({
      linked: 3,
      skipped: 2,
      unmatched: 1,
      failed: 1,
    })
  })

  it('marks the archive/connectfile scope error as reconnect-required', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: PROVIDER_DOCUMENT_SCOPES_REQUIRED,
            message: 'scope required',
            requestId: 'req_scope',
          },
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const error = await requestArcimDocumentImport(
      'consent-1',
      true,
      fetcher,
    ).catch((caught) => caught)

    expect(error).toBeInstanceOf(ArcimDocumentImportRequestError)
    expect(error.problem).toEqual({
      code: PROVIDER_DOCUMENT_SCOPES_REQUIRED,
      requestId: 'req_scope',
      reconnectRequired: true,
    })
  })
})

describe('document import endpoint request', () => {
  it('uses POST dry-run discovery without downloading automatically', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: result() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await requestArcimDocumentImport('consent-1', true, fetcher)

    expect(fetcher).toHaveBeenCalledWith(
      '/api/extensions/ext/arcim-migration/import-documents',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ consentId: 'consent-1', dryRun: true }),
      }),
    )
  })
})

describe('document scope OAuth recovery', () => {
  it('round-trips the full-page redirect resume action and rejects malformed state', () => {
    expect(ARCIM_DOCUMENT_OAUTH_RESUME_KEY).toBe('arcim-document-oauth-resume')
    const serialized = serializeArcimDocumentOAuthResume({
      action: 'import',
      consentId: 'consent-1',
    })

    expect(parseArcimDocumentOAuthResume(serialized)).toEqual({
      action: 'import',
      consentId: 'consent-1',
    })
    expect(parseArcimDocumentOAuthResume('{"action":"unknown"}')).toBeNull()
  })

  it('restores retry controls when the OAuth popup is closed', () => {
    vi.useFakeTimers()
    const popup = { closed: false }
    const onClosed = vi.fn()
    const stopWatching = watchArcimOAuthPopup(popup, onClosed, 10, 20)

    vi.advanceTimersByTime(20)
    expect(onClosed).not.toHaveBeenCalled()

    popup.closed = true
    vi.advanceTimersByTime(10)
    expect(onClosed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)
    expect(onClosed).toHaveBeenCalledOnce()

    stopWatching()
    vi.useRealTimers()
  })

  it('lets a queued OAuth success cancel the popup-close grace period', () => {
    vi.useFakeTimers()
    const popup = { closed: true }
    const onClosed = vi.fn()
    const stopWatching = watchArcimOAuthPopup(popup, onClosed, 10, 20)

    vi.advanceTimersByTime(10)
    stopWatching()
    vi.advanceTimersByTime(20)

    expect(onClosed).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

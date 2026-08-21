import { describe, expect, it, vi } from 'vitest'
import {
  ARCIM_DOCUMENT_OAUTH_RESUME_KEY,
  INITIAL_ARCIM_DOCUMENT_IMPORT_STATE,
  PROVIDER_DOCUMENT_SCOPES_REQUIRED,
  PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE,
  ArcimDocumentImportRequestError,
  arcimDocumentImportReducer,
  documentOAuthProblemFromReason,
  parseArcimDocumentOAuthResume,
  mergeArcimDocumentImportResults,
  requestArcimDocumentImport,
  resolveArcimDocumentFollowUpProvider,
  runArcimDocumentImportToCompletion,
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
    total: 7,
    partial: false,
    nextCursor: null,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
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

  it('keeps the document step visible when Fortnox has no attachments', () => {
    const discovering = arcimDocumentImportReducer(
      INITIAL_ARCIM_DOCUMENT_IMPORT_STATE,
      { type: 'discovery-started', provider: 'fortnox', migrationSucceeded: true },
    )
    const empty = arcimDocumentImportReducer(discovering, {
      type: 'discovery-succeeded',
      result: result({ scanned: 0, linked: 0, unmatched: 0 }),
    })

    expect(empty.phase).toBe('empty')
    expect(empty.result?.scanned).toBe(0)
  })

  it('uses the completed preview provider before transient selection state', () => {
    expect(resolveArcimDocumentFollowUpProvider('fortnox', null)).toBe('fortnox')
    expect(resolveArcimDocumentFollowUpProvider('fortnox', 'bokio')).toBe('fortnox')
    expect(resolveArcimDocumentFollowUpProvider(undefined, 'fortnox')).toBe('fortnox')
    expect(resolveArcimDocumentFollowUpProvider('bokio', 'fortnox')).toBeNull()
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

  it('keeps the dry-run result offered until the user explicitly starts import', () => {
    const offered = arcimDocumentImportReducer(
      { phase: 'discovering', found: 0, result: null, problem: null },
      { type: 'discovery-succeeded', result: result({ dryRun: true }) },
    )

    expect(offered).toMatchObject({ phase: 'offered', result: { dryRun: true } })
    expect(
      arcimDocumentImportReducer(offered, { type: 'import-started' }),
    ).toMatchObject({ phase: 'importing' })
  })

  it('allows OAuth success to replace an earlier popup-close failure', () => {
    const problem = { code: null, requestId: null, reconnectRequired: true }
    const failed = arcimDocumentImportReducer(
      { phase: 'reconnecting', found: 7, result: result(), problem },
      { type: 'import-failed', problem },
    )
    const importing = arcimDocumentImportReducer(failed, { type: 'import-started' })
    const complete = arcimDocumentImportReducer(importing, {
      type: 'import-succeeded',
      result: result({ dryRun: false, linked: 7, unmatched: 0 }),
    })

    expect(failed.phase).toBe('import-error')
    expect(complete).toMatchObject({ phase: 'complete', result: { linked: 7 } })
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

  // The scopes are missing from the connect request itself, so offering a
  // reconnect would loop the user forever (Klura AB, 2026-08-20).
  it('never offers a reconnect when the scopes are unavailable to the integration', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE,
            message: 'scopes unavailable',
            requestId: 'req_unavailable',
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
      code: PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE,
      requestId: 'req_unavailable',
      reconnectRequired: false,
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

  it('rejects a success payload without unmatched samples', async () => {
    const invalid = result()
    const { unmatchedSamples: _unmatchedSamples, ...withoutSamples } = invalid
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: withoutSamples }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(
      requestArcimDocumentImport('consent-1', true, fetcher),
    ).rejects.toBeInstanceOf(ArcimDocumentImportRequestError)
  })
})

describe('document scope OAuth recovery', () => {
  it('round-trips the full-page redirect resume action and rejects malformed state', () => {
    expect(ARCIM_DOCUMENT_OAUTH_RESUME_KEY).toBe('arcim-document-oauth-resume')
    expect(parseArcimDocumentOAuthResume('import')).toEqual({
      action: 'import',
    })
    expect(parseArcimDocumentOAuthResume('unknown')).toBeNull()
  })

  it('only treats scope and consent failures as reconnectable', () => {
    expect(
      documentOAuthProblemFromReason('Tredjepartsappen saknar rätt behörigheter'),
    ).toMatchObject({
      code: PROVIDER_DOCUMENT_SCOPES_REQUIRED,
      reconnectRequired: true,
    })
    expect(documentOAuthProblemFromReason('Du avbröt anslutningen')).toMatchObject({
      code: null,
      reconnectRequired: true,
    })
    expect(documentOAuthProblemFromReason('Leverantören är tillfälligt nere')).toEqual({
      code: null,
      requestId: null,
      reconnectRequired: false,
      message: 'Leverantören är tillfälligt nere',
    })
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

describe('resumable import (one server slice per call)', () => {
  it('accepts an older server answer without resume fields as one complete slice', async () => {
    const { total: _t, partial: _p, nextCursor: _c, ...legacy } = result({ scanned: 9 })
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: legacy }))

    const normalized = await requestArcimDocumentImport('consent-1', true, fetcher)

    expect(normalized).toMatchObject({ total: 9, partial: false, nextCursor: null })
    expect(JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      consentId: 'consent-1',
      dryRun: true,
    })
  })

  it('sends the cursor only when resuming', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: result() }))

    await requestArcimDocumentImport('consent-1', false, fetcher, 42)

    expect(JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      consentId: 'consent-1',
      dryRun: false,
      cursor: 42,
    })
  })

  it('sums every slice and keeps the latest total', () => {
    const merged = mergeArcimDocumentImportResults(
      result({ scanned: 17, linked: 15, skipped: 1, unmatched: 1, failed: 0, total: 113, unmatchedSamples: [{ uploadId: 'u1', voucher: 'A1', date: '2026-01-01' }] }),
      result({ scanned: 20, linked: 18, skipped: 0, unmatched: 1, failed: 1, total: 113, partial: true, nextCursor: 37, unmatchedSamples: [{ uploadId: 'u2', voucher: 'A2', date: '2026-01-02' }] }),
    )

    expect(merged).toMatchObject({
      scanned: 37,
      linked: 33,
      skipped: 1,
      unmatched: 2,
      failed: 1,
      total: 113,
      partial: true,
      nextCursor: 37,
    })
    expect(merged.unmatchedSamples).toHaveLength(2)
  })

  it('loops until the server reports the end, passing the cursor back and reporting running totals', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: result({ dryRun: false, scanned: 17, linked: 17, total: 40, partial: true, nextCursor: 17 }) }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: result({ dryRun: false, scanned: 17, linked: 16, skipped: 1, total: 40, partial: true, nextCursor: 34 }) }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: result({ dryRun: false, scanned: 6, linked: 6, total: 40 }) }),
      )
    const onProgress = vi.fn()

    const final = await runArcimDocumentImportToCompletion('consent-1', { fetcher, onProgress })

    expect(fetcher).toHaveBeenCalledTimes(3)
    const bodies = fetcher.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string))
    expect(bodies).toEqual([
      { consentId: 'consent-1', dryRun: false },
      { consentId: 'consent-1', dryRun: false, cursor: 17 },
      { consentId: 'consent-1', dryRun: false, cursor: 34 },
    ])
    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(onProgress.mock.calls[1][0]).toMatchObject({ scanned: 34, linked: 33, skipped: 1, total: 40 })
    expect(final).toMatchObject({ scanned: 40, linked: 39, skipped: 1, total: 40, partial: false, nextCursor: null })
  })

  it('stops instead of spinning when a server hands back a cursor that does not advance', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: result({ dryRun: false, scanned: 5, total: 10, partial: true, nextCursor: 5 }) }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: result({ dryRun: false, scanned: 0, total: 10, partial: true, nextCursor: 5 }) }))

    const final = await runArcimDocumentImportToCompletion('consent-1', { fetcher })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(final).toMatchObject({ scanned: 5, partial: false, nextCursor: null })
  })

  it('keeps the import phase while recording running totals, then completes with the honest total', () => {
    const importing = arcimDocumentImportReducer(
      { phase: 'offered', found: 40, result: result({ dryRun: true, total: 40 }), problem: null },
      { type: 'import-started' },
    )
    const progressed = arcimDocumentImportReducer(importing, {
      type: 'import-progress',
      result: result({ dryRun: false, scanned: 17, linked: 17, total: 40, partial: true, nextCursor: 17 }),
    })
    expect(progressed).toMatchObject({ phase: 'importing', result: { scanned: 17, total: 40 } })

    const complete = arcimDocumentImportReducer(progressed, {
      type: 'import-succeeded',
      result: result({ dryRun: false, scanned: 40, linked: 39, skipped: 1, total: 40 }),
    })
    expect(complete).toMatchObject({ phase: 'complete', found: 40, result: { linked: 39, skipped: 1 } })
  })
})

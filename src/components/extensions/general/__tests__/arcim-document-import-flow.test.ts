import { describe, expect, it, vi } from 'vitest'
import {
  ARCIM_DOCUMENT_IMPORT_ENDPOINT,
  ARCIM_DOCUMENT_IMPORT_STALLED,
  ARCIM_DOCUMENT_OAUTH_RESUME_KEY,
  ARCIM_MIGRATION_STATUS_ENDPOINT,
  INITIAL_ARCIM_DOCUMENT_IMPORT_STATE,
  PROVIDER_DOCUMENT_SCOPES_REQUIRED,
  PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE,
  ArcimDocumentImportRequestError,
  arcimDocumentImportReducer,
  arcimDocumentReconnectPlan,
  documentImportProgress,
  documentImportRunNote,
  documentOAuthProblemFromReason,
  documentReconnectRefused,
  fetchResumableDocumentImport,
  parseArcimDocumentResumeMarker,
  mergeArcimDocumentImportResults,
  requestArcimDocumentImport,
  resolveArcimDocumentFollowUpProvider,
  resumableDocumentImportRun,
  runArcimDocumentImportToCompletion,
  serializeArcimDocumentResumeMarker,
  watchArcimOAuthPopup,
  type ArcimDocumentImportResult,
} from '../arcim-document-import-flow'
import {
  foldDocumentImportSlice,
  type DocumentImportRunStatus,
} from '@/extensions/general/arcim-migration/lib/document-import-run'

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
    locked: 0,
    lockedPeriods: [],
    dryRun: true,
    unmatchedSamples: [],
    total: 7,
    partial: false,
    nextCursor: null,
    unreachableSources: [],
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('document follow-up state', () => {
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

  it('offers the prompt after a successful Bokio migration too (crm#190)', () => {
    const discovering = arcimDocumentImportReducer(
      INITIAL_ARCIM_DOCUMENT_IMPORT_STATE,
      { type: 'discovery-started', provider: 'bokio', migrationSucceeded: true },
    )
    expect(discovering).toMatchObject({ phase: 'discovering', provider: 'bokio' })

    const offered = arcimDocumentImportReducer(discovering, {
      type: 'discovery-succeeded',
      result: result({ provider: 'bokio', scanned: 12, linked: 10, unmatched: 2 }),
    })

    expect(offered).toMatchObject({ phase: 'offered', provider: 'bokio', found: 12 })
  })

  it('does not start discovery for a provider without an underlag import', () => {
    expect(
      arcimDocumentImportReducer(INITIAL_ARCIM_DOCUMENT_IMPORT_STATE, {
        type: 'discovery-started',
        provider: 'visma',
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
    expect(resolveArcimDocumentFollowUpProvider('bokio', 'fortnox')).toBe('bokio')
    expect(resolveArcimDocumentFollowUpProvider('visma', 'fortnox')).toBeNull()
  })

  it('keeps a dry-run failure in a retryable document state, separate from migration success', () => {
    const problem = { code: 'TRANSIENT_ERROR', requestId: 'req_test', reconnectRequired: false }
    const state = arcimDocumentImportReducer(
      { phase: 'discovering', provider: 'fortnox', found: 0, result: null, problem: null },
      { type: 'discovery-failed', problem },
    )

    expect(state).toEqual({
      phase: 'discovery-error',
      provider: 'fortnox',
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
      { phase: 'importing', provider: 'fortnox', found: 7, result: null, problem: null },
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
      { phase: 'discovering', provider: 'fortnox', found: 0, result: null, problem: null },
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
      { phase: 'reconnecting', provider: 'fortnox', found: 7, result: result(), problem },
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

  it('returns a reconnect from the supplier-invoice files note to that note when the login closes', () => {
    const complete = {
      phase: 'complete' as const,
      provider: 'fortnox' as const,
      found: 7,
      result: result({
        dryRun: false,
        unreachableSources: [
          { source: 'supplier_invoice_files', scope: 'supplierinvoice', reason: 'permission', providerMessage: null },
        ],
      }),
      problem: null,
    }
    const reconnecting = arcimDocumentImportReducer(complete, { type: 'reconnect-started' })
    expect(reconnecting.phase).toBe('reconnecting')

    // Nothing failed: the finished import and its note come back as they were.
    expect(
      arcimDocumentImportReducer(reconnecting, { type: 'reconnect-cancelled', phase: 'complete' }),
    ).toEqual(complete)
  })

  it('lets a late login success win over the cancel', () => {
    const discovering = arcimDocumentImportReducer(INITIAL_ARCIM_DOCUMENT_IMPORT_STATE, {
      type: 'discovery-started',
      provider: 'fortnox',
      migrationSucceeded: true,
    })
    expect(
      arcimDocumentImportReducer(discovering, { type: 'reconnect-cancelled', phase: 'offered' }),
    ).toBe(discovering)
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
  // reconnect would loop the user forever (support case 2026-08-20).
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

describe('what Koppla om Fortnox leads to', () => {
  it('looks again after a reconnect from a supplier-invoice files note, and returns to it on a closed login', () => {
    for (const phase of ['offered', 'empty', 'complete'] as const) {
      expect(arcimDocumentReconnectPlan(phase)).toEqual({ resume: 'discover', returnTo: phase })
    }
  })

  it('keeps the approval states as they were: discovery looks again, a failed import imports again', () => {
    expect(arcimDocumentReconnectPlan('discovery-error')).toEqual({ resume: 'discover', returnTo: null })
    expect(arcimDocumentReconnectPlan('import-error')).toEqual({ resume: 'import', returnTo: null })
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
    expect(parseArcimDocumentResumeMarker('import')).toEqual({
      action: 'import',
      standalone: false,
    })
    expect(parseArcimDocumentResumeMarker('unknown')).toBeNull()
    expect(parseArcimDocumentResumeMarker(null)).toBeNull()
  })

  it('carries the standalone flag through the resume value so an underlag run from the connections list comes back without a migration verdict', () => {
    for (const action of ['discover', 'import'] as const) {
      for (const standalone of [true, false]) {
        const stored = serializeArcimDocumentResumeMarker({ action, standalone })
        expect(parseArcimDocumentResumeMarker(stored)).toEqual({ action, standalone })
      }
    }
    expect(serializeArcimDocumentResumeMarker({ action: 'discover', standalone: false })).toBe('discover')
    expect(parseArcimDocumentResumeMarker('unknown:standalone')).toBeNull()
    expect(parseArcimDocumentResumeMarker(':standalone')).toBeNull()
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

  // The login of a document reconnect came back refused in the popup. The
  // panel keeps the problem that started the reconnect (its heading, its
  // reference, the reconnect button) and says why the login failed: with the
  // reason dropped, a company without the Fortnox licence read the same
  // "approve the access" prompt after every attempt.
  it('answers a refused document reconnect with the prior problem and the reason the login came back with', () => {
    const licence =
      'Fortnox nekade inloggningen: Fortnox-företaget saknar licens för något som Accounted bad om att få läsa. ' +
      'Anslutningen du redan har påverkas inte.'
    const prior = { code: PROVIDER_DOCUMENT_SCOPES_REQUIRED, requestId: 'req-1', reconnectRequired: true }
    const stuck = arcimDocumentImportReducer(
      arcimDocumentImportReducer(
        { ...INITIAL_ARCIM_DOCUMENT_IMPORT_STATE, phase: 'discovery-error', problem: prior },
        { type: 'reconnect-started' },
      ),
      documentReconnectRefused('discover', licence, prior),
    )
    expect(stuck.phase).toBe('discovery-error')
    expect(stuck.problem).toEqual({ ...prior, message: licence })

    // Whatever the reason reads like, a new login stays the way forward: one
    // the callback rejected (a spent state) changed nothing on the connection.
    expect(documentReconnectRefused('import', 'Ingen giltig migrationssession hittades', prior)).toEqual({
      type: 'import-failed',
      problem: { ...prior, message: 'Ingen giltig migrationssession hittades' },
    })
    // No problem on record: still a reconnect, with the reason.
    expect(documentReconnectRefused('import', licence, null).problem).toEqual({
      code: null,
      requestId: null,
      reconnectRequired: true,
      message: licence,
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

  it('reads an older server answer without the locked-year fields as nothing locked', async () => {
    const { locked: _l, lockedPeriods: _lp, ...legacy } = result({ scanned: 4 })
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: legacy }))

    const normalized = await requestArcimDocumentImport('consent-1', true, fetcher)

    expect(normalized).toMatchObject({ scanned: 4, locked: 0, lockedPeriods: [] })
  })

  it('keeps the locked count and years a server reports (crm#251)', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, result: result({ locked: 491, lockedPeriods: ['2022/2023', '2024', '2025'] }) }),
    )

    const normalized = await requestArcimDocumentImport('consent-1', true, fetcher)

    expect(normalized).toMatchObject({ locked: 491, lockedPeriods: ['2022/2023', '2024', '2025'] })
  })

  it('sends the cursor only when resuming', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: result() }))

    await requestArcimDocumentImport('consent-1', false, fetcher, 'file-42')

    expect(JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      consentId: 'consent-1',
      dryRun: false,
      cursor: 'file-42',
    })
  })

  it('sums every slice and keeps the latest total', () => {
    const merged = mergeArcimDocumentImportResults(
      result({ scanned: 17, linked: 15, skipped: 1, unmatched: 1, failed: 0, total: 113, unmatchedSamples: [{ uploadId: 'u1', voucher: 'A1', date: '2026-01-01' }] }),
      result({ scanned: 20, linked: 18, skipped: 0, unmatched: 1, failed: 1, total: 113, partial: true, nextCursor: 'file-37', unmatchedSamples: [{ uploadId: 'u2', voucher: 'A2', date: '2026-01-02' }] }),
    )

    expect(merged).toMatchObject({
      scanned: 37,
      linked: 33,
      skipped: 1,
      unmatched: 2,
      failed: 1,
      total: 113,
      partial: true,
      nextCursor: 'file-37',
    })
    expect(merged.unmatchedSamples).toHaveLength(2)
  })

  it('sums customer-invoice PDF counters across slices', () => {
    const merged = mergeArcimDocumentImportResults(
      result({ customerInvoicePdfs: { scanned: 2, linked: 1, invoiceOnly: 0, skipped: 1, locked: 0, failed: 2, refused: 2 } }),
      result({ customerInvoicePdfs: { scanned: 3, linked: 1, invoiceOnly: 1, skipped: 0, locked: 1, failed: 1, refused: 1 } }),
    )

    expect(merged.customerInvoicePdfs).toEqual({ scanned: 5, linked: 2, invoiceOnly: 1, skipped: 1, locked: 1, failed: 3, refused: 3 })
  })

  it('sums locked receipts across slices and keeps each locked year once, oldest first', () => {
    const merged = mergeArcimDocumentImportResults(
      result({ locked: 3, lockedPeriods: ['2024', '2025'] }),
      result({ locked: 2, lockedPeriods: ['2022/2023', '2024'] }),
    )

    expect(merged).toMatchObject({ locked: 5, lockedPeriods: ['2022/2023', '2024', '2025'] })
  })

  it('keeps one unreachable source per scope across slices, the latest answer winning (PH 176)', () => {
    const merged = mergeArcimDocumentImportResults(
      result({
        unreachableSources: [
          { source: 'supplier_invoice_files', scope: 'archive', reason: 'error', providerMessage: null },
        ],
      }),
      result({
        unreachableSources: [
          { source: 'supplier_invoice_files', scope: 'archive', reason: 'permission', providerMessage: 'Har inte behörighet för scope.' },
          { source: 'supplier_invoice_files', scope: 'supplierinvoice', reason: 'license', providerMessage: null },
        ],
      }),
    )

    expect(merged.unreachableSources).toEqual([
      { source: 'supplier_invoice_files', scope: 'archive', reason: 'permission', providerMessage: 'Har inte behörighet för scope.' },
      { source: 'supplier_invoice_files', scope: 'supplierinvoice', reason: 'license', providerMessage: null },
    ])
  })

  it('drops the error of an earlier slice once a later slice got through, but keeps a refusal (crm#1642)', () => {
    const merged = mergeArcimDocumentImportResults(
      result({
        unreachableSources: [
          { source: 'supplier_invoice_files', scope: 'connectfile', reason: 'error', providerMessage: null },
          { source: 'supplier_invoice_files', scope: 'archive', reason: 'permission', providerMessage: null },
        ],
      }),
      result({ unreachableSources: [] }),
    )

    expect(merged.unreachableSources).toEqual([
      { source: 'supplier_invoice_files', scope: 'archive', reason: 'permission', providerMessage: null },
    ])
  })

  it('reads an older server answer without unreachable sources as none, and drops malformed entries', async () => {
    const { unreachableSources: _u, ...legacy } = result({ scanned: 4 })
    const legacyFetcher = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: legacy }))
    await expect(requestArcimDocumentImport('consent-1', true, legacyFetcher)).resolves.toMatchObject({
      unreachableSources: [],
    })

    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        result: {
          ...result(),
          unreachableSources: [
            { source: 'supplier_invoice_files', scope: 'connectfile', reason: 'permission', providerMessage: '  Saknar behörighet.  ' },
            { source: 'supplier_invoice_files', scope: 'inbox', reason: 'permission', providerMessage: null },
            { source: 'supplier_invoice_files', scope: 'archive', reason: 'maybe' },
            'connectfile',
          ],
        },
      }),
    )
    await expect(requestArcimDocumentImport('consent-1', true, fetcher)).resolves.toMatchObject({
      unreachableSources: [
        { source: 'supplier_invoice_files', scope: 'connectfile', reason: 'permission', providerMessage: 'Saknar behörighet.' },
      ],
    })
  })

  it('loops until the server reports the end, passing the cursor back and reporting running totals', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: result({ dryRun: false, scanned: 17, linked: 17, total: 40, partial: true, nextCursor: 'file-17' }) }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: result({ dryRun: false, scanned: 17, linked: 16, skipped: 1, total: 40, partial: true, nextCursor: 'file-34' }) }),
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
      { consentId: 'consent-1', dryRun: false, cursor: 'file-17' },
      { consentId: 'consent-1', dryRun: false, cursor: 'file-34' },
    ])
    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(onProgress.mock.calls[1][0]).toMatchObject({ scanned: 34, linked: 33, skipped: 1, total: 40 })
    expect(final).toMatchObject({ scanned: 40, linked: 39, skipped: 1, total: 40, partial: false, nextCursor: null })
  })

  it('fails (does not report completion) when a server hands back a cursor that does not advance', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: result({ dryRun: false, scanned: 5, total: 10, partial: true, nextCursor: 'file-5' }) }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: result({ dryRun: false, scanned: 0, total: 10, partial: true, nextCursor: 'file-5' }) }))
    const onProgress = vi.fn()

    await expect(
      runArcimDocumentImportToCompletion('consent-1', { fetcher, onProgress }),
    ).rejects.toMatchObject({ problem: { code: ARCIM_DOCUMENT_IMPORT_STALLED } })

    expect(fetcher).toHaveBeenCalledTimes(2)
    // The slice that did land was reported, so the UI keeps honest totals.
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress.mock.calls[0][0]).toMatchObject({ scanned: 5, total: 10 })
  })

  it('fails when a partial answer carries no cursor at all', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, result: result({ dryRun: false, scanned: 5, total: 10, partial: true, nextCursor: null }) }),
    )

    await expect(runArcimDocumentImportToCompletion('consent-1', { fetcher })).rejects.toMatchObject({
      problem: { code: ARCIM_DOCUMENT_IMPORT_STALLED },
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('tries a slice again after a transient server failure and completes the sweep (crm#1409)', async () => {
    // A deploy reloading the database schema answered one slice with a 500:
    // that used to stop a 3 475-file sweep at 1 897.
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: result({ dryRun: false, scanned: 20, linked: 20, total: 30, partial: true, nextCursor: 'file-20' }) }),
      )
      .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: result({ dryRun: false, scanned: 10, linked: 10, total: 30 }) }),
      )
    const wait = vi.fn().mockResolvedValue(undefined)

    const final = await runArcimDocumentImportToCompletion('consent-1', {
      fetcher,
      wait,
      retryDelaysMs: [1, 2, 3],
    })

    expect(fetcher).toHaveBeenCalledTimes(4)
    const cursors = fetcher.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string).cursor)
    // The failed slice is asked for again with the same cursor.
    expect(cursors).toEqual([undefined, 'file-20', 'file-20', 'file-20'])
    expect(wait.mock.calls.map((call) => call[0])).toEqual([1, 2])
    expect(final).toMatchObject({ scanned: 30, linked: 30, total: 30, partial: false })
  })

  it('stops once the retries are spent, keeping the error for the user', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: result({ dryRun: false, scanned: 20, total: 30, partial: true, nextCursor: 'file-20' }) }),
      )
      .mockImplementation(async () => jsonResponse({ error: { code: 'PROVIDER_IMPORT_DOCUMENTS_FAILED', requestId: 'req-1' } }, 502))
    const wait = vi.fn().mockResolvedValue(undefined)

    await expect(
      runArcimDocumentImportToCompletion('consent-1', { fetcher, wait, retryDelaysMs: [1, 2] }),
    ).rejects.toMatchObject({ status: 502, problem: { code: 'PROVIDER_IMPORT_DOCUMENTS_FAILED' } })
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it('never retries a refusal: a missing permission is an answer, not a blink', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ error: { code: PROVIDER_DOCUMENT_SCOPES_REQUIRED } }, 403))
    const wait = vi.fn().mockResolvedValue(undefined)

    await expect(
      runArcimDocumentImportToCompletion('consent-1', { fetcher, wait, retryDelaysMs: [1, 2] }),
    ).rejects.toMatchObject({ status: 403, problem: { reconnectRequired: true } })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })

  it('never retries a connection the provider refused, and offers the reconnect (B11)', async () => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse({ error: { code: 'PROVIDER_AUTH_EXPIRED' } }, 401))
    const wait = vi.fn().mockResolvedValue(undefined)

    await expect(
      runArcimDocumentImportToCompletion('consent-1', { fetcher, wait, retryDelaysMs: [1, 2] }),
    ).rejects.toMatchObject({ status: 401, problem: { code: 'PROVIDER_AUTH_EXPIRED', reconnectRequired: true } })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })

  it('continues a stopped run after its last handled file, keeping its totals', async () => {
    const stopped = result({ dryRun: false, scanned: 1897, linked: 1897, unmatched: 0, total: 3475, partial: true, nextCursor: 'file-1897' })
    const fetcher = vi.fn().mockResolvedValueOnce(
      jsonResponse({ success: true, result: result({ dryRun: false, scanned: 1578, linked: 1577, unmatched: 1, total: 3475 }) }),
    )

    const final = await runArcimDocumentImportToCompletion('consent-1', { fetcher, resumeFrom: stopped })

    expect(JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      consentId: 'consent-1',
      dryRun: false,
      cursor: 'file-1897',
    })
    expect(final).toMatchObject({ scanned: 3475, linked: 3474, unmatched: 1, total: 3475, partial: false })
  })

  it('starts from the top when the earlier run cannot be continued', async () => {
    const fetcher = vi.fn().mockImplementation(async () =>
      jsonResponse({ success: true, result: result({ dryRun: false, scanned: 7, linked: 7, total: 7 }) }),
    )

    // A finished run and a dry-run preview carry no cursor to continue from.
    await runArcimDocumentImportToCompletion('consent-1', { fetcher, resumeFrom: result({ dryRun: false }) })
    await runArcimDocumentImportToCompletion('consent-1', {
      fetcher,
      resumeFrom: result({ dryRun: true, partial: true, nextCursor: 'file-3' }),
    })

    for (const call of fetcher.mock.calls) {
      expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ consentId: 'consent-1', dryRun: false })
    }
  })

  it('keeps the import phase while recording running totals, then completes with the honest total', () => {
    const importing = arcimDocumentImportReducer(
      { phase: 'offered', provider: 'fortnox', found: 40, result: result({ dryRun: true, total: 40 }), problem: null },
      { type: 'import-started' },
    )
    const progressed = arcimDocumentImportReducer(importing, {
      type: 'import-progress',
      result: result({ dryRun: false, scanned: 17, linked: 17, total: 40, partial: true, nextCursor: 'file-17' }),
    })
    expect(progressed).toMatchObject({ phase: 'importing', result: { scanned: 17, total: 40 } })

    const complete = arcimDocumentImportReducer(progressed, {
      type: 'import-succeeded',
      result: result({ dryRun: false, scanned: 40, linked: 39, skipped: 1, total: 40 }),
    })
    expect(complete).toMatchObject({ phase: 'complete', found: 40, result: { linked: 39, skipped: 1 } })
  })
})

describe('document import progress', () => {
  const offered = arcimDocumentImportReducer(
    { phase: 'discovering', provider: 'fortnox', found: 0, result: null, problem: null },
    { type: 'discovery-succeeded', result: result({ dryRun: true, scanned: 658, total: 658 }) },
  )

  it('counts zero of the discovered total before the first slice answers', () => {
    const importing = arcimDocumentImportReducer(offered, { type: 'import-started' })

    expect(documentImportProgress(importing)).toEqual({ done: 0, total: 658 })
  })

  it('counts the running totals once a slice has answered', () => {
    const importing = arcimDocumentImportReducer(offered, { type: 'import-started' })
    const progressed = arcimDocumentImportReducer(importing, {
      type: 'import-progress',
      result: result({ dryRun: false, scanned: 277, total: 658, partial: true, nextCursor: 'file-277' }),
    })

    expect(documentImportProgress(progressed)).toEqual({ done: 277, total: 658 })
  })

  it('starts a retry from zero instead of the failed run totals', () => {
    const problem = { code: null, requestId: null, reconnectRequired: false }
    const failed = arcimDocumentImportReducer(
      {
        phase: 'importing',
        provider: 'fortnox',
        found: 658,
        result: result({ dryRun: false, scanned: 277, total: 658, partial: true, nextCursor: 'file-277' }),
        problem: null,
      },
      { type: 'import-failed', problem },
    )
    const retrying = arcimDocumentImportReducer(failed, { type: 'import-started' })

    expect(documentImportProgress(retrying)).toEqual({ done: 0, total: 658 })
  })

  it('counts on from the stopped totals when the retry continues that run', () => {
    const problem = { code: null, requestId: null, reconnectRequired: false }
    const failed = arcimDocumentImportReducer(
      {
        phase: 'importing',
        provider: 'fortnox',
        found: 658,
        result: result({ dryRun: false, scanned: 277, total: 658, partial: true, nextCursor: 'file-277' }),
        problem: null,
      },
      { type: 'import-failed', problem },
    )
    const resuming = arcimDocumentImportReducer(failed, { type: 'import-started', resumeFrom: failed.result })

    expect(documentImportProgress(resuming)).toEqual({ done: 277, total: 658 })
  })

  it('counts nothing without a known total or outside the import', () => {
    // An import resumed after a full-page OAuth redirect has no discovery count.
    const resumed = arcimDocumentImportReducer(INITIAL_ARCIM_DOCUMENT_IMPORT_STATE, { type: 'import-started' })

    expect(documentImportProgress(resumed)).toBeNull()
    expect(documentImportProgress(offered)).toBeNull()
  })
})

describe('the latest run under its connection (crm#1410)', () => {
  const run = {
    provider: 'fortnox',
    startedAt: '2026-10-22T08:53:31Z',
    updatedAt: '2026-10-22T09:20:11Z',
    complete: true,
    total: 3003,
    scanned: 3003,
    linked: 0,
    skipped: 2971,
    unmatched: 27,
    failed: 0,
    locked: 5,
    lockedPeriods: ['2020/2021'],
    unmatchedSamples: [],
    unreachableSources: [],
    nextCursor: null,
    stalled: false,
  }

  it('says how many are on their verifikat after a re-run that found nothing new, and what is left', () => {
    // A re-run links nothing new: what is there counts, not what this run added.
    expect(documentImportRunNote(run)).toEqual({
      kind: 'complete',
      date: '2026-10-22T09:20:11Z',
      present: 2971,
      total: 3003,
      unmatched: 27,
      locked: 5,
      lockedYears: '2020/2021',
      failed: 0,
      unreachable: false,
    })
  })

  it('tells a run that stopped from one still moving (crm#1409)', () => {
    const unfinished = { ...run, complete: false, scanned: 1897, total: 3475, nextCursor: 'file-1897' }

    expect(documentImportRunNote({ ...unfinished, stalled: true })).toEqual({
      kind: 'stopped', date: '2026-10-22T09:20:11Z', scanned: 1897, total: 3475,
    })
    expect(documentImportRunNote(unfinished)).toMatchObject({ kind: 'running', scanned: 1897 })
  })

  it('says a silent run the server picks up again goes on by itself (crm#1581)', () => {
    const silent = { ...run, complete: false, scanned: 2740, total: 17219, nextCursor: 'file-2740', stalled: true }

    expect(documentImportRunNote({ ...silent, continuesOnServer: true })).toEqual({
      kind: 'resuming', date: '2026-10-22T09:20:11Z', scanned: 2740, total: 17219,
    })
    // Only "Hämta underlag" moves one the server leaves, or one an older server described.
    expect(documentImportRunNote({ ...silent, continuesOnServer: false })).toMatchObject({ kind: 'stopped' })
    expect(documentImportRunNote(silent)).toMatchObject({ kind: 'stopped' })
    // A run still moving is running, whoever drives it.
    expect(documentImportRunNote({ ...silent, stalled: false, continuesOnServer: true })).toMatchObject({ kind: 'running' })
  })

  it('says a run the provider refused waits for a reconnect, before calling it stopped (B11)', () => {
    const refused = { ...run, complete: false, scanned: 1200, total: 4610, nextCursor: 'file-1200', needsReconnect: true }

    expect(documentImportRunNote({ ...refused, stalled: true })).toEqual({
      kind: 'reconnect', date: '2026-10-22T09:20:11Z', provider: 'fortnox',
    })
    // A finished run never asks for one, whatever an older mark said.
    expect(documentImportRunNote({ ...run, needsReconnect: true })).toMatchObject({ kind: 'complete' })
  })

  it('says nothing before any run was recorded', () => {
    expect(documentImportRunNote(null)).toBeNull()
    expect(documentImportRunNote(undefined)).toBeNull()
  })
})

describe('a run the server kept, after a reload (crm#1581)', () => {
  // A Fortnox sweep that stopped at 2 740 of 17 219 files, its tab long gone.
  const kept: DocumentImportRunStatus = {
    provider: 'fortnox',
    startedAt: '2026-10-31T11:02:00Z',
    updatedAt: '2026-10-31T19:40:00Z',
    complete: false,
    total: 17219,
    scanned: 2740,
    linked: 2731,
    skipped: 0,
    unmatched: 9,
    failed: 0,
    locked: 0,
    lockedPeriods: [],
    unmatchedSamples: [],
    unreachableSources: [],
    nextCursor: 'file-02740',
    stalled: true,
  }
  // Connected and migrated that morning, before the sweep started.
  const status = {
    consents: [{ id: 'consent-1', provider: 'fortnox', createdAt: '2026-10-31T09:15:00Z' }],
    latestCompletedSieImport: { imported_at: '2026-10-31T10:40:00Z', created_at: '2026-10-31T10:31:00Z' },
    latestDocumentImport: kept,
  }

  /** The two routes the page calls: the status it reads, then one slice per call. */
  function server(slices: ArcimDocumentImportResult[], body: unknown = status) {
    return vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      url === ARCIM_MIGRATION_STATUS_ENDPOINT
        ? jsonResponse(body)
        : jsonResponse({ success: true, result: slices.shift() }),
    )
  }

  const importBodies = (fetcher: ReturnType<typeof server>) =>
    fetcher.mock.calls
      .filter(([url]) => url === ARCIM_DOCUMENT_IMPORT_ENDPOINT)
      .map(([, init]) => JSON.parse(init?.body as string))

  it('continues after the last file the stopped run handled instead of downloading the first 2 740 again', async () => {
    const fetcher = server([
      result({ dryRun: false, scanned: 7000, linked: 7000, unmatched: 0, total: 17219, partial: true, nextCursor: 'file-09740' }),
      result({ dryRun: false, scanned: 7479, linked: 7470, unmatched: 9, total: 17219 }),
    ])

    const resumeFrom = await fetchResumableDocumentImport('consent-1', fetcher)
    const final = await runArcimDocumentImportToCompletion('consent-1', { fetcher, resumeFrom })

    // With the kept run's id, so the server continues that run from its saved point.
    expect(importBodies(fetcher)).toEqual([
      { consentId: 'consent-1', dryRun: false, cursor: 'file-02740', run: kept.startedAt },
      { consentId: 'consent-1', dryRun: false, cursor: 'file-09740', run: kept.startedAt },
    ])
    expect(final).toMatchObject({ scanned: 17219, linked: 17201, unmatched: 18, total: 17219, partial: false })
  })

  it('counts on from where the kept run stopped while the first slice runs', () => {
    const offered = arcimDocumentImportReducer(
      { phase: 'discovering', provider: 'fortnox', found: 0, result: null, problem: null },
      { type: 'discovery-succeeded', result: result({ dryRun: true, scanned: 17219, total: 17219 }) },
    )
    const importing = arcimDocumentImportReducer(offered, { type: 'import-started' })
    const resumeAt = resumableDocumentImportRun(kept, 'fortnox')
    expect(resumeAt).not.toBeNull()
    const resumed = arcimDocumentImportReducer(importing, { type: 'import-progress', result: resumeAt as ArcimDocumentImportResult })

    expect(documentImportProgress(resumed)).toEqual({ done: 2740, total: 17219 })
  })

  it('sends the cursor the server stopped at, so the kept summary takes the slice as the same run', () => {
    const resumeAt = resumableDocumentImportRun(kept, 'fortnox')
    const slice = {
      ...result({ dryRun: false, scanned: 7000, linked: 7000, unmatched: 0, total: 17219, partial: true, nextCursor: 'file-09740' }),
      unmatchedSamples: [],
      unreachableSources: [],
    }

    const folded = foldDocumentImportSlice(kept, slice, resumeAt?.nextCursor ?? null, '2026-11-01T09:00:00Z')

    expect(folded).toMatchObject({
      startedAt: kept.startedAt,
      scanned: 9740,
      linked: 9731,
      complete: false,
      nextCursor: 'file-09740',
    })
  })

  it('continues a run the provider refused once the connection answers again (B11)', () => {
    expect(resumableDocumentImportRun({ ...kept, needsReconnect: true }, 'fortnox')).toMatchObject({
      scanned: 2740,
      nextCursor: 'file-02740',
      partial: true,
      dryRun: false,
    })
  })

  it('starts from the top when there is nothing of this provider to continue', () => {
    expect(resumableDocumentImportRun({ ...kept, complete: true, nextCursor: null }, 'fortnox')).toBeNull()
    expect(resumableDocumentImportRun(kept, 'bokio')).toBeNull()
    // Refused on its first slice: no file was handled, so no cursor.
    expect(resumableDocumentImportRun({ ...kept, scanned: 0, nextCursor: null, needsReconnect: true }, 'fortnox')).toBeNull()
    expect(resumableDocumentImportRun(null, 'fortnox')).toBeNull()
    expect(resumableDocumentImportRun(undefined, 'fortnox')).toBeNull()
  })

  it('starts from the top when the files below the cursor may have changed since the run started', async () => {
    // Another Fortnox database connected after the run: its ids are not the run's.
    const reconnectedElsewhere = server([], {
      ...status,
      consents: [{ id: 'consent-2', provider: 'fortnox', createdAt: '2026-11-01T08:00:00Z' }],
    })
    // A ledger import after the run started: files it left unmatched may match now.
    const ledgerSince = server([], {
      ...status,
      latestCompletedSieImport: { imported_at: '2026-11-01T07:30:00Z', created_at: '2026-11-01T07:29:00Z' },
    })

    await expect(fetchResumableDocumentImport('consent-2', reconnectedElsewhere)).resolves.toBeNull()
    await expect(fetchResumableDocumentImport('consent-1', ledgerSince)).resolves.toBeNull()
    // A connection the status does not list (gone, or another company's).
    await expect(fetchResumableDocumentImport('consent-9', server([]))).resolves.toBeNull()
  })

  it('starts from the top when the server cannot say where the run stands', async () => {
    const down = vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500))
    const offline = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const older = server([], { consents: status.consents })

    await expect(fetchResumableDocumentImport('consent-1', down)).resolves.toBeNull()
    await expect(fetchResumableDocumentImport('consent-1', offline)).resolves.toBeNull()
    await expect(fetchResumableDocumentImport('consent-1', older)).resolves.toBeNull()
  })
})

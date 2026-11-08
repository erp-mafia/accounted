import { describe, expect, it, vi } from 'vitest'
import {
  ARCIM_DOCUMENT_IMPORT_STALLED,
  ARCIM_DOCUMENT_OAUTH_RESUME_KEY,
  INITIAL_ARCIM_DOCUMENT_IMPORT_STATE,
  PROVIDER_DOCUMENT_SCOPES_REQUIRED,
  PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE,
  ArcimDocumentImportRequestError,
  arcimDocumentImportReducer,
  documentOAuthProblemFromReason,
  parseArcimDocumentResumeMarker,
  mergeArcimDocumentImportResults,
  requestArcimDocumentImport,
  resolveArcimDocumentFollowUpProvider,
  runArcimDocumentImportToCompletion,
  runArcimDocumentDiscoveryToCompletion,
  serializeArcimDocumentResumeMarker,
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
    locked: 0,
    lockedPeriods: [],
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

describe('document follow-up state', () => {
  it('offers the prompt after a successful Fortnox migration using the remaining import count', () => {
    const discovering = arcimDocumentImportReducer(
      INITIAL_ARCIM_DOCUMENT_IMPORT_STATE,
      { type: 'discovery-started', provider: 'fortnox', migrationSucceeded: true },
    )
    const offered = arcimDocumentImportReducer(discovering, {
      type: 'discovery-succeeded',
      result: result({ scanned: 7, linked: 5, unmatched: 2 }),
    })

    expect(offered.phase).toBe('offered')
    expect(offered.found).toBe(5)
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

    expect(offered).toMatchObject({ phase: 'offered', provider: 'bokio', found: 10 })
  })

  it('does not offer a new import when all source documents are already handled', () => {
    const state = arcimDocumentImportReducer(INITIAL_ARCIM_DOCUMENT_IMPORT_STATE, {
      type: 'discovery-succeeded', result: result({ scanned: 1376, total: 1376, linked: 0, skipped: 1376, unmatched: 0 }),
    })
    expect(state).toMatchObject({ phase: 'empty', found: 0, result: { skipped: 1376 } })
  })

  it('offers only remaining files while retaining existing and unmatched counts', () => {
    const state = arcimDocumentImportReducer(INITIAL_ARCIM_DOCUMENT_IMPORT_STATE, {
      type: 'discovery-succeeded', result: result({ scanned: 1376, total: 1376, linked: 2, skipped: 1373, unmatched: 1 }),
    })
    expect(state).toMatchObject({ phase: 'offered', found: 2, result: { skipped: 1373, unmatched: 1 } })
  })

  it.each([{ unmatched: 1 }, { locked: 1 }, { failed: 1 }])('keeps unresolved outcomes visible with no new files: %o', outcome => {
    const state = arcimDocumentImportReducer(INITIAL_ARCIM_DOCUMENT_IMPORT_STATE, {
      type: 'discovery-succeeded', result: result({ scanned: 2, linked: 0, skipped: 1, unmatched: 0, ...outcome }),
    })
    expect(state).toMatchObject({ phase: 'offered', found: 0 })
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

  it('sums locked receipts across slices and keeps each locked year once, oldest first', () => {
    const merged = mergeArcimDocumentImportResults(
      result({ locked: 3, lockedPeriods: ['2024', '2025'] }),
      result({ locked: 2, lockedPeriods: ['2022/2023', '2024'] }),
    )

    expect(merged).toMatchObject({ locked: 5, lockedPeriods: ['2022/2023', '2024', '2025'] })
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
      { consentId: 'consent-1', dryRun: false, progress:true },
      { consentId: 'consent-1', dryRun: false, cursor: 'file-17', progress:true },
      { consentId: 'consent-1', dryRun: false, cursor: 'file-34', progress:true },
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

describe('live document progress',()=>{
  const frame=(type:string,value:unknown)=>new TextEncoder().encode(`data: ${JSON.stringify(type==='error'?{type,payload:value}:{type,result:value})}\n\n`)
  it('reports completed files before the response has finished, with split UTF-8 frames',async()=>{
    let controller!:ReadableStreamDefaultController<Uint8Array>
    const body=new ReadableStream<Uint8Array>({start(c){controller=c}})
    const fetcher=vi.fn().mockResolvedValue(new Response(body,{headers:{'Content-Type':'text/event-stream'}}))
    const progress=vi.fn();let finished=false
    const pending=requestArcimDocumentImport('consent',false,fetcher,undefined,progress).then(value=>{finished=true;return value})
    const live=frame('progress',result({dryRun:false,scanned:10,total:1376,linked:8,skipped:2,unmatchedSamples:[{uploadId:'åäö',voucher:'A1',date:'2026-01-01'}]}))
    const split=live.findIndex((value,index)=>value===0xc3&&live[index+1]===0xa5)+1
    controller.enqueue(live.slice(0,split));controller.enqueue(live.slice(split))
    await vi.waitFor(()=>expect(progress).toHaveBeenCalledWith(expect.objectContaining({scanned:10,total:1376})))
    expect(finished).toBe(false)
    expect(progress.mock.calls[0][0].unmatchedSamples[0].uploadId).toBe('åäö')
    controller.enqueue(frame('complete',result({dryRun:false,scanned:1376,total:1376,linked:1376})));controller.close()
    expect(await pending).toMatchObject({scanned:1376,total:1376})
    expect(JSON.parse(fetcher.mock.calls[0][1].body).progress).toBe(true)
  })
  it('does not claim completion when a progress stream is truncated',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(frame('progress',result({dryRun:false,scanned:1,total:10})),{headers:{'Content-Type':'text/event-stream'}}))
    await expect(requestArcimDocumentImport('consent',false,fetcher,undefined,vi.fn())).rejects.toBeInstanceOf(ArcimDocumentImportRequestError)
  })
  it('preserves the structured failure after partial progress',async()=>{
    const bytes=new Uint8Array([...frame('progress',result({dryRun:false,scanned:5,total:10})),...frame('error',{error:{code:'PROVIDER_AUTH_EXPIRED',requestId:'req-stream'}})])
    const fetcher=vi.fn().mockResolvedValue(new Response(bytes,{headers:{'Content-Type':'text/event-stream'}}))
    const error=await requestArcimDocumentImport('consent',false,fetcher,undefined,vi.fn()).catch(e=>e)
    expect(error.problem).toMatchObject({code:'PROVIDER_AUTH_EXPIRED',requestId:'req-stream'})
  })
  it('adds each streamed slice to prior completed slices without counting progress twice',async()=>{
    const response=(progress:number,partial:boolean)=>new Response(new Uint8Array([
      ...frame('progress',result({dryRun:false,scanned:progress,linked:progress,total:20})),
      ...frame('complete',result({dryRun:false,scanned:10,linked:10,total:20,partial,nextCursor:partial?'file-10':null})),
    ]),{headers:{'Content-Type':'text/event-stream'}})
    const fetcher=vi.fn().mockResolvedValueOnce(response(5,true)).mockResolvedValueOnce(response(5,false))
    const progress=vi.fn()
    expect(await runArcimDocumentImportToCompletion('consent',{fetcher,onProgress:progress})).toMatchObject({scanned:20,linked:20})
    expect(progress.mock.calls.map(([value])=>value.scanned)).toEqual([5,10,15])
  })
  it('starts real import counters at zero while retaining the discovered total',()=>{
    const state=arcimDocumentImportReducer({phase:'offered',provider:'bokio',found:1376,result:result({dryRun:true,scanned:1376,linked:1376,total:1376}),problem:null},{type:'import-started'})
    expect(state.result).toMatchObject({dryRun:false,total:1376,scanned:0,linked:0})
  })
})

describe('complete document discovery', () => {
  it('checks remaining read-only slices before concluding everything is already imported', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ result: result({
      scanned: 1, linked: 0, skipped: 1, unmatched: 0, total: 2, partial: true, nextCursor: 'a',
    }) })).mockResolvedValueOnce(jsonResponse({ result: result({
      scanned: 1, linked: 1, skipped: 0, unmatched: 0, total: 2,
    }) }))
    const discovery = await runArcimDocumentDiscoveryToCompletion('c1', fetcher)
    expect(discovery).toMatchObject({ scanned: 2, linked: 1, skipped: 1, dryRun: true, partial: false })
    expect(fetcher.mock.calls.map(call => JSON.parse(call[1].body))).toEqual([
      { consentId: 'c1', dryRun: true }, { consentId: 'c1', dryRun: true, cursor: 'a' },
    ])
  })
})

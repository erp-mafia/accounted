import { describe, expect, it, vi } from 'vitest'
import {
  mergeArcimDocumentImportResults,
  runArcimDocumentImportToCompletion,
  type ArcimDocumentImportResult,
} from '../arcim-document-import-flow'

// The run id the server hands back with every slice, and the tab sends back
// with the next one, so the server continues its own run from the point it
// saved even after an answer the tab never got (crm#1581).

function slice(overrides: Partial<ArcimDocumentImportResult> = {}): ArcimDocumentImportResult {
  return {
    provider: 'fortnox',
    scanned: 10,
    linked: 10,
    skipped: 0,
    unmatched: 0,
    failed: 0,
    locked: 0,
    lockedPeriods: [],
    dryRun: false,
    unmatchedSamples: [],
    total: 30,
    partial: true,
    nextCursor: 'file-10',
    unreachableSources: [],
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function bodiesOf(fetcher: ReturnType<typeof vi.fn>) {
  return fetcher.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string))
}

describe('the run id between tab and server (crm#1581)', () => {
  it('sends none with the first slice and the run id of the latest answer with every slice after it', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: slice({ run: 'run-1' }) }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: slice({ nextCursor: 'file-20', run: 'run-1' }) }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: slice({ partial: false, nextCursor: null, run: 'run-1' }) }))

    const final = await runArcimDocumentImportToCompletion('consent-1', { fetcher })

    expect(bodiesOf(fetcher)).toEqual([
      { consentId: 'consent-1', dryRun: false },
      { consentId: 'consent-1', dryRun: false, cursor: 'file-10', run: 'run-1' },
      { consentId: 'consent-1', dryRun: false, cursor: 'file-20', run: 'run-1' },
    ])
    expect(final).toMatchObject({ scanned: 30, partial: false, run: 'run-1' })
  })

  it('retries a slice whose answer was lost with the run id, so the server can continue its run', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: slice({ run: 'run-1' }) }))
      // The laptop slept: the answer to the slice from file-10 never arrived.
      .mockRejectedValueOnce(new TypeError('NetworkError when attempting to fetch resource.'))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: slice({ partial: false, nextCursor: null, run: 'run-1' }) }))

    await runArcimDocumentImportToCompletion('consent-1', { fetcher, wait: async () => undefined })

    expect(bodiesOf(fetcher).slice(1)).toEqual([
      { consentId: 'consent-1', dryRun: false, cursor: 'file-10', run: 'run-1' },
      { consentId: 'consent-1', dryRun: false, cursor: 'file-10', run: 'run-1' },
    ])
  })

  it('continues a resumed import with the run id it kept', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: slice({ partial: false, nextCursor: null, run: 'run-1' }) }))

    await runArcimDocumentImportToCompletion('consent-1', {
      fetcher,
      resumeFrom: slice({ nextCursor: 'file-10', run: 'run-1' }),
    })

    expect(bodiesOf(fetcher)).toEqual([{ consentId: 'consent-1', dryRun: false, cursor: 'file-10', run: 'run-1' }])
  })

  it('keeps the last run id when an answer carries none (an older server)', () => {
    const merged = mergeArcimDocumentImportResults(slice({ run: 'run-1' }), slice({ nextCursor: 'file-20' }))

    expect(merged.run).toBe('run-1')
  })
})

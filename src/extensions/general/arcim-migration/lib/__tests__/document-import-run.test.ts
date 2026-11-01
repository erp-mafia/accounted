import { describe, expect, it, vi } from 'vitest'
import type { ExtensionSettings } from '@/lib/extensions/types'
import type { ImportDocumentsResult } from '../import-documents'
import {
  DOCUMENT_IMPORT_RUN_KEY,
  continuationCursor,
  documentImportRunStatus,
  foldDocumentImportSlice,
  markDocumentImportNeedsReconnect,
  readDocumentImportRun,
  recordDocumentImportNeedsReconnect,
  recordDocumentImportSlice,
  type DocumentImportRunSummary,
} from '../document-import-run'

function slice(overrides: Partial<ImportDocumentsResult> = {}): ImportDocumentsResult {
  return {
    provider: 'fortnox',
    scanned: 40,
    linked: 38,
    skipped: 1,
    unmatched: 1,
    failed: 0,
    locked: 0,
    lockedPeriods: [],
    dryRun: false,
    unmatchedSamples: [{ uploadId: 'file-9', voucher: 'A9', date: '2026-01-01', reason: 'no_verifikat' }],
    total: 100,
    partial: true,
    nextCursor: 'file-40',
    unreachableSources: [],
    ...overrides,
  }
}

/** extension_data as a key-value map, the way the settings accessor reads it. */
function memorySettings(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial))
  const settings: ExtensionSettings = {
    get: vi.fn(async (key?: string) => (store.get(key ?? 'settings') ?? null) as never),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value)
    }),
    clear: vi.fn(async (key: string) => {
      store.delete(key)
    }),
  }
  return { settings, store }
}

describe('foldDocumentImportSlice', () => {
  it('starts a summary from the first slice of a run', () => {
    const summary = foldDocumentImportSlice(null, slice(), null, '2026-10-21T19:09:52Z')

    expect(summary).toMatchObject({
      provider: 'fortnox',
      startedAt: '2026-10-21T19:09:52Z',
      updatedAt: '2026-10-21T19:09:52Z',
      complete: false,
      total: 100,
      scanned: 40,
      linked: 38,
      nextCursor: 'file-40',
    })
  })

  it('adds a slice that continues where the summary stopped, and marks the end', () => {
    const first = foldDocumentImportSlice(null, slice({ lockedPeriods: ['2021'] }), null, 't1')
    const second = foldDocumentImportSlice(
      first,
      slice({
        scanned: 60, linked: 50, skipped: 2, unmatched: 3, locked: 5, lockedPeriods: ['2020/2021', '2021'],
        partial: false, nextCursor: null,
      }),
      'file-40',
      't2',
    )

    expect(second).toMatchObject({
      startedAt: 't1',
      updatedAt: 't2',
      complete: true,
      total: 100,
      scanned: 100,
      linked: 88,
      skipped: 3,
      unmatched: 4,
      locked: 5,
      lockedPeriods: ['2020/2021', '2021'],
      nextCursor: null,
    })
  })

  it('ignores a slice that would count files twice, or that has no unfinished run to join', () => {
    const first = foldDocumentImportSlice(null, slice(), null, 't1')

    // The summary reached file-40: a slice from file-20 overlaps what it counted.
    expect(foldDocumentImportSlice(first, slice(), 'file-20', 't2')).toBeNull()
    // Nothing recorded yet: a resumed slice has no run to join.
    expect(foldDocumentImportSlice(null, slice(), 'file-40', 't2')).toBeNull()
    // A finished run takes no more slices.
    const done = foldDocumentImportSlice(null, slice({ partial: false, nextCursor: null }), null, 't1')
    expect(foldDocumentImportSlice(done, slice(), 'file-40', 't2')).toBeNull()
  })

  it("joins the run's own slice that starts past its point (an earlier fold was not stored)", () => {
    const first = foldDocumentImportSlice(null, slice(), null, 't1')

    // The run id the tab sends back is the run's startedAt.
    expect(foldDocumentImportSlice(first, slice({ nextCursor: 'file-90' }), 'file-60', 't2', 't1')).toMatchObject({
      startedAt: 't1',
      scanned: 80,
      nextCursor: 'file-90',
    })
    // Without the run id, or with another run's, only the exact point joins.
    expect(foldDocumentImportSlice(first, slice({ nextCursor: 'file-90' }), 'file-60', 't2')).toBeNull()
    expect(foldDocumentImportSlice(first, slice({ nextCursor: 'file-90' }), 'file-60', 't2', 't0')).toBeNull()
  })

  it('leaves a newer run alone when a tab still looping on an older run sends a slice (review of !1172)', () => {
    // Run t0 reached file-600; then run t1 started from the top and reached file-200.
    const older = foldDocumentImportSlice(null, slice({ nextCursor: 'file-600' }), null, 't0')
    const newer = foldDocumentImportSlice(older, slice({ nextCursor: 'file-200' }), null, 't1')

    // The older run's tab continues from file-600. Joining would move the
    // newer run past file-200..file-600, files it has not handled.
    expect(foldDocumentImportSlice(newer, slice({ nextCursor: 'file-800' }), 'file-600', 't2', 't0')).toBeNull()
    expect(foldDocumentImportSlice(newer, slice({ nextCursor: 'file-800' }), 'file-600', 't2')).toBeNull()
  })

  it('ignores a slice of another provider', () => {
    const first = foldDocumentImportSlice(null, slice(), null, 't1')

    expect(foldDocumentImportSlice(first, slice({ provider: 'bokio' }), 'file-40', 't2')).toBeNull()
  })

  it('replaces the summary when a run starts from the top again', () => {
    const old = foldDocumentImportSlice(null, slice({ linked: 2939, partial: false, nextCursor: null }), null, 't1')
    const fresh = foldDocumentImportSlice(old, slice({ linked: 0, skipped: 40 }), null, 't2')

    expect(fresh).toMatchObject({ startedAt: 't2', linked: 0, skipped: 40, complete: false })
  })

  it('never records a dry run', () => {
    expect(foldDocumentImportSlice(null, slice({ dryRun: true }), null, 't1')).toBeNull()
  })

  it('keeps one unreachable source per scope and at most twenty unmatched samples', () => {
    const samples = Array.from({ length: 15 }, (_, i) => ({
      uploadId: `file-${i}`, voucher: `A${i}`, date: '2026-01-01', reason: 'no_verifikat' as const,
    }))
    const first = foldDocumentImportSlice(
      null,
      slice({
        unmatchedSamples: samples,
        unreachableSources: [{ source: 'supplier_invoice_files', scope: 'supplierinvoice', reason: 'error', providerMessage: null }],
      }),
      null,
      't1',
    )
    const second = foldDocumentImportSlice(
      first,
      slice({
        unmatchedSamples: samples,
        unreachableSources: [{ source: 'supplier_invoice_files', scope: 'supplierinvoice', reason: 'permission', providerMessage: 'Saknar behörighet' }],
      }),
      'file-40',
      't2',
    )

    expect(second?.unmatchedSamples).toHaveLength(20)
    expect(second?.unreachableSources).toEqual([
      { source: 'supplier_invoice_files', scope: 'supplierinvoice', reason: 'permission', providerMessage: 'Saknar behörighet' },
    ])
  })
})

describe('continuationCursor', () => {
  const saved = { provider: 'fortnox', complete: false, nextCursor: 'file-80' }

  it('starts at the point the saved run reached when the tab asks for an earlier one', () => {
    expect(continuationCursor(saved, 'fortnox', 'file-40')).toBe('file-80')
  })

  it('keeps the tab cursor when it is at or past the saved point', () => {
    expect(continuationCursor(saved, 'fortnox', 'file-80')).toBe('file-80')
    expect(continuationCursor(saved, 'fortnox', 'file-95')).toBe('file-95')
  })

  it('keeps the tab cursor for a new run, a finished run, another provider or no saved run', () => {
    expect(continuationCursor(saved, 'fortnox', null)).toBeNull()
    expect(continuationCursor({ ...saved, complete: true, nextCursor: null }, 'fortnox', 'file-40')).toBe('file-40')
    expect(continuationCursor(saved, 'bokio', 'file-40')).toBe('file-40')
    expect(continuationCursor({ ...saved, nextCursor: null }, 'fortnox', 'file-40')).toBe('file-40')
    expect(continuationCursor(null, 'fortnox', 'file-40')).toBe('file-40')
  })
})

describe('a slice the tab retries after losing its answer (crm#1581)', () => {
  it('keeps counting the run instead of freezing at the slice whose answer was lost', async () => {
    const { settings } = memorySettings()
    // Slice 1 answered and started run t1: the run reached file-040, and the
    // answer gave the tab the run id t1. (Ids zero-padded: the sweep orders them as strings.)
    const run = (await recordDocumentImportSlice(settings, slice({ nextCursor: 'file-040' }), null, 't1'))!.startedAt
    expect(run).toBe('t1')
    // Slice 2 (file-040 -> file-080) was folded, but the laptop slept before
    // the tab got the answer, so the tab still holds file-040.
    await recordDocumentImportSlice(settings, slice({ nextCursor: 'file-080' }), 'file-040', 't2', run)
    const afterLostAnswer = await readDocumentImportRun(settings)

    // On waking, the tab retries file-040. The fold alone refuses that cursor:
    // it overlaps what the run counted. This is the slice that froze the run.
    expect(foldDocumentImportSlice(afterLostAnswer, slice(), 'file-040', 't3', run)).toBeNull()

    // The route starts the run's own retry at the saved point instead, and the run takes it.
    const start = continuationCursor(afterLostAnswer, 'fortnox', 'file-040')
    expect(start).toBe('file-080')
    await recordDocumentImportSlice(settings, slice({ nextCursor: 'file-120' }), start, 't3', run)
    // The tab's next slice continues from the answer it got, file-120.
    await recordDocumentImportSlice(
      settings,
      slice({ partial: false, nextCursor: null }),
      continuationCursor(await readDocumentImportRun(settings), 'fortnox', 'file-120'),
      't4',
      run,
    )

    expect(await readDocumentImportRun(settings)).toMatchObject({
      startedAt: 't1',
      updatedAt: 't4',
      complete: true,
      scanned: 160,
      linked: 152,
      nextCursor: null,
    })
  })
})

describe('the stored summary', () => {
  it('records each slice of a run under one key and reads it back', async () => {
    const { settings, store } = memorySettings()

    await recordDocumentImportSlice(settings, slice(), null, 't1')
    await recordDocumentImportSlice(settings, slice({ partial: false, nextCursor: null }), 'file-40', 't2')

    expect(store.size).toBe(1)
    const summary = await readDocumentImportRun(settings)
    expect(summary).toMatchObject({ scanned: 80, linked: 76, complete: true, updatedAt: 't2' })
    expect(store.get(DOCUMENT_IMPORT_RUN_KEY)).toEqual(summary)
  })

  it('writes nothing for a slice that is not part of the recorded run', async () => {
    const { settings } = memorySettings()

    await recordDocumentImportSlice(settings, slice(), 'file-40', 't1')
    await recordDocumentImportSlice(settings, slice({ dryRun: true }), null, 't1')

    expect(settings.set).not.toHaveBeenCalled()
  })

  it('reads a value that is not a summary as none', async () => {
    const { settings } = memorySettings({ [DOCUMENT_IMPORT_RUN_KEY]: { provider: 'fortnox', linked: '12' } })

    await expect(readDocumentImportRun(settings)).resolves.toBeNull()
  })

  it('starts over from a value that is not a summary', async () => {
    const { settings } = memorySettings({ [DOCUMENT_IMPORT_RUN_KEY]: 'garbage' })

    await recordDocumentImportSlice(settings, slice(), null, 't1')

    const summary = (await readDocumentImportRun(settings)) as DocumentImportRunSummary
    expect(summary).toMatchObject({ scanned: 40, startedAt: 't1' })
  })
})

describe('a run the provider refused (B11)', () => {
  const running = foldDocumentImportSlice(null, slice(), null, '2026-10-22T17:49:00Z')!

  it('keeps the counts and resume point of the run it stopped, and says it waits for a reconnect', () => {
    const marked = markDocumentImportNeedsReconnect(running, 'fortnox', 'file-40', '2026-10-22T17:50:20Z')

    expect(marked).toEqual({ ...running, updatedAt: '2026-10-22T17:50:20Z', needsReconnect: true })
  })

  it('clears the mark once a slice answers again after the reconnect', () => {
    const marked = markDocumentImportNeedsReconnect(running, 'fortnox', 'file-40', '2026-10-22T17:50:20Z')
    const resumed = foldDocumentImportSlice(marked, slice({ partial: false, nextCursor: null }), 'file-40', '2026-10-22T18:30:00Z')

    expect(resumed).toMatchObject({ complete: true, scanned: 80, needsReconnect: false })
  })

  it('records a run refused before its first slice as an empty one that waits for a reconnect', () => {
    expect(markDocumentImportNeedsReconnect(running, 'bokio', null, '2026-10-23T08:00:00Z')).toMatchObject({
      provider: 'bokio',
      startedAt: '2026-10-23T08:00:00Z',
      complete: false,
      total: 0,
      scanned: 0,
      nextCursor: null,
      needsReconnect: true,
    })
  })

  it('leaves the summary alone for a refused slice of another chain', () => {
    expect(markDocumentImportNeedsReconnect(running, 'fortnox', 'file-12', '2026-10-22T17:50:20Z')).toBeNull()
  })

  it('stores the mark, and reads summaries kept before the mark existed', async () => {
    const { settings, store } = memorySettings({ [DOCUMENT_IMPORT_RUN_KEY]: running })
    expect(await readDocumentImportRun(settings)).toEqual(running)

    await recordDocumentImportNeedsReconnect(settings, 'fortnox', 'file-40', '2026-10-22T17:50:20Z')

    expect(store.get(DOCUMENT_IMPORT_RUN_KEY)).toMatchObject({ needsReconnect: true, nextCursor: 'file-40' })
  })
})

describe('documentImportRunStatus', () => {
  const unfinished = foldDocumentImportSlice(null, slice(), null, '2026-10-15T05:52:50Z') as DocumentImportRunSummary
  const at = (iso: string) => Date.parse(iso)

  it('calls an unfinished run that went silent stalled (crm#1409)', () => {
    expect(documentImportRunStatus(unfinished, at('2026-10-15T07:41:00Z')).stalled).toBe(true)
  })

  it('leaves a run that is still answering, or one that finished, unstalled', () => {
    expect(documentImportRunStatus(unfinished, at('2026-10-15T05:54:00Z')).stalled).toBe(false)
    const done = { ...unfinished, complete: true, nextCursor: null }
    expect(documentImportRunStatus(done, at('2026-10-25T00:00:00Z')).stalled).toBe(false)
  })
})

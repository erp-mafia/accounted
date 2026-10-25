import { describe, expect, it, vi } from 'vitest'
import type { ExtensionSettings } from '@/lib/extensions/types'
import type { ImportDocumentsResult } from '../import-documents'
import {
  DOCUMENT_IMPORT_RUN_KEY,
  documentImportRunStatus,
  foldDocumentImportSlice,
  readDocumentImportRun,
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

  it('ignores a slice from another chain or a retry whose first answer already landed', () => {
    const first = foldDocumentImportSlice(null, slice(), null, 't1')

    // The summary stopped at file-40: a slice from file-20 is not its next.
    expect(foldDocumentImportSlice(first, slice(), 'file-20', 't2')).toBeNull()
    // Nothing recorded yet: a resumed slice has no run to join.
    expect(foldDocumentImportSlice(null, slice(), 'file-40', 't2')).toBeNull()
    // A finished run takes no more slices.
    const done = foldDocumentImportSlice(null, slice({ partial: false, nextCursor: null }), null, 't1')
    expect(foldDocumentImportSlice(done, slice(), 'file-40', 't2')).toBeNull()
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

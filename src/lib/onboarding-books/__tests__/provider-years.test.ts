import { describe, expect, it, vi } from 'vitest'
import {
  importProviderYears,
  planProviderYears,
  providerYearsComplete,
  type ProviderFileStatus,
  type ProviderYearsInput,
} from '../provider-years'

// Fetched years, oldest first, as /sie-data returns them: each one the path
// it archived the file under, never the file. The tests only need to see
// which one was sent.
const file = (fiscalYear: number, previousImport?: { id: string } | null): ProviderFileStatus => ({
  fiscalYear,
  storagePath: `company-1/sie-intake/00000000-0000-0000-0000-00000000${fiscalYear}.se`,
  filename: `migration-sie-${fiscalYear}.se`,
  voucherCount: 10,
  ...(previousImport !== undefined ? { previousImport } : {}),
})
const fresh = (): ProviderYearsInput => ({
  fileStatuses: [file(2024), file(2025), file(2026, null)],
})
const sent = (calls: [ProviderFileStatus][]) => calls.map(([f]) => f.fiscalYear)
const ok = { success: true, errors: [] }
const reasonOf = (err: unknown) => (err instanceof Error ? err.message : 'unknown')

describe('planProviderYears', () => {
  it('leaves out the years a completed import already holds and keeps the rest index-aligned', () => {
    const plan = planProviderYears({
      fileStatuses: [file(2024, { id: 'imp-2024' }), file(2025), file(2026, { id: 'imp-2026' })],
    })
    expect(plan).toEqual({ pending: [{ index: 1, fiscalYear: 2025 }], alreadyImported: [2024, 2026] })
  })
})

describe('importProviderYears', () => {
  it('names the last year when it fails and keeps the years that landed', async () => {
    const importOne = vi.fn(async (f: ProviderFileStatus) =>
      f.fiscalYear === 2026 ? { success: false, errors: ['Konto 9000 har belopp.'] } : ok,
    )
    const outcome = await importProviderYears(fresh(), importOne, reasonOf)
    expect(sent(importOne.mock.calls)).toEqual([2024, 2025, 2026])
    expect(outcome).toEqual({
      imported: [2024, 2025],
      alreadyImported: [],
      failed: { fiscalYear: 2026, reason: 'Konto 9000 har belopp.' },
      notReached: [],
      notFetched: [],
    })
    expect(providerYearsComplete(outcome)).toBe(false)
  })

  it('on the retry after a failed last year sends only that year, not the ones already imported', async () => {
    // What /sie-data answers on the retry: the first run completed 2024 and
    // 2025. Sending either again is what the database refused (409).
    const retry: ProviderYearsInput = {
      fileStatuses: [file(2024, { id: 'imp-2024' }), file(2025, { id: 'imp-2025' }), file(2026, null)],
    }
    const importOne = vi.fn<(f: ProviderFileStatus) => Promise<typeof ok>>(async () => ok)
    const outcome = await importProviderYears(retry, importOne, reasonOf)
    expect(importOne.mock.calls.map(([f]) => f.storagePath)).toEqual([retry.fileStatuses[2].storagePath])
    expect(outcome).toEqual({ imported: [2026], alreadyImported: [2024, 2025], failed: null, notReached: [], notFetched: [] })
    expect(providerYearsComplete(outcome)).toBe(true)
  })

  it('names the year again when the retry of it fails, with the thrown reason', async () => {
    const retry: ProviderYearsInput = {
      fileStatuses: [file(2024, { id: 'imp-2024' }), file(2025, { id: 'imp-2025' }), file(2026)],
    }
    const importOne = vi.fn(async () => { throw new Error('Kontoklass 9 kan inte importeras.') })
    const outcome = await importProviderYears(retry, importOne, reasonOf)
    expect(importOne).toHaveBeenCalledTimes(1)
    expect(outcome.failed).toEqual({ fiscalYear: 2026, reason: 'Kontoklass 9 kan inte importeras.' })
    expect(outcome.alreadyImported).toEqual([2024, 2025])
    expect(providerYearsComplete(outcome)).toBe(false)
  })

  it('stops at a failed middle year and names the later ones as not reached', async () => {
    const importOne = vi.fn(async (f: ProviderFileStatus) => {
      if (f.fiscalYear === 2025) throw new Error('Räkenskapsåret är låst.')
      return ok
    })
    const outcome = await importProviderYears(fresh(), importOne, reasonOf)
    expect(sent(importOne.mock.calls)).toEqual([2024, 2025])
    expect(outcome.imported).toEqual([2024])
    expect(outcome.failed).toEqual({ fiscalYear: 2025, reason: 'Räkenskapsåret är låst.' })
    expect(outcome.notReached).toEqual([2026])
  })

  it('starts no further year once the user has left the act, and names the rest as not reached', async () => {
    let left = false
    const importOne = vi.fn(async () => {
      // The user skips while the first year runs on the server.
      left = true
      return ok
    })
    const outcome = await importProviderYears(fresh(), importOne, reasonOf, () => left)
    expect(importOne).toHaveBeenCalledTimes(1)
    expect(importOne).toHaveBeenCalledWith(file(2024))
    expect(outcome).toEqual({ imported: [2024], alreadyImported: [], failed: null, notReached: [2025, 2026], notFetched: [] })
    expect(providerYearsComplete(outcome)).toBe(false)
  })

  it('keeps a failed import with no error text as a failure', async () => {
    const outcome = await importProviderYears(fresh(), async () => ({ success: false, errors: [] }), reasonOf)
    expect(outcome.failed).toEqual({ fiscalYear: 2024, reason: '' })
    expect(outcome.notReached).toEqual([2025, 2026])
    expect(providerYearsComplete(outcome)).toBe(false)
  })

  it('is not complete when the provider did not hand over a selected year, even if every fetched file imports', async () => {
    const outcome = await importProviderYears(
      { fileStatuses: [file(2024), file(2025)], failedYears: [{ year: 2026 }] },
      async () => ok,
      reasonOf,
    )
    expect(outcome.imported).toEqual([2024, 2025])
    expect(outcome.notFetched).toEqual([2026])
    expect(providerYearsComplete(outcome)).toBe(false)
  })

  it('sends nothing when every year is already imported, and that counts as complete', async () => {
    const importOne = vi.fn(async () => ok)
    const outcome = await importProviderYears(
      { fileStatuses: [file(2024, { id: 'imp-2024' })] },
      importOne,
      reasonOf,
    )
    expect(importOne).not.toHaveBeenCalled()
    expect(outcome).toEqual({ imported: [], alreadyImported: [2024], failed: null, notReached: [], notFetched: [] })
    expect(providerYearsComplete(outcome)).toBe(true)
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  countSieVouchers,
  importProviderYears,
  planProviderYears,
  providerYearsComplete,
  type ProviderYearsInput,
} from '../provider-years'

// Three fetched years, oldest first, as /sie-data returns them. The file
// content stands in for the SIE text: the tests only need to see which one
// was sent.
const RAW = ['SIE-2024', 'SIE-2025', 'SIE-2026']
const fresh = (): ProviderYearsInput => ({
  rawContent: RAW,
  fileStatuses: [{ fiscalYear: 2024 }, { fiscalYear: 2025 }, { fiscalYear: 2026, previousImport: null }],
})
const ok = { success: true, errors: [] }
const reasonOf = (err: unknown) => (err instanceof Error ? err.message : 'unknown')

describe('planProviderYears', () => {
  it('leaves out the years a completed import already holds and keeps the rest index-aligned', () => {
    const plan = planProviderYears({
      rawContent: RAW,
      fileStatuses: [
        { fiscalYear: 2024, previousImport: { id: 'imp-2024' } },
        { fiscalYear: 2025 },
        { fiscalYear: 2026, previousImport: { id: 'imp-2026' } },
      ],
    })
    expect(plan).toEqual({ pending: [{ index: 1, fiscalYear: 2025 }], alreadyImported: [2024, 2026] })
  })

  it('imports every file when an older server sends no statuses', () => {
    expect(planProviderYears({ rawContent: RAW })).toEqual({
      pending: [{ index: 0, fiscalYear: null }, { index: 1, fiscalYear: null }, { index: 2, fiscalYear: null }],
      alreadyImported: [],
    })
  })
})

describe('importProviderYears', () => {
  it('names the last year when it fails and keeps the years that landed', async () => {
    const importOne = vi.fn(async (raw: string) =>
      raw === 'SIE-2026' ? { success: false, errors: ['Konto 9000 har belopp.'] } : ok,
    )
    const outcome = await importProviderYears(fresh(), importOne, reasonOf)
    expect(importOne.mock.calls.map(([raw]) => raw)).toEqual(RAW)
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
      rawContent: RAW,
      fileStatuses: [
        { fiscalYear: 2024, previousImport: { id: 'imp-2024' } },
        { fiscalYear: 2025, previousImport: { id: 'imp-2025' } },
        { fiscalYear: 2026, previousImport: null },
      ],
    }
    const importOne = vi.fn<(raw: string) => Promise<typeof ok>>(async () => ok)
    const outcome = await importProviderYears(retry, importOne, reasonOf)
    expect(importOne.mock.calls.map(([raw]) => raw)).toEqual(['SIE-2026'])
    expect(outcome).toEqual({ imported: [2026], alreadyImported: [2024, 2025], failed: null, notReached: [], notFetched: [] })
    expect(providerYearsComplete(outcome)).toBe(true)
  })

  it('names the year again when the retry of it fails, with the thrown reason', async () => {
    const retry: ProviderYearsInput = {
      rawContent: RAW,
      fileStatuses: [
        { fiscalYear: 2024, previousImport: { id: 'imp-2024' } },
        { fiscalYear: 2025, previousImport: { id: 'imp-2025' } },
        { fiscalYear: 2026 },
      ],
    }
    const importOne = vi.fn(async () => { throw new Error('Kontoklass 9 kan inte importeras.') })
    const outcome = await importProviderYears(retry, importOne, reasonOf)
    expect(importOne).toHaveBeenCalledTimes(1)
    expect(outcome.failed).toEqual({ fiscalYear: 2026, reason: 'Kontoklass 9 kan inte importeras.' })
    expect(outcome.alreadyImported).toEqual([2024, 2025])
    expect(providerYearsComplete(outcome)).toBe(false)
  })

  it('stops at a failed middle year and names the later ones as not reached', async () => {
    const importOne = vi.fn(async (raw: string) => {
      if (raw === 'SIE-2025') throw new Error('Räkenskapsåret är låst.')
      return ok
    })
    const outcome = await importProviderYears(fresh(), importOne, reasonOf)
    expect(importOne.mock.calls.map(([raw]) => raw)).toEqual(['SIE-2024', 'SIE-2025'])
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
    expect(importOne).toHaveBeenCalledWith('SIE-2024')
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
      { rawContent: RAW.slice(0, 2), fileStatuses: [{ fiscalYear: 2024 }, { fiscalYear: 2025 }], failedYears: [{ year: 2026 }] },
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
      { rawContent: RAW.slice(0, 1), fileStatuses: [{ fiscalYear: 2024, previousImport: { id: 'imp-2024' } }] },
      importOne,
      reasonOf,
    )
    expect(importOne).not.toHaveBeenCalled()
    expect(outcome).toEqual({ imported: [], alreadyImported: [2024], failed: null, notReached: [], notFetched: [] })
    expect(providerYearsComplete(outcome)).toBe(true)
  })
})

describe('countSieVouchers', () => {
  it('counts #VER records only, with CRLF line ends and indentation', () => {
    const sie = [
      '#FLAGGA 0',
      '#RAR 0 20260101 20261231',
      '#VER A 1 20260105 "Hyra"',
      '{',
      '   #TRANS 5010 {} 1000.00',
      '   #TRANS 1930 {} -1000.00',
      '}',
      '  #VER A 2 20260106 "Kaffe"',
      '{',
      '}',
    ].join('\r\n')
    expect(countSieVouchers(sie)).toBe(2)
    expect(countSieVouchers('')).toBe(0)
  })
})

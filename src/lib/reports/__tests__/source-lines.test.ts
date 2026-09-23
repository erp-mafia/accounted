/**
 * Compile-time checks for the report drilldown source-line contract plus
 * runtime tests for the createSourceLoader helper used by the expansion UI.
 */
import { describe, it, expect, vi } from 'vitest'
import type {
  ReportSourceLine,
  ReportSourceFetcher,
  ReportSourceResponse,
  SourceLoaderState,
} from '@/lib/reports/source-lines'
import { createSourceLoader } from '@/lib/reports/source-lines'

describe('source-lines types', () => {
  it('ReportSourceLine has the documented fields', () => {
    const line: ReportSourceLine = {
      journal_entry_id: 'je-1',
      voucher_number: 1,
      voucher_series: 'A',
      date: '2026-01-01',
      description: 'desc',
      debit: 0,
      credit: 100,
    }
    expect(line.journal_entry_id).toBe('je-1')
    expect(line.voucher_series + line.voucher_number).toBe('A1')
  })

  it('ReportSourceFetcher resolves a lines+cursor envelope', async () => {
    const fetcher: ReportSourceFetcher = async () => ({
      lines: [],
      next_cursor: null,
    })
    const result = await fetcher()
    expect(result.lines).toEqual([])
    expect(result.next_cursor).toBeNull()
  })

  it('ReportSourceResponse accepts every keyed report variant', () => {
    const tb: ReportSourceResponse = {
      account_number: '1930',
      account_name: 'Företagskonto',
      lines: [],
      next_cursor: null,
    }
    const vat: ReportSourceResponse = {
      ruta: 'ruta10',
      lines: [],
      next_cursor: null,
    }
    const ar: ReportSourceResponse = {
      customer_id: 'c-1',
      lines: [],
      next_cursor: null,
    }
    const sup: ReportSourceResponse = {
      supplier_id: 's-1',
      lines: [],
      next_cursor: null,
    }
    expect(tb.lines).toEqual(vat.lines)
    expect(ar.lines).toEqual(sup.lines)
  })
})

describe('createSourceLoader', () => {
  const makeLine = (
    overrides: Partial<ReportSourceLine> = {}
  ): ReportSourceLine => ({
    journal_entry_id: 'je-1',
    voucher_number: 1,
    voucher_series: 'A',
    date: '2026-01-01',
    description: 'desc',
    debit: 100,
    credit: 0,
    ...overrides,
  })

  it('starts in idle state and transitions through loading → success', async () => {
    const fetcher: ReportSourceFetcher = vi
      .fn()
      .mockResolvedValueOnce({ lines: [makeLine()], next_cursor: null })

    const states: SourceLoaderState[] = []
    const loader = createSourceLoader(fetcher, (s) => states.push({ ...s }))

    expect(loader.getState()).toEqual({ lines: null, loading: false, error: null })

    await loader.load()

    expect(states[0]).toEqual({ lines: null, loading: true, error: null })
    const last = states[states.length - 1]
    expect(last.loading).toBe(false)
    expect(last.error).toBeNull()
    expect(last.lines).toHaveLength(1)
    expect(last.lines?.[0].voucher_number).toBe(1)
  })

  it('captures fetcher errors and surfaces them as Swedish messages', async () => {
    const fetcher: ReportSourceFetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
    const loader = createSourceLoader(fetcher, () => {})
    await loader.load()
    const state = loader.getState()
    expect(state.loading).toBe(false)
    expect(state.error).toBe('boom')
    expect(state.lines).toBeNull()
  })

  it('falls back to a Swedish error when the rejection is not an Error', async () => {
    const fetcher: ReportSourceFetcher = vi.fn().mockRejectedValueOnce('nope')
    const loader = createSourceLoader(fetcher, () => {})
    await loader.load()
    expect(loader.getState().error).toBe('Kunde inte hämta verifikat')
  })

  it('caches results: a second load() is a no-op', async () => {
    const fetcher: ReportSourceFetcher = vi
      .fn()
      .mockResolvedValue({ lines: [makeLine()], next_cursor: null })
    const loader = createSourceLoader(fetcher, () => {})
    await loader.load()
    await loader.load()
    await loader.load()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not start a second concurrent load while one is in flight', async () => {
    let resolveFetch: (value: { lines: ReportSourceLine[]; next_cursor: null }) => void = () => {}
    const pending = new Promise<{ lines: ReportSourceLine[]; next_cursor: null }>(
      (r) => { resolveFetch = r }
    )
    const fetcher: ReportSourceFetcher = vi.fn().mockReturnValueOnce(pending)
    const loader = createSourceLoader(fetcher, () => {})

    const first = loader.load()
    // Second invocation before resolution should be a no-op.
    const second = loader.load()
    resolveFetch({ lines: [], next_cursor: null })
    await Promise.all([first, second])

    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

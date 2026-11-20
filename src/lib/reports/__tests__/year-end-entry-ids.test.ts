import { describe, it, expect, vi } from 'vitest'
import { excludeYearEndChain, fetchYearEndEntryIds } from '../trial-balance'

// The 'exclude-all-year-end' set has one definition, the
// year_end_chain_entry_ids SQL function (migration 20261024140100, pinned by
// tests/pg/trial-balance-aggregates-rpc.pg.test.ts). These are the JS seams
// that read it: the fetch, and the filter the line-reading paths apply.

describe('fetchYearEndEntryIds', () => {
  it('reads the period set from year_end_chain_entry_ids', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: ['ye-1', 'closing-import-1'], error: null })

    const ids = await fetchYearEndEntryIds({ rpc } as never, 'company-1', 'period-1')

    expect(rpc).toHaveBeenCalledWith('year_end_chain_entry_ids', {
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
    })
    expect(ids).toEqual(['ye-1', 'closing-import-1'])
  })

  it('throws with the SQLSTATE instead of reading the year as if it had no year-end entries', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'timeout', code: '57014' } })

    await expect(fetchYearEndEntryIds({ rpc } as never, 'company-1', 'period-1')).rejects.toMatchObject({
      code: '57014',
    })
  })
})

describe('excludeYearEndChain', () => {
  it('leaves the ids out of a journal_entries query', () => {
    const query = { not: vi.fn().mockReturnThis() }

    expect(excludeYearEndChain(query, ['ye-1', 'ye-storno-1'])).toBe(query)
    expect(query.not).toHaveBeenCalledWith('id', 'in', '(ye-1,ye-storno-1)')
  })

  it('adds no filter when the period has no year-end entries', () => {
    const query = { not: vi.fn().mockReturnThis() }

    expect(excludeYearEndChain(query, [])).toBe(query)
    expect(query.not).not.toHaveBeenCalled()
  })
})

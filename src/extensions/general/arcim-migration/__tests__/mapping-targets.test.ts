import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { buildMappingTargets } from '../lib/mapping-targets'

/**
 * A chart_of_accounts read that returns the given rows for any range, which is
 * all fetchAllRows needs: one page, then an empty one.
 */
function supabaseWith(rows: Array<Record<string, unknown>> | Error): SupabaseClient {
  let served = false
  const range = () =>
    rows instanceof Error
      ? Promise.resolve({ data: null, error: { message: rows.message } })
      : Promise.resolve({ data: served ? [] : ((served = true), rows), error: null })
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    range,
  }
  return { from: () => builder } as unknown as SupabaseClient
}

describe('buildMappingTargets', () => {
  // The bug this file exists for: BAS defines 3000-3004 and stops, so a
  // company account like 3005 was active in the chart, visible everywhere else
  // in the app, and still absent from the migration's mapping dropdown.
  it('offers a company account that BAS does not define', async () => {
    const targets = await buildMappingTargets(
      supabaseWith([
        { account_number: '3005', account_name: 'Provisioner inom Sverige', account_class: 3 },
      ]),
      'company-1',
    )
    const found = targets.find((t) => t.account_number === '3005')
    expect(found?.account_name).toBe('Provisioner inom Sverige')
  })

  it('still offers standard accounts the company has not created', async () => {
    const targets = await buildMappingTargets(supabaseWith([]), 'company-1')
    expect(targets.find((t) => t.account_number === '1930')).toBeTruthy()
    expect(targets.length).toBeGreaterThan(1000)
  })

  // The user renamed it; that is the label they will look for.
  it('prefers the company name over the BAS name on a collision', async () => {
    const targets = await buildMappingTargets(
      supabaseWith([
        { account_number: '3001', account_name: 'Försäljning konsulttjänster', account_class: 3 },
      ]),
      'company-1',
    )
    const matches = targets.filter((t) => t.account_number === '3001')
    expect(matches).toHaveLength(1)
    expect(matches[0].account_name).toBe('Försäljning konsulttjänster')
  })

  it('derives the class from the number when the row has none', async () => {
    const targets = await buildMappingTargets(
      supabaseWith([{ account_number: '3005', account_name: 'X', account_class: null }]),
      'company-1',
    )
    expect(targets.find((t) => t.account_number === '3005')?.account_class).toBe(3)
  })

  it('sorts by account number so the dropdown groups read in order', async () => {
    const targets = await buildMappingTargets(
      supabaseWith([{ account_number: '3005', account_name: 'X', account_class: 3 }]),
      'company-1',
    )
    const numbers = targets.map((t) => t.account_number)
    expect(numbers).toEqual([...numbers].sort((a, b) => a.localeCompare(b)))
  })

  // An incomplete list still lets the migration run; an exception stops it.
  // The fallback silently reproduces the problem this function fixes, so a
  // mapping made against an incomplete list has to be explainable afterwards.
  it('warns when it falls back, so an incomplete list leaves a trace', async () => {
    const warn = vi.fn()
    await buildMappingTargets(supabaseWith(new Error('boom')), 'company-1', { warn })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][1]).toMatchObject({
      companyId: 'company-1',
      reason: 'boom',
    })
  })

  it('does not warn on the ordinary path', async () => {
    const warn = vi.fn()
    await buildMappingTargets(supabaseWith([]), 'company-1', { warn })
    expect(warn).not.toHaveBeenCalled()
  })

  it('falls back to BAS when the chart cannot be read', async () => {
    const targets = await buildMappingTargets(supabaseWith(new Error('boom')), 'company-1')
    expect(targets.length).toBeGreaterThan(1000)
    expect(targets.find((t) => t.account_number === '3005')).toBeUndefined()
  })
})

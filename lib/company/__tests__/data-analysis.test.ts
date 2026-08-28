import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMockSupabase } from '@/tests/helpers'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  isDataAnalysisOptedIn,
  listDataAnalysisOptedInCompanyIds,
  chunkCompanyIds,
  OPTED_IN_COMPANY_ID_CHUNK,
} from '../data-analysis'

const { supabase, mockResult } = createMockSupabase()
const client = supabase as unknown as SupabaseClient

describe('isDataAnalysisOptedIn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResult({ data: null, error: null })
  })

  it('is true when the company has opted in', async () => {
    mockResult({ data: { data_analysis_opt_in: true } })
    expect(await isDataAnalysisOptedIn(client, 'company-1')).toBe(true)
  })

  it('is false when the company has not opted in', async () => {
    mockResult({ data: { data_analysis_opt_in: false } })
    expect(await isDataAnalysisOptedIn(client, 'company-1')).toBe(false)
  })

  it('is false when the settings row is missing', async () => {
    mockResult({ data: null })
    expect(await isDataAnalysisOptedIn(client, 'company-1')).toBe(false)
  })

  it('fails closed when the query errors', async () => {
    mockResult({ data: { data_analysis_opt_in: true }, error: { message: 'boom' } })
    expect(await isDataAnalysisOptedIn(client, 'company-1')).toBe(false)
  })

  it('reads company_settings for the given company', async () => {
    mockResult({ data: { data_analysis_opt_in: true } })
    await isDataAnalysisOptedIn(client, 'company-9')
    expect(supabase.from).toHaveBeenCalledWith('company_settings')
  })
})

describe('listDataAnalysisOptedInCompanyIds', () => {
  // Round-2 review of #1346: the read-side scripts pre-fetched opted-in ids
  // without paging (PostgREST caps at 1000) and then passed the whole list to
  // one `.in()` (URL length). The helper pages, the scripts chunk.
  it('pages through more than 1000 opted-in companies', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ company_id: `c-${i}` }))
    const page2 = [{ company_id: 'c-1000' }, { company_id: 'c-1001' }]
    enqueue({ data: page1 })
    enqueue({ data: page2 })
    const ids = await listDataAnalysisOptedInCompanyIds(supabase as unknown as SupabaseClient)
    expect(ids).toHaveLength(1002)
    expect(ids[0]).toBe('c-0')
    expect(ids[1001]).toBe('c-1001')
    expect(findCall('company_settings', 'eq')).toEqual(['data_analysis_opt_in', true])
    expect(findCalls('company_settings', 'range')).toEqual([[0, 999], [1000, 1999]])
  })

  it('returns an empty list when nobody has opted in', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    expect(await listDataAnalysisOptedInCompanyIds(supabase as unknown as SupabaseClient)).toEqual([])
  })

  it('throws on a query error instead of fitting on a partial corpus', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(listDataAnalysisOptedInCompanyIds(supabase as unknown as SupabaseClient)).rejects.toThrow('boom')
  })
})

describe('chunkCompanyIds', () => {
  it('keeps every `.in()` list at or under the chunk size', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`)
    const chunks = chunkCompanyIds(ids)
    expect(OPTED_IN_COMPANY_ID_CHUNK).toBeLessThanOrEqual(100)
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50])
    expect(chunks.flat()).toEqual(ids)
  })

  it('returns no chunks for an empty list', () => {
    expect(chunkCompanyIds([])).toEqual([])
  })
})

describe('data analysis consent copy', () => {
  // The flag also gates scripts/backtest-categorize.ts, which re-runs
  // transaction descriptions, merchant names and matched underlag through
  // the model. The consent copy must say so in both locales and must not
  // claim that free text or underlag are excluded (review of #1346).
  const locales = ['sv', 'en'] as const
  const messages = {
    sv: readFileSync(join(process.cwd(), 'messages/sv.json'), 'utf8'),
    en: readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8'),
  }

  it.each(locales)('%s names the evaluation-run inputs the backtest reads', (locale) => {
    const { data_analysis } = JSON.parse(messages[locale]) as {
      data_analysis: { settings_toggle_help: string; settings_disclosure: string }
    }
    const help = data_analysis.settings_toggle_help
    const disclosure = data_analysis.settings_disclosure
    const wordsFor = locale === 'sv'
      ? { text: /transaktionstexter/, underlag: /underlag/, denial: /ingen fritext|inga underlag/i }
      : { text: /transaction descriptions/, underlag: /supporting documents/, denial: /no free text|no supporting documents/i }
    expect(help).toMatch(wordsFor.text)
    expect(help).toMatch(wordsFor.underlag)
    expect(help).not.toMatch(wordsFor.denial)
    expect(disclosure).toMatch(wordsFor.text)
    expect(disclosure).not.toMatch(wordsFor.denial)
  })
})

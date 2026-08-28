import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMockSupabase } from '@/tests/helpers'
import { isDataAnalysisOptedIn } from '../data-analysis'

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

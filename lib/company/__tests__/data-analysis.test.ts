import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMockSupabase } from '@/tests/helpers'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

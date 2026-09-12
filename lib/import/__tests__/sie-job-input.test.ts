import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { parseSIEFile } from '../sie-parser'
import { resolveSIEFiscalYear, validateSIEJobInput } from '../sie-jobs'
import type { AccountMapping } from '../types'

const options = {filename:'ledger.si',createFiscalPeriod:false,importOpeningBalances:false,importTransactions:true}
const mappings:AccountMapping[] = ['1930','3001'].map(number => ({sourceAccount:number,targetAccount:number,
  sourceName:'Account',targetName:'Account',confidence:1,matchType:'exact',isOverride:false}))
const content = '#FLAGGA 0\n#SIETYP 4\n#VER "" "" 20260201 "Unnumbered"\n{\n#TRANS 1930 {} 100\n#TRANS 3001 {} -100\n}'

describe('SIE durable input boundaries', () => {
  it('preserves omitted voucher identity and resolves the sole containing fiscal period', async () => {
    const parsed = parseSIEFile(content)
    expect(parsed.vouchers).toHaveLength(1)
    expect(parsed.vouchers[0].numberOmitted).toBe(true)
    const {supabase,enqueueMany} = createQueuedMockSupabase()
    enqueueMany([{data:[{period_start:'2026-01-01',period_end:'2026-12-31'}]}])
    await resolveSIEFiscalYear(supabase as unknown as SupabaseClient, 'company-1', parsed)
    expect(parsed.stats.fiscalYearStart).toBe('2026-01-01')
    expect(()=>validateSIEJobInput(content,parsed,mappings,options)).not.toThrow()
  })
  it.each([{periods:[]},{periods:[{period_start:'2026-01-01',period_end:'2026-12-31'},{period_start:'2025-07-01',period_end:'2026-06-30'}]}])(
    'refuses missing or ambiguous containing periods', async ({periods}) => {
      const {supabase,enqueueMany} = createQueuedMockSupabase()
      enqueueMany([{data:periods}])
      await expect(resolveSIEFiscalYear(supabase as unknown as SupabaseClient,'company-1',parseSIEFile(content))).rejects.toThrow('saknar #RAR')
    })
  it('names an oversized voucher before any ledger write', () => {
    const withYear = '#RAR 0 20260101 20261231\n'+content
    const parsed = parseSIEFile(withYear)
    parsed.vouchers[0].lines = Array.from({length:2001},()=>parsed.vouchers[0].lines[0])
    expect(()=>validateSIEJobInput(withYear,parsed,mappings,options)).toThrow('2 000 rader')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { parseSIEFile, sieCurrencyRefusal, validateSIEFile } from '../sie-parser'
import { submitSIEJob, validateSIEJobInput } from '../sie-jobs'
import type { AccountMapping } from '../types'

/**
 * #VALUTA names the currency of every amount in a SIE file (SIE 4B; absent
 * means SEK). The parser read it but no gate did, so a file kept in EUR was
 * imported as if its amounts were kronor (accounted#58). The ledger is kronor
 * only and the import never converts, so the file is refused at the preview
 * (validateSIEFile) and at submit and in the worker (validateSIEJobInput),
 * before anything is written.
 */
const EUR_FIXTURE = readFileSync(join(__dirname, 'fixtures', 'valuta-eur.se'), 'utf8')
const SEK_FILE = EUR_FIXTURE.replace('#VALUTA EUR', '#VALUTA SEK')
const NO_VALUTA_FILE = EUR_FIXTURE.replace('#VALUTA EUR\n', '')

const options = { filename: 'eur.se', createFiscalPeriod: false, importOpeningBalances: true, importTransactions: true }
const mappings: AccountMapping[] = ['1930', '2081', '3001'].map(number => ({
  sourceAccount: number, targetAccount: number, sourceName: 'Account', targetName: 'Account',
  confidence: 1, matchType: 'exact', isOverride: false,
}))

describe('SIE #VALUTA', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('parses the fixture as a EUR file', () => {
    expect(parseSIEFile(EUR_FIXTURE).header.currency).toBe('EUR')
  })

  it('refuses a EUR file at the preview with a Swedish sentence naming the currency', () => {
    const validation = validateSIEFile(parseSIEFile(EUR_FIXTURE))
    expect(validation.valid).toBe(false)
    expect(validation.errors).toContain(
      'SIE-filens belopp är i EUR (#VALUTA EUR). Accounted bokför bara i svenska kronor, och beloppen skulle bokföras som kronor utan omräkning, så filen importeras inte. Exportera bokföringen i SEK om källsystemet kan det.',
    )
  })

  it('refuses a EUR file at the job input gate', () => {
    expect(() => validateSIEJobInput(EUR_FIXTURE, parseSIEFile(EUR_FIXTURE), mappings, options))
      .toThrow('SIE-filens belopp är i EUR (#VALUTA EUR).')
  })

  it('refuses a EUR file at submit before any database or storage call', async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const { supabase } = createQueuedMockSupabase()
    await expect(submitSIEJob(supabase as unknown as SupabaseClient, 'company-1', 'user-1', EUR_FIXTURE, mappings, options))
      .rejects.toThrow('#VALUTA EUR')
    expect(supabase.from).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(supabase.storage.from).not.toHaveBeenCalled()
  })

  it('admits the same file in SEK and without #VALUTA (SEK by default)', () => {
    for (const content of [SEK_FILE, NO_VALUTA_FILE]) {
      const parsed = parseSIEFile(content)
      expect(parsed.header.currency).toBe('SEK')
      expect(validateSIEFile(parsed).valid).toBe(true)
      expect(() => validateSIEJobInput(content, parsed, mappings, options)).not.toThrow()
    }
  })

  it.each([
    ['SEK', null],
    ['sek', null],
    [' SEK ', null],
    ['', null],
    ['EUR', 'EUR'],
    ['usd', 'USD'],
  ])('reads #VALUTA %j case-insensitively', (currency, refused) => {
    const refusal = sieCurrencyRefusal({ currency })
    if (refused) expect(refusal).toContain(`#VALUTA ${refused}`)
    else expect(refusal).toBeNull()
  })

  it('reads a quoted #VALUTA the same as a bare one', () => {
    const parsed = parseSIEFile(EUR_FIXTURE.replace('#VALUTA EUR', '#VALUTA "EUR"'))
    expect(sieCurrencyRefusal(parsed.header)).toContain('#VALUTA EUR')
  })
})

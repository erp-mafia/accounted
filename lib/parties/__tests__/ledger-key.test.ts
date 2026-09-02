import { describe, expect, it } from 'vitest'
import { ledgerKey } from '../ledger-key'

// Fixture pairs are shared with tests/pg/observed-parties-rpc.pg.test.ts,
// which runs the same inputs through public.ledger_key() and asserts parity.
export const LEDGER_KEY_CASES: [string, string][] = [
  ['Levfakt BEIJER BYGGMATERIAL AB (2089)', 'beijer byggmaterial'],
  ['Levfakt Beijer Byggmaterial AB, 097 (1001)', 'beijer byggmaterial'],
  ['Leverantörsfaktura från 18 Loopia, 1009146000', 'loopia'],
  ['Levfakt Varsego Sverige AB (178)', 'varsego sverige'],
  ['Levfkt 1555 Telge Energi', 'telge energi'],
  ['Levbet. MiSUMi (2189107)', 'misumi'],
  ['Kvitto OpenAI', 'openai'],
  ['Inköp av varor', 'inköp av varor'],
  ['Bankkostnad', 'bankkostnad'],
  ['Google Workspace - 2025-09', 'google workspace'],
  ['Telia Sverige AB', 'telia sverige'],
  ['', ''],
]

describe('ledgerKey', () => {
  it.each(LEDGER_KEY_CASES)('%s -> %s', (raw, expected) => {
    expect(ledgerKey(raw)).toBe(expected)
  })

  it('never strips "inköp", which would turn a category into a vendor', () => {
    expect(ledgerKey('Inköp varor material')).toBe('inköp varor material')
  })

  it('falls back to the normalised key when stripping would leave nothing', () => {
    expect(ledgerKey('Faktura 12')).not.toBe('')
  })

  it('merges the two AP spellings of one supplier onto one key', () => {
    expect(ledgerKey('Levfakt BEIJER BYGGMATERIAL AB (2089)')).toBe(ledgerKey('Levfakt Beijer Byggmaterial AB, 097 (1001)'))
  })
})

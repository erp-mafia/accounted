import { describe, expect, it } from 'vitest'
import { ledgerKey } from '../ledger-key'

// Fixture pairs are shared with tests/pg/observed-parties-rpc.pg.test.ts,
// which runs the same inputs through public.ledger_key() and asserts parity.
export const LEDGER_KEY_CASES: [string, string][] = [
  // Descriptions our own booking flows write (seen on prod 2026-09-03).
  ['Utlägg Anthropic · Anthropic PBC, 206,12 EUR inkl. 41,22 EUR VAT-Sweden 25% via OSS.', 'utlägg anthropic'],
  ['1511768101 · Visma Spcs AB, faktura 2025-10-02, programvarulicens/abonnemang', 'visma spcs'],
  ['TIC identity     BG 0000005786439 Bg-bet. via internet · Faktura 20250746, The Intelligence Company AB (publ).', 'tic identity'],
  ['Hotel at Booking.com K3667 Kortköp/uttag · Hotell, svenskt boende, 12% moms', 'hotel at bookingcom'],
  ['Utlägg · Utlägg, mjukvara, leverantör ej angiven', 'utlägg'],
  ['1260424603197 Pris betalning', 'pris betalning'],
  ['leverantörsfaktura 20250928, The Intelligence Company AB (publ)', 'the intelligence company publ'],
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

describe('displayNameFromVoucherText on assistant-written descriptions', () => {
  it('keeps the counterpart, drops the note, method tokens and references', async () => {
    const { displayNameFromVoucherText } = await import('../ledger-key')
    expect(displayNameFromVoucherText('Utlägg Anthropic · Anthropic PBC, 206,12 EUR inkl. VAT')).toBe('Utlägg Anthropic')
    expect(displayNameFromVoucherText('1511768101 · Visma Spcs AB, faktura 2025-10-02')).toBe('Visma Spcs AB')
    expect(displayNameFromVoucherText('TIC identity     BG 0000005786439 Bg-bet. via internet · Faktura 20250746')).toBe('TIC identity')
    expect(displayNameFromVoucherText('Hotel at Booking.com K3667 Kortköp/uttag · Hotell')).toBe('Hotel at Booking.com')
    expect(displayNameFromVoucherText('leverantörsfaktura 20250928, The Intelligence Company AB (publ)')).toBe('The Intelligence Company AB (publ)')
    expect(displayNameFromVoucherText('1260424603197 Pris betalning')).toBe('Pris betalning')
  })
})

import { describe, it, expect, vi } from 'vitest'
import {
  generateSkattekontoOcr,
  resolveSkattekontoOcr,
  SKATTEKONTO_BANKGIRO,
} from '../skattekonto-ocr'
import { luhnValidate } from '@/lib/bankgiro/luhn'

describe('generateSkattekontoOcr', () => {
  // Ground truth from Skatteverket for org 559547-0021: the reference their
  // e-service prints is the twelve-digit form plus a check digit, not the
  // ten-digit one (which is what we used to emit, and banks/SKV rejected).
  it('produces the 13-digit OCR Skatteverket prints for an AB', () => {
    expect(generateSkattekontoOcr('559547-0021', 'aktiebolag')).toBe('1655954700217')
  })

  it('prefixes an organisationsnummer with 16 and appends a Luhn check digit', () => {
    const ocr = generateSkattekontoOcr('556012-3456', 'aktiebolag')
    expect(ocr).toHaveLength(13)
    expect(ocr.startsWith('165560123456')).toBe(true)
    expect(luhnValidate(ocr)).toBe(true)
  })

  it('accepts org-number without dash and with spaces', () => {
    const canonical = generateSkattekontoOcr('556012-3456', 'aktiebolag')
    expect(generateSkattekontoOcr('5560123456', 'aktiebolag')).toBe(canonical)
    expect(generateSkattekontoOcr('556012 3456', 'aktiebolag')).toBe(canonical)
  })

  it('keeps the century for an enskild firma personnummer', () => {
    const ocr = generateSkattekontoOcr('19880225-1234', 'enskild_firma')
    expect(ocr).toHaveLength(13)
    expect(ocr.startsWith('198802251234')).toBe(true)
    expect(luhnValidate(ocr)).toBe(true)
  })

  it('derives the century for a 10-digit personnummer', () => {
    expect(generateSkattekontoOcr('880225-1234', 'enskild_firma')).toBe(
      generateSkattekontoOcr('198802251234', 'enskild_firma'),
    )
  })

  it('does not give an enskild firma the organisationsnummer prefix', () => {
    const ef = generateSkattekontoOcr('880225-1234', 'enskild_firma')
    const ab = generateSkattekontoOcr('880225-1234', 'aktiebolag')
    expect(ef.startsWith('16')).toBe(false)
    expect(ab.startsWith('16')).toBe(true)
    expect(ef).not.toBe(ab)
  })

  it('rejects malformed numbers', () => {
    expect(() => generateSkattekontoOcr('123', 'aktiebolag')).toThrow(/Ogiltigt/)
    expect(() => generateSkattekontoOcr('', 'aktiebolag')).toThrow(/Ogiltigt/)
    expect(() => generateSkattekontoOcr('abcdefghij', 'aktiebolag')).toThrow(/Ogiltigt/)
  })

  it('exports correct Bankgiro for Skattekontot', () => {
    expect(SKATTEKONTO_BANKGIRO).toBe('5050-1055')
  })
})

describe('resolveSkattekontoOcr', () => {
  function snapshotClient(value: unknown, error: unknown = null) {
    const maybeSingle = vi.fn().mockResolvedValue({ data: value === undefined ? null : { value }, error })
    const eq = vi.fn()
    const builder = { select: vi.fn(() => builder), eq, maybeSingle }
    eq.mockImplementation(() => builder)
    return {
      client: { from: vi.fn(() => builder) } as never,
      from: builder,
    }
  }

  it('prefers the OCR Skatteverket reported on the skattekonto saldo', async () => {
    const { client } = snapshotClient({ saldo: { ocrNummer: '1948040320946' }, fetchedAt: 1 })
    await expect(
      resolveSkattekontoOcr(client, 'company-1', '556012-3456', 'aktiebolag'),
    ).resolves.toBe('1948040320946')
  })

  it('strips separators from the reported OCR', async () => {
    const { client } = snapshotClient({ saldo: { ocrNummer: '16 5595470021 7' } })
    await expect(
      resolveSkattekontoOcr(client, 'company-1', '556012-3456', 'aktiebolag'),
    ).resolves.toBe('1655954700217')
  })

  it('falls back to the computed OCR when no snapshot is cached', async () => {
    const { client } = snapshotClient(undefined)
    await expect(
      resolveSkattekontoOcr(client, 'company-1', '559547-0021', 'aktiebolag'),
    ).resolves.toBe('1655954700217')
  })

  it('falls back when the cached OCR fails its Luhn check', async () => {
    const { client } = snapshotClient({ saldo: { ocrNummer: '1655954700216' } })
    await expect(
      resolveSkattekontoOcr(client, 'company-1', '559547-0021', 'aktiebolag'),
    ).resolves.toBe('1655954700217')
  })

  it('falls back when the cached OCR is longer than Bankgirot accepts', async () => {
    const { client } = snapshotClient({ saldo: { ocrNummer: '1'.repeat(26) } })
    await expect(
      resolveSkattekontoOcr(client, 'company-1', '559547-0021', 'aktiebolag'),
    ).resolves.toBe('1655954700217')
  })

  it('falls back when the snapshot read errors', async () => {
    const { client } = snapshotClient(undefined, { message: 'boom' })
    await expect(
      resolveSkattekontoOcr(client, 'company-1', '559547-0021', 'aktiebolag'),
    ).resolves.toBe('1655954700217')
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { AiService } from '@/lib/ai'
import { isGrounded, parseReading, readCounterparts, verifyCounterparts, type ReaderLine } from '../model-reading'

vi.mock('@/lib/ai', () => ({
  getAiService: () => { throw new Error('not used in tests') },
  getAiStatus: () => ({ configured: true }),
}))

function line(over: Partial<ReaderLine> = {}): ReaderLine {
  return { i: 1, text: 'FITTJA MATMA', amount: 476, currency: 'SEK', seenCount: 1, companyCount: 1, candidates: [], ...over }
}

function fakeAi(value: unknown): AiService {
  return { generateStructured: vi.fn(async () => ({ value, model: 'haiku-test', usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: null, cacheReadInputTokens: null } })) } as unknown as AiService
}

describe('isGrounded', () => {
  it('accepts a name that shares a token with the line, also a truncated one', () => {
    expect(isGrounded('Fittja Matmarknad', 'FITTJA MATMA')).toBe(true)
    expect(isGrounded('Squarespace', 'SQSP WORKSP')).toBe(false)
    expect(isGrounded('Kronans Apotek', 'KRONANS APOTEK AB')).toBe(true)
    expect(isGrounded('Booking.com', 'BKG HOTEL AT BOOKING C')).toBe(true)
  })

  it('accepts an offered candidate or the rail by name', () => {
    expect(isGrounded('Anthropic', 'xyz', [{ id: 'p1', name: 'Anthropic' }])).toBe(true)
    expect(isGrounded('Klarna', 'xyz', [], 'Klarna')).toBe(true)
  })

  it('rejects a name borrowed from elsewhere', () => {
    expect(isGrounded('Sofia Carter', '+46730731501')).toBe(false)
  })
})

describe('parseReading', () => {
  it('drops an ungrounded name and lowers the confidence', () => {
    const r = parseReading({ i: 1, pick: null, counterpart: 'Sofia Carter', kind: 'person', rail: null, country: null, what: null, confidence: 'medium' }, line({ text: '+46730731501' }), 'm')
    expect(r).toMatchObject({ counterpart: null, grounded: false, confidence: 'low', kind: 'unsure' })
  })

  it('keeps a pick only when it is one of the offered candidates', () => {
    const l = line({ text: 'Anthropic, PBC', candidates: [{ id: 'p1', name: 'Anthropic' }] })
    expect(parseReading({ i: 1, pick: 'p1', counterpart: 'Anthropic', kind: 'merchant', rail: null, country: 'US', what: null, confidence: 'high' }, l, 'm')?.pick).toBe('p1')
    expect(parseReading({ i: 1, pick: 'p9', counterpart: 'Anthropic', kind: 'merchant', rail: null, country: 'US', what: null, confidence: 'high' }, l, 'm')?.pick).toBeNull()
  })

  it('ignores a reading for another line', () => {
    expect(parseReading({ i: 2, counterpart: 'X', kind: 'merchant', confidence: 'high' }, line(), 'm')).toBeNull()
  })
})

describe('readCounterparts', () => {
  it('maps readings back by line number and survives a failed batch', async () => {
    const ai = fakeAi({ items: [{ i: 1, pick: null, counterpart: 'Fittja Matmarknad', kind: 'merchant', rail: null, country: 'SE', what: 'Livsmedel', confidence: 'medium' }] })
    const out = await readCounterparts([line()], ai)
    expect(out.get(1)).toMatchObject({ counterpart: 'Fittja Matmarknad', confidence: 'medium', model: 'haiku-test' })

    const failing = { generateStructured: vi.fn(async () => { throw new Error('boom') }) } as unknown as AiService
    expect((await readCounterparts([line()], failing)).size).toBe(0)
  })
})

describe('verifyCounterparts', () => {
  it('returns a verdict per line and unsure for anything else', async () => {
    const ai = fakeAi({ items: [{ i: 1, verdict: 'yes' }, { i: 2, verdict: 'maybe' }] })
    const out = await verifyCounterparts([{ i: 1, text: 'a', proposed: 'A' }, { i: 2, text: 'b', proposed: 'B' }], ai)
    expect(out.get(1)).toBe('yes')
    expect(out.get(2)).toBe('unsure')
  })
})

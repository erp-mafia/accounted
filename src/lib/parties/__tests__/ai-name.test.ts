import { describe, it, expect, vi, beforeEach } from 'vitest'

const generateStructured = vi.fn()
const status = { configured: true }
vi.mock('@/lib/ai', () => ({
  getAiService: () => ({ generateStructured }),
  getAiStatus: () => ({ configured: status.configured }),
}))

import { readCounterpartName, aiNameAvailable } from '../ai-name'

beforeEach(() => {
  vi.clearAllMocks()
  status.configured = true
})

describe('readCounterpartName', () => {
  it('reads the counterpart out of a card memo and normalises country and VAT', async () => {
    generateStructured.mockResolvedValue({
      value: { name: 'Booking.com', country: 'nl', vat_number: 'NL 805734958 B01', confidence: 'high' },
      model: 'test-model',
      usage: {},
    })
    const r = await readCounterpartName(['Hotel at Booking.com K3667 Kortköp/uttag · Hotell, svenskt boende, 12% moms'])
    expect(r).toEqual({ name: 'Booking.com', country: 'NL', vatNumber: 'NL805734958B01', confidence: 'high', model: 'test-model' })
    const req = generateStructured.mock.calls[0]![0] as { tier: string; prompt: string; schema: { name: string } }
    expect(req.tier).toBe('extraction')
    expect(req.prompt).toContain('1. Hotel at Booking.com')
    expect(req.schema.name).toBe('counterpart_reading')
  })

  it('keeps a null name, drops malformed country and VAT values, and sends at most three distinct texts', async () => {
    generateStructured.mockResolvedValue({ value: { name: null, country: 'Sweden', vat_number: '123', confidence: 'weird' }, model: 'm', usage: {} })
    const r = await readCounterpartName(['a', 'a', 'b', 'c', 'd'])
    expect(r).toEqual({ name: null, country: null, vatNumber: null, confidence: 'low', model: 'm' })
    const req = generateStructured.mock.calls[0]![0] as { prompt: string }
    expect(req.prompt).toContain('3. c')
    expect(req.prompt).not.toContain('4. d')
  })

  it('answers null without a call when the deployment has no model, on empty input, on a bad answer, and on an error', async () => {
    status.configured = false
    expect(aiNameAvailable()).toBe(false)
    expect(await readCounterpartName(['x'])).toBeNull()
    expect(generateStructured).not.toHaveBeenCalled()
    status.configured = true
    expect(await readCounterpartName(['', '  '])).toBeNull()
    generateStructured.mockResolvedValueOnce({ value: 'not an object', model: 'm', usage: {} })
    expect(await readCounterpartName(['x'])).toBeNull()
    generateStructured.mockRejectedValueOnce(new Error('boom'))
    expect(await readCounterpartName(['x'])).toBeNull()
  })
})

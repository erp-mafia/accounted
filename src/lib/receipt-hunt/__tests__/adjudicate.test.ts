/**
 * The second opinion on pairs the arithmetic could not settle.
 *
 * These tests are about what the verdict may not do: accept a pair nobody
 * asked about, answer twice, or turn a failed call into approvals. A rejected
 * pair simply does not appear, which leaves the run where the formula left it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UncertainPair } from '../adjudicate'

const mockCreate = vi.fn()
vi.mock('@/lib/ai/provider', () => ({
  createAiClient: () => ({ messages: { create: (...args: unknown[]) => mockCreate(...args) } }),
  toProviderModelId: (id: string) => id,
}))

import { adjudicate } from '../adjudicate'

function toolReply(input: unknown) {
  return { content: [{ type: 'tool_use', name: 'verdicts', id: 'tu', input }] }
}

function pair(key = 't1::d1'): UncertainPair {
  return {
    key,
    purchase: {
      description: 'VERCEL INC',
      amount: 541.2,
      currency: 'SEK',
      date: '2026-07-21',
    },
    receipt: {
      vendor: 'Vercel Inc.',
      total: 54.85,
      currency: 'USD',
      sekTotal: 534.65,
      date: '2026-07-14',
      fileName: 'Receipt-2955-0452.pdf',
    },
    confidence: 0.62,
    matchReasons: ['Belopp ±1%', 'Handlare matchar'],
  }
}

beforeEach(() => vi.clearAllMocks())

describe('adjudicate', () => {
  it('returns the pairs it accepted, with the reason a human will read', async () => {
    mockCreate.mockResolvedValue(
      toolReply({
        verdicts: [{ key: 't1::d1', accept: true, reason: 'Samma leverantör, beloppet stämmer efter växelkurs.' }],
      }),
    )
    const out = await adjudicate([pair()])
    expect(out).toHaveLength(1)
    expect(out[0].reason).toContain('växelkurs')
  })

  it('drops a pair it rejected rather than proposing it anyway', async () => {
    mockCreate.mockResolvedValue(
      toolReply({ verdicts: [{ key: 't1::d1', accept: false, reason: 'Fakturan avser en annan månad.' }] }),
    )
    await expect(adjudicate([pair()])).resolves.toEqual([])
  })

  it('never accepts a pair nobody asked about', async () => {
    // A key we did not send would attach a document to a purchase that was
    // never weighed against it.
    mockCreate.mockResolvedValue(
      toolReply({ verdicts: [{ key: 'invented::pair', accept: true, reason: 'x' }] }),
    )
    await expect(adjudicate([pair()])).resolves.toEqual([])
  })

  it('takes the first answer when a pair is answered twice', async () => {
    mockCreate.mockResolvedValue(
      toolReply({
        verdicts: [
          { key: 't1::d1', accept: true, reason: 'ja' },
          { key: 't1::d1', accept: false, reason: 'nej' },
        ],
      }),
    )
    const out = await adjudicate([pair()])
    expect(out).toHaveLength(1)
  })

  it('accepts nothing when the call fails', async () => {
    // The run is left exactly where the arithmetic left it.
    mockCreate.mockRejectedValue(new Error('bedrock timeout'))
    await expect(adjudicate([pair()])).resolves.toEqual([])
  })

  it('does not call the model when the formula settled everything', async () => {
    await expect(adjudicate([])).resolves.toEqual([])
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('asks about the whole batch in one call', async () => {
    // The pairs are independent, but a run holds a handful and a call each
    // would be latency for nothing.
    mockCreate.mockResolvedValue(toolReply({ verdicts: [] }))
    await adjudicate([pair('a::1'), pair('b::2'), pair('c::3')])
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('shows the model both sides of the amount, including the converted one', async () => {
    mockCreate.mockResolvedValue(toolReply({ verdicts: [] }))
    await adjudicate([pair()])
    const sent = JSON.stringify(mockCreate.mock.calls[0][0].messages[0].content)
    expect(sent).toContain('534.65')
    expect(sent).toContain('541.2')
  })

  it('accepts a verdict list the model sent as a JSON string', async () => {
    mockCreate.mockResolvedValue(
      toolReply({ verdicts: JSON.stringify([{ key: 't1::d1', accept: true, reason: 'ja' }]) }),
    )
    await expect(adjudicate([pair()])).resolves.toHaveLength(1)
  })
})

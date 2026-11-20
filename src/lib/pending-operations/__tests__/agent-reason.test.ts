import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_REASON_PROPERTY,
  MAX_AGENT_REASON_CHARS,
  agentReasonColumn,
  currentAgentReason,
  isMissingColumnError,
  normalizeAgentReason,
  runWithAgentReason,
  splitAgentReason,
  writeWithAgentReason,
} from '../agent-reason'

describe('normalizeAgentReason', () => {
  it('trims, and reads an empty or blank reason as none', () => {
    expect(normalizeAgentReason('  Matches invoice 1042 by OCR.  ')).toBe('Matches invoice 1042 by OCR.')
    expect(normalizeAgentReason('')).toBeNull()
    expect(normalizeAgentReason(' \n\t ')).toBeNull()
  })

  it('drops anything but a string instead of failing the write', () => {
    expect(normalizeAgentReason(undefined)).toBeNull()
    expect(normalizeAgentReason(null)).toBeNull()
    expect(normalizeAgentReason(42)).toBeNull()
    expect(normalizeAgentReason(['why'])).toBeNull()
    expect(normalizeAgentReason({ why: 'x' })).toBeNull()
  })

  it('keeps a reason of exactly the limit as given', () => {
    const exact = 'a'.repeat(MAX_AGENT_REASON_CHARS)
    expect(normalizeAgentReason(exact)).toBe(exact)
  })

  it('cuts a longer reason at a word boundary and marks the cut', () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ')
    const cut = normalizeAgentReason(words)!
    expect(Array.from(cut).length).toBeLessThanOrEqual(MAX_AGENT_REASON_CHARS)
    expect(cut.endsWith('…')).toBe(true)
    const kept = cut.slice(0, -1)
    // Whole words only: the kept text is a prefix of the original ending at a word end.
    expect(words.startsWith(kept)).toBe(true)
    expect(words[kept.length]).toBe(' ')
    expect(kept.endsWith(' ')).toBe(false)
  })

  it('cuts inside a single word longer than the limit rather than dropping it', () => {
    const cut = normalizeAgentReason('x'.repeat(800))!
    expect(Array.from(cut).length).toBe(MAX_AGENT_REASON_CHARS)
    expect(cut).toBe(`${'x'.repeat(MAX_AGENT_REASON_CHARS - 1)}…`)
  })

  it('counts code points as the database does and never splits a surrogate pair', () => {
    const cut = normalizeAgentReason('\u{1F4CE}'.repeat(600))!
    expect(Array.from(cut).length).toBe(MAX_AGENT_REASON_CHARS)
    expect(cut).toBe(`${'\u{1F4CE}'.repeat(MAX_AGENT_REASON_CHARS - 1)}…`)
  })
})

describe('splitAgentReason', () => {
  it('removes an added reason from the arguments and returns it normalized', () => {
    const { args, reason } = splitAgentReason(
      { agentReason: 'added' },
      { transaction_id: 't-1', reason: '  Same supplier as the last 12 months.  ' },
    )
    expect(args).toEqual({ transaction_id: 't-1' })
    expect(reason).toBe('Same supplier as the last 12 months.')
  })

  it("keeps a tool's own reason in place and reads it as the agent's reason too", () => {
    const input = { invoice_id: 'i-1', reason: 'Fel belopp' }
    const { args, reason } = splitAgentReason({ agentReason: 'own' }, input)
    expect(args).toBe(input)
    expect(reason).toBe('Fel belopp')
  })

  it('leaves the arguments of a tool that takes no reason untouched', () => {
    const input = { reason: 'not mine' }
    expect(splitAgentReason({}, input)).toEqual({ args: input, reason: null })
  })

  it('answers no reason when none was sent', () => {
    const input = { transaction_id: 't-1' }
    expect(splitAgentReason({ agentReason: 'added' }, input)).toEqual({ args: input, reason: null })
  })

  it('removes an empty added reason too, so a strict schema never sees it', () => {
    expect(splitAgentReason({ agentReason: 'added' }, { a: 1, reason: '   ' })).toEqual({ args: { a: 1 }, reason: null })
  })
})

describe('the request-local reason', () => {
  it('is visible inside runWithAgentReason only, and per call chain', async () => {
    expect(currentAgentReason()).toBeNull()
    const seen = await Promise.all([
      runWithAgentReason('first', async () => {
        await new Promise((r) => setTimeout(r, 5))
        return currentAgentReason()
      }),
      runWithAgentReason('second', async () => currentAgentReason()),
      runWithAgentReason(null, async () => currentAgentReason()),
    ])
    expect(seen).toEqual(['first', 'second', null])
    expect(currentAgentReason()).toBeNull()
  })
})

describe('writing the column', () => {
  it('names the column only with a reason', () => {
    expect(agentReasonColumn('why')).toEqual({ agent_reason: 'why' })
    expect(agentReasonColumn(null)).toEqual({})
    expect(agentReasonColumn('')).toEqual({})
  })

  it('writes once without the column when there is no reason', async () => {
    const write = vi.fn(async (reason: string | null) => ({ error: null, reason }))
    await writeWithAgentReason(null, write)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(null)
  })

  it('writes again without the reason while the column is not there yet', async () => {
    const write = vi
      .fn<(reason: string | null) => Promise<{ error: { code: string } | null }>>()
      .mockResolvedValueOnce({ error: { code: 'PGRST204' } })
      .mockResolvedValueOnce({ error: null })
    const result = await writeWithAgentReason('why', write)
    expect(write.mock.calls).toEqual([['why'], [null]])
    expect(result.error).toBeNull()
  })

  it('does not retry any other failure', async () => {
    const write = vi.fn(async () => ({ error: { code: '23514' } }))
    const result = await writeWithAgentReason('why', write)
    expect(write).toHaveBeenCalledTimes(1)
    expect(result.error).toEqual({ code: '23514' })
  })

  it('reads PGRST204 and 42703 as a missing column, nothing else', () => {
    expect(isMissingColumnError({ code: 'PGRST204' })).toBe(true)
    expect(isMissingColumnError({ code: '42703' })).toBe(true)
    expect(isMissingColumnError({ code: '23514' })).toBe(false)
    expect(isMissingColumnError(null)).toBe(false)
  })
})

describe('AGENT_REASON_PROPERTY', () => {
  it('is an optional plain string with a short instruction, no maxLength (a longer one is cut, not refused)', () => {
    expect(AGENT_REASON_PROPERTY).toEqual({ type: 'string', description: expect.any(String) })
    expect(AGENT_REASON_PROPERTY.description.length).toBeLessThan(100)
    expect(Object.isFrozen(AGENT_REASON_PROPERTY)).toBe(true)
  })
})

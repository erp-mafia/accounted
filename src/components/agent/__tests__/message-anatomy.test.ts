import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '../AgentChat'

/**
 * The pure state transitions behind PR4's message anatomy. The rendering is
 * covered by a visual pass (this repo has no component tests), but the state
 * rules are exactly where the regressions would hide, so they are pinned here.
 */

/** Mirrors handleStop: mark the last assistant turn as interrupted, once. */
function markInterrupted(prev: ChatMessage[]): ChatMessage[] {
  const last = prev[prev.length - 1]
  if (!last || last.role !== 'assistant' || last.interrupted) return prev
  return [...prev.slice(0, -1), { ...last, interrupted: true }]
}

/** Mirrors handleSend's recovery: drop the bubble that was never persisted. */
function dropUnsentBubble(prev: ChatMessage[], text: string): ChatMessage[] {
  const last = prev[prev.length - 1]
  return last?.role === 'user' && last.text === text ? prev.slice(0, -1) : prev
}

describe('stop keeps partial content', () => {
  it('marks the streaming assistant turn as interrupted', () => {
    const out = markInterrupted([
      { role: 'user', text: 'hur gick juli?' },
      { role: 'assistant', text: 'Juli gick 12 procent' },
    ])

    expect(out[1]!.interrupted).toBe(true)
    // The partial text must survive: a truncated answer is still useful, it
    // just must not look complete.
    expect(out[1]!.text).toBe('Juli gick 12 procent')
  })

  it('is idempotent', () => {
    const once = markInterrupted([{ role: 'assistant', text: 'delvis' }])
    expect(markInterrupted(once)).toBe(once)
  })

  it('does not mark a user turn', () => {
    const messages: ChatMessage[] = [{ role: 'user', text: 'vänta' }]
    expect(markInterrupted(messages)).toBe(messages)
  })

  it('does nothing on an empty thread', () => {
    const messages: ChatMessage[] = []
    expect(markInterrupted(messages)).toBe(messages)
  })
})

describe('failed send returns the text', () => {
  it('removes the bubble that was never persisted', () => {
    const out = dropUnsentBubble(
      [
        { role: 'assistant', text: 'tidigare svar' },
        { role: 'user', text: 'boka om Circle K' },
      ],
      'boka om Circle K',
    )

    // Nothing reached the server, so nothing was persisted: leaving the bubble
    // would show a question that vanishes on the next reload.
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe('assistant')
  })

  it('leaves the thread alone when the last turn is something else', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: 'boka om Circle K' },
      { role: 'assistant', text: 'hann svara' },
    ]
    expect(dropUnsentBubble(messages, 'boka om Circle K')).toBe(messages)
  })

  it('only removes the matching text', () => {
    const messages: ChatMessage[] = [{ role: 'user', text: 'en annan fråga' }]
    expect(dropUnsentBubble(messages, 'boka om Circle K')).toBe(messages)
  })
})

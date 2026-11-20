/**
 * Chat messages stay inside their bubble: a pasted link or a long reference
 * breaks instead of running past the bubble, and a markdown table in an
 * answer scrolls in its own box instead of widening the conversation.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('chat message overflow', () => {
  it('the /chat and panel bubbles break long words', () => {
    expect(read('src/components/agent/AgentChat.tsx')).toContain("'max-w-[85%] break-words rounded-lg px-4 py-3 text-sm leading-6'")
  })

  it('the ask console breaks long words in both the question and the answer', () => {
    const src = read('src/components/agent/AskConsole.tsx')
    expect(src).toContain('max-w-[85%] break-words rounded-lg bg-secondary')
    expect(src).toContain("cn('max-w-[88%] break-words', ANSWER_PROSE)")
  })

  it('markdown tables render inside a horizontal scroller', () => {
    const src = read('src/components/agent/MarkdownMessage.tsx')
    expect(src).toContain('table: MarkdownTable')
    expect(src).toMatch(/<div className="overflow-x-auto">\s*<table>\{children\}<\/table>/)
  })
})

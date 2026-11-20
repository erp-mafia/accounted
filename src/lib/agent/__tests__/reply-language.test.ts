import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { replyLanguageRule } from '../reply-language'

describe('replyLanguageRule', () => {
  it('answers in Swedish by default and for sv', () => {
    expect(replyLanguageRule()).toBe('Du svarar alltid på svenska.')
    expect(replyLanguageRule('sv')).toBe('Du svarar alltid på svenska.')
  })

  it('answers in English for en, over Swedish instructions and history, keeping statutory terms', () => {
    const rule = replyLanguageRule('en')
    expect(rule).toContain('Du svarar alltid på engelska')
    expect(rule).toContain('tidigare meddelanden i konversationen')
    expect(rule).toContain('momsdeklaration (VAT return)')
    expect(rule).not.toContain('Du svarar alltid på svenska')
  })
})

// The rule lives in one place. A prompt that pins the answer to Swedish on its
// own overrides the user's locale again: that is how every English user got
// Swedish answers before.
describe('no assistant prompt pins the answer language', () => {
  const PINNED = /(svara|svarar|förklara|skriv)[^.'`"]{0,40}på svenska/i
  const dirs = ['intents', 'chat', 'ask'].map((d) => join(__dirname, '..', d))

  it.each(dirs)('%s', (dir) => {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8')
      expect(source.match(PINNED)?.[0], `${file} pins the answer language`).toBeUndefined()
    }
  })
})

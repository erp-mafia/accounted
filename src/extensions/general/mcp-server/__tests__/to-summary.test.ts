/**
 * Unit tests for toSummary: trims the long, keyword-stuffed SKILL.md
 * frontmatter descriptions into clean one-liners for gnubok_list_skills and
 * gnubok_get_agent_briefing, so the client never truncates one mid-sentence.
 */
import { describe, it, expect } from 'vitest'
import { toSummary } from '../skills/atoms'

describe('toSummary', () => {
  it('returns short input unchanged (idempotent)', () => {
    const s = 'Swedish VAT compliance reference.'
    expect(toSummary(s)).toBe(s)
    expect(toSummary(toSummary(s))).toBe(s)
  })

  it('collapses internal whitespace', () => {
    expect(toSummary('Foo   bar\n\tbaz')).toBe('Foo bar baz')
  })

  it('prefers the first sentence when it ends within the cap', () => {
    const s = 'Project accounting basics. ' + 'tail '.repeat(60) // well over the cap
    expect(toSummary(s, 60)).toBe('Project accounting basics.')
  })

  it('cuts at a word boundary with an ellipsis when no sentence ends within the cap', () => {
    const long = 'a '.repeat(300).trim() // 300 single-char words, no punctuation
    const out = toSummary(long, 50)
    expect(out.length).toBeLessThanOrEqual(51) // <= maxLen + ellipsis
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toMatch(/\s…$/) // trimmed before the ellipsis
    expect(out.includes('  ')).toBe(false)
  })

  it('never cuts in the middle of a word', () => {
    const s = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'
    const out = toSummary(s, 25)
    const body = out.replace(/…$/, '').trim()
    // every whitespace-delimited token in the output is a whole word from the input
    const words = new Set(s.split(/\s+/))
    for (const tok of body.split(/\s+/)) expect(words.has(tok)).toBe(true)
  })

  it('handles the real project-accounting description without a mid-word cut', () => {
    const desc =
      'Swedish project accounting (projektredovisning) covering dimensional tagging of bokföringsposter with project codes, WIP accounting (pågående arbeten), revenue recognition under K2 and K3 (successiv vinstavräkning, färdigställandemetoden), construction contracts (entreprenadavtal), BAS account patterns for project tracking (1470, 1620, 2420, 2450, 4970), SIE4 dimension encoding (#DIM 6, #OBJEKT, #TRANS object lists)'
    const out = toSummary(desc)
    expect(out.length).toBeLessThanOrEqual(201)
    expect(out.endsWith('…')).toBe(true)
  })

  it('tolerates empty/blank input', () => {
    expect(toSummary('')).toBe('')
    expect(toSummary('   ')).toBe('')
  })
})

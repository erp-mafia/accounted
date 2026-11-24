import { describe, expect, it } from 'vitest'
import { stripFrontMatter } from '../front-matter'

const BODY = ['# Example knowledge', '', 'This text is what the screen shows.', '', '## When to use', '', '- A first point', ''].join('\n')

/** A file as the registry holds it: front matter, a blank line, then the text. */
const WITH_FRONT_MATTER = [
  '---',
  'name: example-knowledge',
  'description: >',
  '  An example reference. Covers the first thing, the second thing',
  '  and the third thing.',
  '---',
  '',
  BODY,
].join('\n')

describe('stripFrontMatter', () => {
  it('shows a text from after its front matter', () => {
    expect(stripFrontMatter(WITH_FRONT_MATTER)).toBe(BODY)
    expect(stripFrontMatter(WITH_FRONT_MATTER).startsWith('# Example knowledge')).toBe(true)
    expect(stripFrontMatter(WITH_FRONT_MATTER)).not.toContain('name: example-knowledge')
    expect(stripFrontMatter(WITH_FRONT_MATTER)).not.toContain('description:')
  })

  it('takes a block of any keys, with or without a blank line after it', () => {
    expect(stripFrontMatter('---\nid: horizontal/example\ntier: horizontal\n---\n# Title\n')).toBe('# Title\n')
    expect(stripFrontMatter('---\naudience: developer\nareas: [moms, lon]\n---\n\n\n# Title\n')).toBe('# Title\n')
    expect(stripFrontMatter('---\nname: x\n---\n \n\t\n# Title')).toBe('# Title')
  })

  it('leaves a text without front matter exactly as it is', () => {
    expect(stripFrontMatter(BODY)).toBe(BODY)
    expect(stripFrontMatter('Just one line')).toBe('Just one line')
    expect(stripFrontMatter('\n\n# Title after blank lines\n')).toBe('\n\n# Title after blank lines\n')
  })

  it('leaves a rule further down in the body where it is', () => {
    const withRule = `${BODY}\n---\n\n## Loadable references\n\n- one\n`
    expect(stripFrontMatter(withRule)).toBe(withRule)
    const twoRules = '# Title\n\n---\n\nname: not front matter\n\n---\n\nThe end\n'
    expect(stripFrontMatter(twoRules)).toBe(twoRules)
  })

  it('takes only the leading block of a text that also has rules further down', () => {
    const footer = '\n---\n\n## Loadable references\n\n- one\n\n---\n\nLast words\n'
    expect(stripFrontMatter(`${WITH_FRONT_MATTER}${footer}`)).toBe(`${BODY}${footer}`)
  })

  it('answers an empty text with an empty text', () => {
    expect(stripFrontMatter('')).toBe('')
  })

  it('answers a text that is only front matter with an empty text', () => {
    expect(stripFrontMatter('---\nname: x\ndescription: y\n---\n')).toBe('')
    expect(stripFrontMatter('---\nname: x\ndescription: y\n---')).toBe('')
    expect(stripFrontMatter('---\nname: x\n---\n\n\n')).toBe('')
  })

  it('reads CRLF line endings and passes over a byte order mark', () => {
    expect(stripFrontMatter('---\r\nname: x\r\ndescription: y\r\n---\r\n\r\n# Title\r\n\r\nText\r\n')).toBe('# Title\r\n\r\nText\r\n')
    expect(stripFrontMatter('﻿---\nname: x\n---\n\n# Title\n')).toBe('# Title\n')
    expect(stripFrontMatter('--- \nname: x\n---\t\n# Title\n')).toBe('# Title\n')
  })

  it('does not take a block that never closes', () => {
    const open = '---\nname: x\ndescription: y\n\n# Title\n\nText\n'
    expect(stripFrontMatter(open)).toBe(open)
    const longer = '---\nname: x\n----\n# Title\n'
    expect(stripFrontMatter(longer)).toBe(longer)
  })

  it('does not take a block that does not open on the first line', () => {
    const later = '\n---\nname: x\n---\n# Title\n'
    expect(stripFrontMatter(later)).toBe(later)
    const afterText = 'Intro\n---\nname: x\n---\n# Title\n'
    expect(stripFrontMatter(afterText)).toBe(afterText)
    const fourDashes = '----\nname: x\n---\n# Title\n'
    expect(stripFrontMatter(fourDashes)).toBe(fourDashes)
  })

  it('keeps a text that starts with a rule: what follows a leading rule is the text unless it begins with a key', () => {
    const ruleFirst = '---\n\n# Title\n\nText that must stay.\n\n---\n\nMore text\n'
    expect(stripFrontMatter(ruleFirst)).toBe(ruleFirst)
    const prose = '---\nA sentence, not a key.\n---\nMore text\n'
    expect(stripFrontMatter(prose)).toBe(prose)
    const link = '---\nhttps://example.com/page\n---\nMore text\n'
    expect(stripFrontMatter(link)).toBe(link)
    const twoRulesOnly = '---\n---\n# Title\n'
    expect(stripFrontMatter(twoRulesOnly)).toBe(twoRulesOnly)
  })

  it('changes nothing in the text it keeps', () => {
    const kept = stripFrontMatter(WITH_FRONT_MATTER)
    expect(WITH_FRONT_MATTER.endsWith(kept)).toBe(true)
    // Asking again takes nothing more.
    expect(stripFrontMatter(kept)).toBe(kept)
  })
})

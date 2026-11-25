/**
 * The proposal-posted-lines guard catches the posted verifikat of a rättelse
 * or a storno picked by hand, and leaves a reader of one side alone (the
 * review draws the replaced verifikat beside its correction).
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/proposal-posted-lines.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('proposal-posted-lines', () => {
  it.each([
    'const posted = [record(data.correction), record(data.reversal)].find((entry) => isPostingLines(entry.lines))',
    'const lines = (preview.reversal ?? preview.correction)?.lines ?? []',
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    'const lines = postedLines(op.preview_data)',
    'const correction = (data.correction as { lines?: PostingLineLike[] }) || {}',
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})

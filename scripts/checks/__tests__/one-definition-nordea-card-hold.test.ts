/**
 * The Nordea card-hold guard catches the hold's text tested by hand, and
 * leaves calls of the definition and text that only mentions the word.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/nordea-card-hold.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('nordea-card-hold', () => {
  it.each([
    "if (tx.description.startsWith('Reservation ')) return []",
    'const hold = text.trimStart().startsWith("Reservation ")',
    'const hold = /^Reservation /.test(description)',
    'const hold = /^\\s*Reservation\\b/i.test(description)',
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    'bookedEntries.filter(({ tx }) => !isNordeaCardHold(syncOptions?.bankName, tx.description))',
    "const label = 'Reservation Kortköp FACEBK *7K4XZ2PQ9M'",
    "if (text.includes('Reservation no:')) return null",
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})

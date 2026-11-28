/**
 * The id slice guard catches a slice size for `.in()` reads written as a
 * number, and leaves a name that points at the one definition and the batch
 * sizes of other kinds of work.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/id-read-chunk.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('id-read-chunk', () => {
  it.each([
    'const ID_CHUNK = 100',
    'const IN_CLAUSE_CHUNK = 150',
    'export const LINK_LOOKUP_CHUNK = 100',
    'const CLAIM_ID_READ_CHUNK = 100',
    'const ENTRY_ID_CHUNK_SIZE = 200',
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    'export const LINK_LOOKUP_CHUNK = ID_READ_CHUNK',
    'for (const ids of chunk(entryIds, ID_READ_CHUNK)) {',
    'const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024',
    'const INSERT_CHUNK_SIZE = 100',
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})

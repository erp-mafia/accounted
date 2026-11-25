/**
 * The verifikat-shown-amount guard catches a list sorted by a per-row amount
 * column, and leaves the list RPCs' order tokens alone.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/verifikat-shown-amount.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('verifikat-shown-amount', () => {
  it.each([
    "query = query.order('total_amount', { ascending: false })",
    ".order('display_amount', { ascending: key.ascending })",
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    "query = query.order('entry_date', { ascending: key.ascending })",
    "terms.push({ column: 'display_amount', ascending })",
    "const { data, error } = await supabase.rpc('list_verifikat_by_amount', params)",
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})

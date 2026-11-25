/**
 * The guard of the accumulated av- och nedskrivning accounts catches the
 * contra pattern written by hand, and leaves the lines that only look alike.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/accumulated-contra-account.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('accumulated-contra-account', () => {
  it.each([
    'return /^1[012][0-79][89]$/.test(head) || FINANCIAL_ASSET_WRITE_DOWNS.has(head)',
    '/^1[012][0-79][89]$/.test(account.slice(0, 4))',
    'return /^1[0-2]\\d[89]$/.test(account)',
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    'return isAccumulatedContraAccount(account) || FINANCIAL_ASSET_WRITE_DOWNS.has(account.slice(0, 4))',
    'const isConstructionOrAdvance = (account: string) => /^1[012]8/.test(account)',
    "if (/^17[1-4]\\d$/.test(account) || /^179\\d$/.test(account)) return 'expense'",
    "return account >= '1000' && account < '1300' && isImpairment(row)",
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})

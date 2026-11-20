/**
 * The helårsmoms EU-trade guard catches the rule written by hand, and leaves
 * the defaults and reads of the setting that only look alike.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/helarsmoms-eu-trade.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('helarsmoms-eu-trade', () => {
  it.each([
    'const euTrade = settings.vat_has_eu_trade === true || periodHasEuTrade',
    'const euTrade = settings.vat_has_eu_trade || periodHasEuTrade',
    'const early = booksShowEuTrade || settings.vat_has_eu_trade',
    'return ledgerEuTrade || row?.vat_has_eu_trade === true',
    'vat_has_eu_trade: s.vat_has_eu_trade || books,',
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    'const euTrade = helarsmomsHasEuTrade(settings.vat_has_eu_trade, periodHasEuTrade)',
    'vat_has_eu_trade: settings.vat_has_eu_trade ?? false,',
    'vat_has_eu_trade: row?.vat_has_eu_trade ?? null,',
    "if (periodType === 'yearly' && periodHasEuTrade && settings?.vat_has_eu_trade !== true) {",
    'const effectiveEuTrade = body.vat_has_eu_trade ?? oldSettings?.vat_has_eu_trade ?? false',
    "const filingProfileComplete = (euTrade || typeof settings.vat_has_eu_trade === 'boolean')",
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})

/**
 * The migration wizard skipped its mapping page whenever every target was
 * set. Once /sie-data sends class 9 amounts to 2999 OBS-konto (#3312), a
 * fresh company's 9xxx rows are no longer blank, so the wizard would import
 * them onto 2999 without the user ever seeing the suggestion.
 */
import { describe, expect, it } from 'vitest'
import { canSkipMappingStep, type MappingStepRow } from '../lib/mapping-step'
import { obsAccountsOf, suggestSIEMappings } from '@/lib/import/sie-preview-mappings'
import { getMappingStats } from '@/lib/import/account-mapper'
import { parseSIEFile } from '@/lib/import/sie-parser'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'

const row = (sourceAccount: string, targetAccount: string, extra: Partial<MappingStepRow> = {}): MappingStepRow => ({
  sourceAccount, targetAccount, matchType: targetAccount ? 'exact' : 'manual', ...extra,
})

describe('canSkipMappingStep', () => {
  it('skips when every target is set and nothing waits for review', () => {
    expect(canSkipMappingStep([row('1930', '1930'), row('3001', '3001')], { unmapped: 0 })).toBe(true)
  })

  it('shows the page for a blank target', () => {
    expect(canSkipMappingStep([row('1930', '1930'), row('4599', '')], { unmapped: 1 })).toBe(false)
  })

  it('shows the page for an unconfirmed VAT treatment, and skips once it is confirmed', () => {
    expect(canSkipMappingStep([row('3001', '3001', { requiresVatTreatmentReview: true })], { unmapped: 0 })).toBe(false)
    expect(canSkipMappingStep([row('3001', '3001', { requiresVatTreatmentReview: true, vatTreatmentReviewed: true })], { unmapped: 0 })).toBe(true)
  })

  it('shows the page when the server sent a class 9 account to 2999 OBS-konto', () => {
    expect(canSkipMappingStep([row('1930', '1930'), row('9999', '2999', { matchType: 'class' })], { unmapped: 0 })).toBe(false)
  })

  it('skips when the user already chose 2999 by hand, and when everything is already imported', () => {
    expect(canSkipMappingStep([row('9999', '2999', { matchType: 'manual' })], { unmapped: 0 })).toBe(true)
    expect(canSkipMappingStep([row('9999', '2999', { matchType: 'class' }), row('4599', '')], { unmapped: 1, allImported: true })).toBe(true)
  })

  it('shows the page for the /sie-data decision on a fresh company with class 9 amounts', () => {
    // A fresh company: no stored mappings and no 9xxx row in the chart. Before
    // #3312 the 9xxx targets were blank, so the page was shown for them.
    const parsed = parseSIEFile([
      '#SIETYP 4', '#RAR 0 20260101 20261231',
      '#KONTO 1930 "Bank"', '#KONTO 3001 "Försäljning"', '#KONTO 9000 "Tid debet"', '#KONTO 9010 "Tid kredit"',
      '#VER A 1 20260110 "Tidrapport"', '{', '#TRANS 9000 {} 4000', '#TRANS 9010 {} -4000', '}',
      '#VER A 2 20260120 "Försäljning"', '{', '#TRANS 1930 {} 2500', '#TRANS 3001 {} -2500', '}',
    ].join('\n'))
    const { mappings } = suggestSIEMappings(parsed, BAS_REFERENCE)
    const stats = getMappingStats(mappings)
    expect(stats.unmapped).toBe(0)
    expect(mappings.filter((m) => m.targetAccount === '2999').map((m) => m.sourceAccount)).toEqual(['9000', '9010'])
    expect(canSkipMappingStep(mappings, { unmapped: stats.unmapped })).toBe(false)
  })
})

describe('obsAccountsOf coverage for the wizard', () => {
  it('lists only class 9 sources the server sent to 2999, once each and sorted', () => {
    expect(obsAccountsOf([
      row('9999', '2999', { matchType: 'class' }),
      row('9000', '2999', { matchType: 'class' }),
      row('9000', '2999', { matchType: 'class' }),
      // A deliberate choice in a mapping step is not the server's rule.
      row('9010', '2999', { matchType: 'manual' }),
      row('2999', '2999'),
    ])).toEqual(['9000', '9999'])
  })
})

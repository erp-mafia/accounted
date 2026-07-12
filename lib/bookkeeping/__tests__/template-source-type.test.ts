import { describe, it, expect } from 'vitest'
import { sourceTypeForTemplateCategory } from '@/lib/bookkeeping/template-source-type'
import type { BookingTemplateCategory } from '@/types'

describe('sourceTypeForTemplateCategory', () => {
  it('routes the vat category to vat_settlement', () => {
    expect(sourceTypeForTemplateCategory('vat')).toBe('vat_settlement')
  })

  it('returns undefined for categories without a dedicated source type', () => {
    const others: BookingTemplateCategory[] = [
      'eu_trade',
      'tax_account',
      'private_transfer',
      'salary',
      'representation',
      'year_end',
      'financial',
      'other',
    ]
    for (const category of others) {
      expect(sourceTypeForTemplateCategory(category)).toBeUndefined()
    }
  })

  it('returns undefined for null/undefined', () => {
    expect(sourceTypeForTemplateCategory(null)).toBeUndefined()
    expect(sourceTypeForTemplateCategory(undefined)).toBeUndefined()
  })
})

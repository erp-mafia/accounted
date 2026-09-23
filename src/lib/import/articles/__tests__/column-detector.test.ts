import { describe, it, expect } from 'vitest'
import { detectArticleColumns } from '../column-detector'

describe('detectArticleColumns', () => {
  it('detects a rich Swedish header at high confidence', () => {
    const cols = detectArticleColumns([
      'Artikelnummer', 'Benämning', 'Typ', 'Enhet', 'Pris', 'Moms', 'Försäljningskonto',
    ])
    expect(cols.name_col).toBe(1)
    expect(cols.article_number_col).toBe(0)
    expect(cols.type_col).toBe(2)
    expect(cols.unit_col).toBe(3)
    expect(cols.price_col).toBe(4)
    expect(cols.vat_rate_col).toBe(5)
    expect(cols.revenue_account_col).toBe(6)
    expect(cols.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('keeps price, VAT and account in distinct columns (no keyword collision)', () => {
    const cols = detectArticleColumns([
      'Benämning', 'Pris exkl moms', 'Moms %', 'Försäljningskonto',
    ])
    expect(cols.price_col).toBe(1) // "Pris exkl moms" → price, not VAT
    expect(cols.vat_rate_col).toBe(2)
    expect(cols.revenue_account_col).toBe(3)
    expect(cols.price_col).not.toBe(cols.vat_rate_col)
  })

  it('does not read Fortnox "Momskod" as the article number', () => {
    const cols = detectArticleColumns(['Benämning', 'Momskod'])
    expect(cols.vat_rate_col).toBe(1)
    expect(cols.article_number_col).toBeNull()
  })

  it('claims EAN before the generic article number', () => {
    const cols = detectArticleColumns(['Benämning', 'EAN-nummer', 'Artikelnummer'])
    expect(cols.ean_col).toBe(1)
    expect(cols.article_number_col).toBe(2)
  })

  it('detects the English name column separately from the main name', () => {
    const cols = detectArticleColumns(['Benämning', 'Benämning engelska'])
    expect(cols.name_col).toBe(0)
    expect(cols.name_en_col).toBe(1)
  })

  it('detects Fortnox-style headers', () => {
    const cols = detectArticleColumns([
      'Artikelnr', 'Benämning', 'Försäljningspris', 'Inköpspris', 'Momskod', 'Enhet',
    ])
    expect(cols.article_number_col).toBe(0)
    expect(cols.price_col).toBe(2)
    expect(cols.cost_price_col).toBe(3)
    expect(cols.vat_rate_col).toBe(4)
  })

  it('reports low confidence when only a name column is present', () => {
    const cols = detectArticleColumns(['Benämning'])
    expect(cols.name_col).toBe(0)
    expect(cols.confidence).toBeLessThan(0.8)
  })
})

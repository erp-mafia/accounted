import { describe, expect, it } from 'vitest'
import { keepPersonPurchaseCategory, readPurchaseCategoryOverride } from '../purchase-category-override'

const CHOICE = { code: 'expense.equipment.hardware', source: 'person', set_at: '2026-10-15T09:00:00.000Z', set_via: 'dashboard' }
const NEW_READING = { supplier: { name: 'Ny läsning' }, totals: { total: 10 } }

describe('readPurchaseCategoryOverride', () => {
  it('reads a person\'s choice of a known code, and nothing else', () => {
    expect(readPurchaseCategoryOverride({ purchaseCategory: CHOICE })).toBe('expense.equipment.hardware')
    expect(readPurchaseCategoryOverride({ purchaseCategory: { ...CHOICE, source: 'model' } })).toBeNull()
    expect(readPurchaseCategoryOverride({ purchaseCategory: { ...CHOICE, code: 'nope' } })).toBeNull()
    expect(readPurchaseCategoryOverride({ purchaseCategory: null })).toBeNull()
    expect(readPurchaseCategoryOverride(undefined)).toBeNull()
  })
})

describe('keepPersonPurchaseCategory', () => {
  it('carries a person\'s choice onto a replacement reading, untouched', () => {
    expect(keepPersonPurchaseCategory({ supplier: { name: 'Gammal' }, purchaseCategory: CHOICE }, NEW_READING)).toEqual({
      ...NEW_READING,
      purchaseCategory: CHOICE,
    })
  })

  it('lets a replacement that names purchaseCategory win, a clear included', () => {
    const own = { ...NEW_READING, purchaseCategory: { ...CHOICE, code: 'expense.equipment.furniture' } }
    expect(keepPersonPurchaseCategory({ purchaseCategory: CHOICE }, own)).toBe(own)
    const cleared = { ...NEW_READING, purchaseCategory: null }
    expect(keepPersonPurchaseCategory({ purchaseCategory: CHOICE }, cleared)).toBe(cleared)
  })

  it('carries nothing that is not a person\'s choice', () => {
    expect(keepPersonPurchaseCategory({ purchaseCategory: { code: 'expense.equipment.hardware', source: 'model' } }, NEW_READING)).toBe(
      NEW_READING,
    )
    expect(keepPersonPurchaseCategory({ purchaseCategory: 'expense.equipment.hardware' }, NEW_READING)).toBe(NEW_READING)
    expect(keepPersonPurchaseCategory(null, NEW_READING)).toBe(NEW_READING)
    expect(keepPersonPurchaseCategory({}, NEW_READING)).toBe(NEW_READING)
  })

  it('keeps a person\'s choice of a code a later taxonomy version may not list', () => {
    const future = { code: 'software.ai_models', source: 'person', set_at: 'x' }
    expect(keepPersonPurchaseCategory({ purchaseCategory: future }, NEW_READING)).toEqual({ ...NEW_READING, purchaseCategory: future })
  })
})

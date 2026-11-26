import { describe, expect, it } from 'vitest'
import { booksReducer, initialState, stationCount, stationOf, stepAfterBooks, type BooksEntry, type BooksStep } from '../reducer'

const ALL = { hasMigration: true, hasBanking: true, hasSkatteverket: true }
const NONE = { hasMigration: false, hasBanking: false, hasSkatteverket: false }

function entry(over: Partial<BooksEntry> = {}): BooksEntry {
  return { station: null, provider: null, landedFromProvider: false, selectAccounts: null, skvConnected: false, resumeImportId: null, hasBooks: false, ...over }
}

describe('the arrangement with the AI and receipts steps (sourcesFlow)', () => {
  const SRC = { ...ALL, sourcesFlow: true }
  const at = (step: BooksStep, over = {}) => ({ ...initialState(entry()), step, ...over })

  it('orders the steps after the books: bank, ai, docs, skv, done', () => {
    expect(stepAfterBooks(SRC)).toBe('bank')
    expect(booksReducer(at('bank'), { type: 'AFTER_BANK', flags: SRC }).step).toBe('ai')
    expect(booksReducer(at('bank'), { type: 'BANK_SKIP', flags: SRC }).step).toBe('ai')
    expect(booksReducer(at('ai'), { type: 'AFTER_AI', flags: SRC }).step).toBe('docs')
    expect(booksReducer(at('docs'), { type: 'AFTER_DOCS', flags: SRC }).step).toBe('skv')
    expect(booksReducer(at('skv'), { type: 'SKV_SKIP' }).step).toBe('done')
  })

  it('keeps today order without the flag', () => {
    expect(booksReducer(at('bank'), { type: 'AFTER_BANK', flags: ALL }).step).toBe('skv')
    expect(booksReducer(at('skv'), { type: 'GO_BACK', flags: ALL }).step).toBe('bank')
  })

  it('goes one step back along the list', () => {
    expect(booksReducer(at('done'), { type: 'GO_BACK', flags: SRC }).step).toBe('skv')
    expect(booksReducer(at('skv'), { type: 'GO_BACK', flags: SRC }).step).toBe('docs')
    expect(booksReducer(at('docs'), { type: 'GO_BACK', flags: SRC }).step).toBe('ai')
    expect(booksReducer(at('ai'), { type: 'GO_BACK', flags: SRC }).step).toBe('bank')
  })

  it('without banking the AI is the first step after the books and back returns to the books', () => {
    const flags = { ...SRC, hasBanking: false }
    expect(stepAfterBooks(flags)).toBe('ai')
    expect(booksReducer(at('ai'), { type: 'GO_BACK', flags }).step).toBe('source')
    expect(booksReducer(at('ai', { imported: true }), { type: 'GO_BACK', flags }).step).toBe('insight')
  })

  it('without Skatteverket the receipts lead to done', () => {
    const flags = { ...SRC, hasSkatteverket: false }
    expect(booksReducer(at('docs'), { type: 'AFTER_DOCS', flags }).step).toBe('done')
    expect(booksReducer(at('done'), { type: 'GO_BACK', flags }).step).toBe('docs')
  })

  it('without banking and Skatteverket: ai, docs, done', () => {
    const flags = { ...NONE, sourcesFlow: true }
    expect(stepAfterBooks(flags)).toBe('ai')
    expect(booksReducer(at('ai'), { type: 'AFTER_AI', flags }).step).toBe('docs')
    expect(booksReducer(at('docs'), { type: 'AFTER_DOCS', flags }).step).toBe('done')
    expect(booksReducer(at('done'), { type: 'GO_BACK', flags }).step).toBe('docs')
  })

  it('a fresh start lands on the first step after the books', () => {
    expect(booksReducer(at('source'), { type: 'PICK_FRESH', flags: SRC }).step).toBe('bank')
  })

  it('lists six stations with the flag and four without', () => {
    expect(stationCount(SRC)).toBe(6)
    expect(stationCount(ALL)).toBe(4)
    const steps: BooksStep[] = ['source', 'bank', 'ai', 'docs', 'skv', 'done']
    expect(steps.map((s) => stationOf(s, SRC))).toEqual([0, 1, 2, 3, 4, 5])
    expect(stationOf('skv', ALL)).toBe(2)
    expect(stationOf('done')).toBe(3)
  })
})

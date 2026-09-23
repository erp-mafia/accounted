import { describe, expect, it } from 'vitest'
import { booksReducer, initialState, stationOf, stepAfterBooks, type BooksEntry } from '../reducer'

const ALL = { hasMigration: true, hasBanking: true, hasSkatteverket: true }
const NONE = { hasMigration: false, hasBanking: false, hasSkatteverket: false }

function entry(over: Partial<BooksEntry> = {}): BooksEntry {
  return { station: null, provider: null, landedFromProvider: false, selectAccounts: null, skvConnected: false, resumeImportId: null, hasBooks: false, ...over }
}

describe('initialState from the server', () => {
  it('follows a running import job before anything the query string says', () => {
    const s = initialState(entry({ resumeImportId: 'job-1', provider: 'fortnox', landedFromProvider: true, hasBooks: true }))
    expect(s.step).toBe('resume')
    expect(s.path).toBe('migration')
  })

  it('opens on the genomlysning when the books are already here', () => {
    const s = initialState(entry({ hasBooks: true }))
    expect(s.step).toBe('insight')
    expect(s.imported).toBe(true)
  })

  it('a callback landing still wins: the bank and Skatteverket returns are mid-act', () => {
    expect(initialState(entry({ hasBooks: true, station: 'bank' })).step).toBe('bank')
    expect(initialState(entry({ resumeImportId: 'job-1', station: 'skv' })).step).toBe('skv')
  })

  it('a provider round trip still lands on the provider step, books or not', () => {
    expect(initialState(entry({ hasBooks: true, landedFromProvider: true })).step).toBe('provider')
  })

  it('back from the resume step returns to the source list', () => {
    const s = booksReducer(initialState(entry({ resumeImportId: 'job-1' })), { type: 'GO_BACK', flags: ALL })
    expect(s.step).toBe('source')
  })
})

describe('initialState', () => {
  it('starts at the source question', () => {
    const s = initialState(entry())
    expect(s.step).toBe('source')
    expect(s.bankPhase).toBe('pick')
    expect(s.skvPhase).toBe('open')
  })

  it('mounts the bank step in the authed phase when the callback brought select_accounts', () => {
    const s = initialState(entry({ station: 'bank', selectAccounts: 'conn-1' }))
    expect(s.step).toBe('bank')
    expect(s.bankPhase).toBe('authed')
    expect(s.bankConnectionId).toBe('conn-1')
  })

  it('mounts Skatteverket in the back phase after the callback', () => {
    expect(initialState(entry({ station: 'skv', skvConnected: true })).skvPhase).toBe('back')
    expect(initialState(entry({ station: 'skv' })).skvPhase).toBe('open')
  })

  it('a provider deep link lands on the API step, SIE-first providers on the SIE step', () => {
    expect(initialState(entry({ provider: 'fortnox' })).step).toBe('provider')
    expect(initialState(entry({ provider: 'visma' })).step).toBe('sie')
    expect(initialState(entry({ landedFromProvider: true })).step).toBe('provider')
  })
})

describe('booksReducer', () => {
  it('routes providers by whether their API hands out the ledger', () => {
    const s0 = initialState(entry())
    expect(booksReducer(s0, { type: 'PICK_PROVIDER', provider: 'fortnox' }).step).toBe('provider')
    expect(booksReducer(s0, { type: 'PICK_PROVIDER', provider: 'bokio' }).step).toBe('sie')
    expect(booksReducer(s0, { type: 'PICK_SIE' }).path).toBe('migration')
  })

  it('a new business skips the books and goes where the flags allow', () => {
    const s0 = initialState(entry())
    expect(booksReducer(s0, { type: 'PICK_FRESH', flags: ALL }).step).toBe('bank')
    expect(booksReducer(s0, { type: 'PICK_FRESH', flags: { ...ALL, hasBanking: false } }).step).toBe('skv')
    expect(booksReducer(s0, { type: 'PICK_FRESH', flags: NONE }).step).toBe('done')
    expect(stepAfterBooks(NONE)).toBe('done')
  })

  it('IMPORTED collects the account numbers without duplicates', () => {
    let s = initialState(entry())
    s = booksReducer(s, { type: 'IMPORTED', accounts: ['3001', '3041'] })
    s = booksReducer(s, { type: 'IMPORTED', accounts: ['3041', '4010'] })
    expect(s.imported).toBe(true)
    expect(s.importedAccounts).toEqual(['3001', '3041', '4010'])
  })

  it('walks the bank round trip', () => {
    let s = initialState(entry())
    s = booksReducer(s, { type: 'PICK_FRESH', flags: ALL })
    s = booksReducer(s, { type: 'BANK_PICKED', name: 'Swedbank' })
    expect(s.bankPhase).toBe('connecting')
    expect(s.working).toBe(true)
    s = booksReducer(s, { type: 'BANK_AUTHED', name: 'Swedbank', connectionId: 'c1' })
    expect(s.bankPhase).toBe('authed')
    expect(s.working).toBe(false)
    s = booksReducer(s, { type: 'BANK_FETCH' })
    expect(s.bankPhase).toBe('fetching')
    s = booksReducer(s, { type: 'BANK_CONNECTED' })
    expect(s.bankPhase).toBe('connected')
    s = booksReducer(s, { type: 'AFTER_BANK', flags: ALL })
    expect(s.step).toBe('skv')
    expect(stationOf(s.step)).toBe(2)
  })

  it('skipping the bank remembers it on the rail', () => {
    const s = booksReducer(initialState(entry({ station: 'bank' })), { type: 'BANK_SKIP', flags: ALL })
    expect(s.bankSkipped).toBe(true)
    expect(s.step).toBe('skv')
  })

  it('the Skatteverket phases drive the orb', () => {
    let s = initialState(entry({ station: 'skv' }))
    s = booksReducer(s, { type: 'SKV_PHASE', phase: 'leaving' })
    expect(s.working).toBe(true)
    s = booksReducer(s, { type: 'SKV_PHASE', phase: 'away' })
    expect(s.working).toBe(true)
    s = booksReducer(s, { type: 'SKV_PHASE', phase: 'back' })
    expect(s.working).toBe(false)
    s = booksReducer(s, { type: 'SKV_PHASE', phase: 'done' })
    s = booksReducer(s, { type: 'TO_DONE' })
    expect(s.step).toBe('done')
    expect(stationOf('done')).toBe(3)
  })

  it('GO_BACK walks one step back along the rail', () => {
    let s = initialState(entry({ station: 'bank', selectAccounts: 'c1' }))
    s = booksReducer(s, { type: 'GO_BACK', flags: ALL })
    expect(s.bankPhase).toBe('pick')
    expect(s.bankConnectionId).toBeNull()
    s = booksReducer(s, { type: 'GO_BACK', flags: ALL })
    expect(s.step).toBe('source')
    s = booksReducer(initialState(entry({ station: 'skv' })), { type: 'GO_BACK', flags: ALL })
    expect(s.step).toBe('bank')
    s = booksReducer({ ...initialState(entry()), step: 'done' }, { type: 'GO_BACK', flags: ALL })
    expect(s.step).toBe('skv')
    s = booksReducer({ ...initialState(entry()), step: 'bank', imported: true }, { type: 'GO_BACK', flags: ALL })
    expect(s.step).toBe('insight')
    // A fetched bank re-enters on its verdict: the pour never replays.
    s = booksReducer({ ...initialState(entry()), step: 'skv', bankPhase: 'connected', bankConnectionId: 'c1' }, { type: 'GO_BACK', flags: ALL })
    expect(s.step).toBe('bank')
    expect(s.bankPhase).toBe('pick')
    expect(s.bankConnectionId).toBe('c1')
    const src = initialState(entry())
    expect(booksReducer(src, { type: 'GO_BACK', flags: ALL })).toBe(src)
  })

  it('SET_WORKING returns the same state when nothing changes', () => {
    const s = initialState(entry())
    expect(booksReducer(s, { type: 'SET_WORKING', working: false })).toBe(s)
    expect(booksReducer(s, { type: 'SET_WORKING', working: true }).working).toBe(true)
  })

  it('restores navigation without forgetting committed books or replaying bank sync', () => {
    const imported = { ...initialState(entry()), imported: true, importedAccounts: ['1930'] }
    const saved = { ...initialState(entry()), step: 'bank' as const, bankPhase: 'fetching' as const, working: true }
    const restored = booksReducer(imported, { type: 'RESTORE', state: saved })
    expect(restored).toMatchObject({ step: 'bank', imported: true, importedAccounts: ['1930'], bankPhase: 'pick', working: false })
  })

  it('keeps bank account selections on restore and clears them for a different connection', () => {
    const saved = { ...initialState(entry()), bankConnectionId: 'connection-1', bankPhase: 'authed' as const, bankDraft: { ticked: { account: true }, picks: { account: '1930' }, mode: 'date' as const, customDate: '2026-01-01' } }
    const restored = booksReducer(initialState(entry()), { type: 'RESTORE', state: saved })
    expect(restored.bankDraft).toEqual(saved.bankDraft)
    expect(booksReducer(restored, { type: 'BANK_AUTHED', connectionId: 'connection-2', name: 'Acme Bank' }).bankDraft).toBeUndefined()
  })

  it('skips unavailable stations when going back from a redirect entry', () => {
    const flags = { hasMigration: true, hasBanking: false, hasSkatteverket: false }
    expect(booksReducer({ ...initialState(entry()), step: 'done' }, { type: 'GO_BACK', flags }).step).toBe('source')
    expect(booksReducer({ ...initialState(entry()), step: 'skv', imported: true }, { type: 'GO_BACK', flags }).step).toBe('insight')
  })
})

/**
 * Act two of the onboarding journey (issue #2438): the step machine for
 * Böckerna, Banken, Skatteverket, Klart. Pure and tested; the component
 * only dispatches. Sub-phases inside a step (the bank round trip, the
 * Skatteverket handshake) live here too so a redirect return can mount
 * straight into the right phase from the URL.
 */

export type BooksStep = 'source' | 'sie' | 'provider' | 'resume' | 'insight' | 'bank' | 'skv' | 'done'
export type BooksStation = 0 | 1 | 2 | 3
export type SourcePath = 'migration' | 'fresh' | null
export type BankPhase = 'pick' | 'connecting' | 'authed' | 'fetching' | 'connected'
export type SkvPhase = 'open' | 'leaving' | 'away' | 'back' | 'done'

/** Providers whose API does not hand out the ledger: SIE first, registers after. */
export const SIE_FIRST_PROVIDERS = new Set(['visma', 'bokio'])

export interface BooksFlags {
  hasMigration: boolean
  hasBanking: boolean
  hasSkatteverket: boolean
}

export interface BooksState {
  step: BooksStep
  path: SourcePath
  provider: string | null
  /** The books arrived in this session (or were already here). */
  imported: boolean
  /** Account numbers the import brought in: the momskod check reads these. */
  importedAccounts: string[]
  /** Something is running: the orb works. */
  working: boolean
  bankPhase: BankPhase
  bankName: string | null
  bankConnectionId: string | null
  bankSkipped: boolean
  skvPhase: SkvPhase
  skvSkipped: boolean
  bankDraft?: {
    ticked: Record<string, boolean>
    picks: Record<string, string>
    mode: 'auto' | '90' | 'fy' | 'date'
    customDate: string
  }
}

export type BooksAction =
  | { type: 'RESTORE'; state: BooksState }
  | { type: 'BANK_DRAFT'; draft: NonNullable<BooksState['bankDraft']> }
  | { type: 'PICK_PROVIDER'; provider: string }
  | { type: 'PICK_SIE' }
  | { type: 'PICK_FRESH'; flags: BooksFlags }
  | { type: 'BACK_TO_SOURCE' }
  | { type: 'IMPORTED'; accounts?: string[] }
  | { type: 'SET_WORKING'; working: boolean }
  | { type: 'TO_INSIGHT' }
  | { type: 'AFTER_BOOKS'; flags: BooksFlags }
  | { type: 'BANK_PICKED'; name: string }
  | { type: 'BANK_PICK_FAILED' }
  | { type: 'BANK_AUTHED'; name: string; connectionId: string }
  | { type: 'BANK_FETCH' }
  | { type: 'BANK_CONNECTED' }
  | { type: 'BANK_SKIP'; flags: BooksFlags }
  | { type: 'AFTER_BANK'; flags: BooksFlags }
  | { type: 'SKV_PHASE'; phase: SkvPhase }
  | { type: 'SKV_SKIP' }
  | { type: 'TO_DONE' }
  | { type: 'GO_BACK'; flags: BooksFlags }

const STATION_OF: Record<BooksStep, BooksStation> = {
  source: 0,
  sie: 0,
  provider: 0,
  resume: 0,
  insight: 0,
  bank: 1,
  skv: 2,
  done: 3,
}

export function stationOf(step: BooksStep): BooksStation {
  return STATION_OF[step]
}

/** The step after the books: the bank if it exists, else Skatteverket, else done. */
export function stepAfterBooks(flags: BooksFlags): BooksStep {
  return flags.hasBanking ? 'bank' : flags.hasSkatteverket ? 'skv' : 'done'
}

export function stepAfterBank(flags: BooksFlags): BooksStep {
  return flags.hasSkatteverket ? 'skv' : 'done'
}

export interface BooksEntry {
  /** ?station= from the gate rewrite or the Skatteverket return. */
  station: string | null
  /** ?provider= deep link. */
  provider: string | null
  /** The provider OAuth round trip landed here (?migration= / ?consentId= / ?handoff=). */
  landedFromProvider: boolean
  /** ?select_accounts= from the bank callback: the bank is authed, accounts wait. */
  selectAccounts: string | null
  /** ?skv_connected=true from the Skatteverket callback. */
  skvConnected: boolean
  /** An import job still running or paused on the server (lib/onboarding-books/resume). */
  resumeImportId: string | null
  /** Posted entries already exist: the books are here, whatever the browser remembers. */
  hasBooks: boolean
}

export function initialState(entry: BooksEntry): BooksState {
  const base: BooksState = {
    step: 'source',
    path: null,
    provider: entry.provider,
    imported: false,
    importedAccounts: [],
    working: false,
    bankPhase: 'pick',
    bankName: null,
    bankConnectionId: null,
    bankSkipped: false,
    skvPhase: 'open',
    skvSkipped: false,
  }
  if (entry.selectAccounts) {
    return { ...base, step: 'bank', bankPhase: 'authed', bankConnectionId: entry.selectAccounts }
  }
  if (entry.station === 'bank') return { ...base, step: 'bank' }
  if (entry.station === 'skv') {
    return { ...base, step: 'skv', skvPhase: entry.skvConnected ? 'back' : 'open' }
  }
  // The server's word beats the query string from here: a running import
  // is followed, existing books open on the genomlysning (founder direction
  // 2026-09-14: a reload must never restart at "Var fanns bokföringen?").
  if (entry.resumeImportId) return { ...base, step: 'resume', path: 'migration' }
  if (entry.landedFromProvider || (entry.provider && !SIE_FIRST_PROVIDERS.has(entry.provider))) {
    return { ...base, step: 'provider', path: 'migration' }
  }
  if (entry.provider) return { ...base, step: 'sie', path: 'migration' }
  if (entry.hasBooks) return { ...base, step: 'insight', path: 'migration', imported: true }
  return base
}

export function booksReducer(state: BooksState, action: BooksAction): BooksState {
  switch (action.type) {
    case 'RESTORE': {
      const restored = action.state
      return {
        ...restored,
        imported: state.imported || restored.imported,
        importedAccounts: Array.from(new Set([...state.importedAccounts, ...restored.importedAccounts])),
        working: false,
        // Completed work is read from findings; never replay a fetch animation.
        bankPhase: restored.bankPhase === 'authed' ? 'authed' : 'pick',
        skvPhase: 'open',
      }
    }
    case 'BANK_DRAFT':
      return { ...state, bankDraft: action.draft }
    case 'PICK_PROVIDER':
      return {
        ...state,
        provider: action.provider,
        path: 'migration',
        step: SIE_FIRST_PROVIDERS.has(action.provider) ? 'sie' : 'provider',
      }
    case 'PICK_SIE':
      return { ...state, provider: null, path: 'migration', step: 'sie' }
    case 'PICK_FRESH':
      return { ...state, path: 'fresh', step: stepAfterBooks(action.flags) }
    case 'BACK_TO_SOURCE':
      return { ...state, step: 'source', provider: null, working: false }
    case 'IMPORTED':
      return {
        ...state,
        imported: true,
        path: state.path ?? 'migration',
        importedAccounts: action.accounts
          ? Array.from(new Set([...state.importedAccounts, ...action.accounts]))
          : state.importedAccounts,
      }
    case 'SET_WORKING':
      return state.working === action.working ? state : { ...state, working: action.working }
    case 'TO_INSIGHT':
      return { ...state, step: 'insight', working: false }
    case 'AFTER_BOOKS':
      return { ...state, step: stepAfterBooks(action.flags) }
    case 'BANK_PICKED':
      return { ...state, bankPhase: 'connecting', bankName: action.name, working: true }
    case 'BANK_PICK_FAILED':
      return { ...state, bankPhase: 'pick', working: false }
    case 'BANK_AUTHED':
      return {
        ...state,
        step: 'bank',
        bankPhase: 'authed',
        bankName: action.name,
        bankConnectionId: action.connectionId,
        bankDraft: action.connectionId === state.bankConnectionId ? state.bankDraft : undefined,
        working: false,
      }
    case 'BANK_FETCH':
      return { ...state, bankPhase: 'fetching', working: true }
    case 'BANK_CONNECTED':
      return { ...state, bankPhase: 'connected', working: false }
    case 'BANK_SKIP':
      return { ...state, bankSkipped: true, step: stepAfterBank(action.flags), working: false }
    case 'AFTER_BANK':
      return { ...state, step: stepAfterBank(action.flags) }
    case 'SKV_PHASE':
      return {
        ...state,
        skvPhase: action.phase,
        working: action.phase === 'leaving' || action.phase === 'away',
      }
    case 'SKV_SKIP':
      return { ...state, skvSkipped: true, step: 'done', working: false }
    case 'TO_DONE':
      return { ...state, step: 'done', working: false }
    case 'GO_BACK': {
      // One step back along the rail. Inside the bank step, back from the
      // accounts returns to the bank list; the pending connection row stays.
      switch (state.step) {
        case 'sie':
        case 'provider':
        case 'resume':
        case 'insight':
          return { ...state, step: 'source', provider: null, working: false }
        case 'bank':
          if (state.bankPhase === 'authed') return { ...state, bankPhase: 'pick', bankConnectionId: null, working: false }
          // Past the fetch the connection is real: the step re-enters on its verdict, never on the pour.
          return { ...state, step: state.imported ? 'insight' : 'source', bankPhase: 'pick', bankConnectionId: null, bankSkipped: false, working: false }
        case 'skv':
          return { ...state, step: !action.flags.hasBanking ? state.imported ? 'insight' : 'source' : 'bank', bankPhase: 'pick', skvSkipped: false, skvPhase: 'open', working: false }
        case 'done':
          return { ...state, step: !action.flags.hasSkatteverket ? action.flags.hasBanking ? 'bank' : state.imported ? 'insight' : 'source' : 'skv', working: false }
        default:
          return state
      }
    }
  }
}

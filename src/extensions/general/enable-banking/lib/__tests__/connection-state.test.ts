import { describe, it, expect } from 'vitest'
import {
  buildPageAttentionSentence,
  getConnectionUiState,
  selectPageAttention,
  sortConnectionsByPrecedence,
  EXPIRY_WARNING_DAYS,
  STALE_SYNC_DAYS,
  PENDING_ABANDON_MS,
} from '../connection-state'

const NOW = new Date('2026-08-19T12:00:00Z').getTime()
const DAY_MS = 24 * 60 * 60 * 1000

function iso(offsetDays: number): string {
  return new Date(NOW + offsetDays * DAY_MS).toISOString()
}

function conn(overrides: {
  status?: string
  consent_expires?: string | null
  last_synced_at?: string | null
  created_at?: string
  bank_name?: string
  error_message?: string | null
}) {
  return {
    status: 'active',
    consent_expires: iso(60),
    last_synced_at: iso(-1),
    created_at: iso(-30),
    bank_name: 'SEB',
    ...overrides,
  }
}

describe('getConnectionUiState', () => {
  it('maps DB statuses straight through', () => {
    expect(getConnectionUiState(conn({ status: 'pending_selection' }), NOW)).toBe('pending_selection')
    expect(getConnectionUiState(conn({ status: 'pending', created_at: new Date(NOW - 5000).toISOString() }), NOW)).toBe('pending')
    expect(getConnectionUiState(conn({ status: 'error' }), NOW)).toBe('error')
    expect(getConnectionUiState(conn({ status: 'expired' }), NOW)).toBe('expired')
  })

  it('treats a pending row older than the abandon window as an abandoned attempt', () => {
    const justStarted = new Date(NOW - 30 * 1000).toISOString()
    expect(getConnectionUiState(conn({ status: 'pending', created_at: justStarted }), NOW)).toBe('pending')
    const atWindow = new Date(NOW - PENDING_ABANDON_MS).toISOString()
    expect(getConnectionUiState(conn({ status: 'pending', created_at: atWindow }), NOW)).toBe('abandoned')
    const halfHour = new Date(NOW - 28 * 60 * 1000).toISOString()
    expect(getConnectionUiState(conn({ status: 'pending', created_at: halfHour }), NOW)).toBe('abandoned')
  })

  it('keeps a pending row pending when created_at is unknown', () => {
    const { created_at: _omit, ...row } = conn({ status: 'pending' })
    void _omit
    expect(getConnectionUiState(row, NOW)).toBe('pending')
  })

  it('classifies a healthy active row as active', () => {
    expect(getConnectionUiState(conn({}), NOW)).toBe('active')
  })

  it('flags consent expiring within the warning window', () => {
    expect(
      getConnectionUiState(conn({ consent_expires: iso(EXPIRY_WARNING_DAYS - 1) }), NOW),
    ).toBe('expiring')
    expect(
      getConnectionUiState(conn({ consent_expires: iso(EXPIRY_WARNING_DAYS + 1) }), NOW),
    ).toBe('active')
  })

  it('expiring beats stale on the same row', () => {
    expect(
      getConnectionUiState(
        conn({ consent_expires: iso(2), last_synced_at: iso(-10) }),
        NOW,
      ),
    ).toBe('expiring')
  })

  it('flags stale and never-synced active rows', () => {
    expect(
      getConnectionUiState(conn({ last_synced_at: iso(-STALE_SYNC_DAYS) }), NOW),
    ).toBe('stale')
    expect(
      getConnectionUiState(conn({ last_synced_at: iso(-(STALE_SYNC_DAYS - 1)) }), NOW),
    ).toBe('active')
    expect(getConnectionUiState(conn({ last_synced_at: null }), NOW)).toBe('never_synced')
  })

  it('handles a row with no consent date', () => {
    expect(getConnectionUiState(conn({ consent_expires: null }), NOW)).toBe('active')
  })
})

describe('sortConnectionsByPrecedence', () => {
  it('orders pending_selection, pending, error, expired, expiring, active', () => {
    const rows = [
      conn({ bank_name: 'Healthy' }),
      conn({ bank_name: 'Expiring', consent_expires: iso(2) }),
      conn({ bank_name: 'Expired', status: 'expired' }),
      conn({ bank_name: 'Errored', status: 'error' }),
      conn({ bank_name: 'InFlight', status: 'pending' }),
      conn({ bank_name: 'PickAccounts', status: 'pending_selection' }),
    ]
    expect(sortConnectionsByPrecedence(rows, NOW).map((r) => r.bank_name)).toEqual([
      'PickAccounts',
      'InFlight',
      'Errored',
      'Expired',
      'Expiring',
      'Healthy',
    ])
  })

  it('breaks ties by newest created_at first and does not mutate the input', () => {
    const older = conn({ bank_name: 'Older', created_at: iso(-100) })
    const newer = conn({ bank_name: 'Newer', created_at: iso(-1) })
    const rows = [older, newer]
    const sorted = sortConnectionsByPrecedence(rows, NOW)
    expect(sorted.map((r) => r.bank_name)).toEqual(['Newer', 'Older'])
    expect(rows[0]).toBe(older)
  })
})

describe('selectPageAttention', () => {
  it('returns null when every connection is healthy or has no attention state', () => {
    expect(selectPageAttention([conn({})], NOW)).toBeNull()
    expect(selectPageAttention([conn({ status: 'pending_selection' })], NOW)).toBeNull()
    expect(selectPageAttention([], NOW)).toBeNull()
  })

  it('picks the worst state: error beats expired beats expiring beats stale', () => {
    const errored = conn({ bank_name: 'Errored', status: 'error' })
    const expired = conn({ bank_name: 'Expired', status: 'expired' })
    const expiring = conn({ bank_name: 'Expiring', consent_expires: iso(2) })
    const stale = conn({ bank_name: 'Stale', last_synced_at: iso(-10) })

    expect(selectPageAttention([stale, expiring, expired, errored], NOW)?.connection.bank_name).toBe('Errored')
    expect(selectPageAttention([stale, expiring, expired], NOW)?.connection.bank_name).toBe('Expired')
    expect(selectPageAttention([stale, expiring], NOW)?.connection.bank_name).toBe('Expiring')
    expect(selectPageAttention([stale], NOW)?.state).toBe('stale')
  })
})

describe('buildPageAttentionSentence', () => {
  it('names the bank and the state', () => {
    const attention = selectPageAttention([conn({ status: 'expired' })], NOW)!
    expect(buildPageAttentionSentence(attention, NOW)).toBe(
      'SEB: PSD2-samtycket har löpt ut. Förnya samtycket för att återuppta synkroniseringen.',
    )
  })

  it('counts days for the expiring state with singular/plural', () => {
    const one = selectPageAttention([conn({ consent_expires: iso(1) })], NOW)!
    expect(buildPageAttentionSentence(one, NOW)).toContain('går ut om 1 dag.')
    const five = selectPageAttention([conn({ consent_expires: iso(5) })], NOW)!
    expect(buildPageAttentionSentence(five, NOW)).toContain('går ut om 5 dagar.')
  })

  it('counts days since sync for the stale state', () => {
    const attention = selectPageAttention([conn({ last_synced_at: iso(-10) })], NOW)!
    expect(buildPageAttentionSentence(attention, NOW)).toContain('ingen synkning på 10 dagar')
  })

  it('tells the user to start over for an abandoned attempt, and a fresh attempt earns no sentence', () => {
    const stale = new Date(NOW - PENDING_ABANDON_MS - 1000).toISOString()
    const attention = selectPageAttention(
      [conn({ status: 'pending', created_at: stale, bank_name: 'Handelsbanken' })],
      NOW,
    )!
    expect(attention.state).toBe('abandoned')
    expect(buildPageAttentionSentence(attention, NOW)).toBe(
      'Handelsbanken: anslutningen slutfördes inte hos banken. Starta bankkopplingen på nytt och slutför alla steg direkt.',
    )
    const fresh = new Date(NOW - 5000).toISOString()
    expect(selectPageAttention([conn({ status: 'pending', created_at: fresh })], NOW)).toBeNull()
  })
})

describe('needs_configuration (sync stopped on a stale account selection)', () => {
  const advice = 'Banksynkningen har stannat: kontovalet behöver sparas om.'

  it('derives it from a stored message on an active row, ahead of an expiring consent', () => {
    expect(getConnectionUiState(conn({ error_message: advice }), NOW)).toBe('needs_configuration')
    expect(getConnectionUiState(conn({ error_message: advice, consent_expires: iso(2) }), NOW)).toBe('needs_configuration')
    expect(getConnectionUiState(conn({ error_message: null }), NOW)).toBe('active')
    expect(getConnectionUiState(conn({ status: 'error', error_message: advice }), NOW)).toBe('error')
  })

  it('earns the page sentence over an expiring consent, pointing at the account picker', () => {
    const stopped = conn({ bank_name: 'SEB', error_message: advice })
    const expiring = conn({ bank_name: 'Nordea', consent_expires: iso(2) })
    const attention = selectPageAttention([expiring, stopped], NOW)
    expect(attention).toEqual({ state: 'needs_configuration', connection: stopped })
    expect(buildPageAttentionSentence(attention!, NOW)).toBe(
      'SEB: synkningen har stannat. Öppna Välj konton och spara kontovalet igen.',
    )
  })
})

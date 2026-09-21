import { describe, it, expect } from 'vitest'
import {
  backfillDateErrorMessage,
  connectionStartMs,
  isBeforeFirstAdvance,
  parseBackfillFrom,
  resolveWindowStartMs,
  type CursorWindowConnection,
} from '../cursor-window'

const CONNECTED_AT = '2026-09-09T10:00:00.000Z'
const CREATED_AT = '2026-09-09T09:59:00.000Z'
const OVERLAP_MS = 24 * 60 * 60 * 1000

function connection(overrides: Partial<CursorWindowConnection> = {}): CursorWindowConnection {
  return { cursor: CONNECTED_AT, connectedAt: CONNECTED_AT, createdAt: CREATED_AT, ...overrides }
}

const iso = (ms: number) => new Date(ms).toISOString()

describe('connectionStartMs', () => {
  it('prefers connected_at, then created_at, then now', () => {
    expect(iso(connectionStartMs(connection()))).toBe(CONNECTED_AT)
    expect(iso(connectionStartMs(connection({ connectedAt: null })))).toBe(CREATED_AT)
    const now = Date.parse('2026-09-20T00:00:00.000Z')
    expect(connectionStartMs({ connectedAt: null, createdAt: null }, now)).toBe(now)
    expect(connectionStartMs({ connectedAt: 'not a date', createdAt: null }, now)).toBe(now)
  })
})

describe('resolveWindowStartMs', () => {
  it('starts the first sync at the connection moment, not a day earlier', () => {
    // The activation path seeds the cursor with connected_at; the overlap
    // must not drag the window back into sales the user booked from the bank.
    expect(iso(resolveWindowStartMs(connection(), OVERLAP_MS))).toBe(CONNECTED_AT)
  })

  it('keeps the overlap once the cursor has moved past the connection', () => {
    const start = resolveWindowStartMs(
      connection({ cursor: '2026-09-20T10:00:00.000Z' }),
      OVERLAP_MS,
    )
    expect(iso(start)).toBe('2026-09-19T10:00:00.000Z')
  })

  it('clamps the overlap at the connection moment while still within a day of it', () => {
    const start = resolveWindowStartMs(
      connection({ cursor: '2026-09-09T18:00:00.000Z' }),
      OVERLAP_MS,
    )
    expect(iso(start)).toBe(CONNECTED_AT)
  })

  it("falls back to the connection's own start when the cursor is null or unreadable", () => {
    expect(iso(resolveWindowStartMs(connection({ cursor: null }), OVERLAP_MS))).toBe(CONNECTED_AT)
    expect(
      iso(resolveWindowStartMs(connection({ cursor: null, connectedAt: null }), OVERLAP_MS)),
    ).toBe(CREATED_AT)
    expect(iso(resolveWindowStartMs(connection({ cursor: 'garbage' }), OVERLAP_MS))).toBe(
      CONNECTED_AT,
    )
  })

  it('honours an explicit backfill cursor exactly, without reaching a day further back', () => {
    const start = resolveWindowStartMs(
      connection({ cursor: '2026-01-01T00:00:00.000Z' }),
      OVERLAP_MS,
    )
    expect(iso(start)).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('isBeforeFirstAdvance', () => {
  it('is true until the cursor has passed the connection moment', () => {
    expect(isBeforeFirstAdvance(connection({ cursor: null }))).toBe(true)
    expect(isBeforeFirstAdvance(connection())).toBe(true)
    expect(isBeforeFirstAdvance(connection({ cursor: '2026-01-01T00:00:00.000Z' }))).toBe(true)
    expect(isBeforeFirstAdvance(connection({ cursor: '2026-09-09T10:00:01.000Z' }))).toBe(false)
  })
})

describe('parseBackfillFrom', () => {
  const now = new Date('2026-09-14T12:00:00.000Z')

  it('accepts a plain date and pins it to midnight UTC', () => {
    expect(parseBackfillFrom('2026-01-01', 3, now)).toEqual({ iso: '2026-01-01T00:00:00.000Z' })
  })

  it('rejects anything that is not a YYYY-MM-DD string', () => {
    expect(parseBackfillFrom(undefined, 3, now)).toEqual({ error: 'invalid' })
    expect(parseBackfillFrom('2026-1-1', 3, now)).toEqual({ error: 'invalid' })
    expect(parseBackfillFrom(20260101, 3, now)).toEqual({ error: 'invalid' })
  })

  it('rejects a day that does not exist instead of rolling it over', () => {
    // Date.parse turns 2026-02-31T00:00:00Z into 3 March.
    expect(parseBackfillFrom('2026-02-31', 3, now)).toEqual({ error: 'invalid' })
  })

  it('rejects a future start date', () => {
    expect(parseBackfillFrom('2026-09-15', 3, now)).toEqual({ error: 'future' })
  })

  it('caps how far back a backfill may reach', () => {
    const floor = new Date(now)
    floor.setUTCFullYear(floor.getUTCFullYear() - 3)
    const justInside = new Date(floor.getTime() + 86_400_000).toISOString().slice(0, 10)
    const tooOld = new Date(floor.getTime() - 2 * 86_400_000).toISOString().slice(0, 10)
    expect(parseBackfillFrom(justInside, 3, now)).toHaveProperty('iso')
    expect(parseBackfillFrom(tooOld, 3, now)).toEqual({ error: 'too_old' })
    expect(parseBackfillFrom(tooOld, 5, now)).toHaveProperty('iso')
  })
})

describe('backfillDateErrorMessage', () => {
  it('names the cap in the too_old sentence', () => {
    expect(backfillDateErrorMessage('too_old', 3)).toContain('3 år')
    expect(backfillDateErrorMessage('invalid', 3)).toMatch(/startdatum/)
    expect(backfillDateErrorMessage('future', 3)).toMatch(/framtiden/)
  })
})

/**
 * Tests for sync resilience against SKV transaktioner rows that cannot
 * satisfy the table's NOT NULL columns (transaktionsdatum, transaktionstext,
 * belopp_skatteverket).
 *
 * SKV has been observed returning a row without beloppSkatteverket; before
 * the guard, one such row failed the whole batch upsert (23502) and with it
 * every sync for the company: post-connect, manual and the nightly cron.
 * The guard skips unusable rows, syncs the rest, and reports the count.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const getSaldoMock = vi.fn()
const getTransaktionerMock = vi.fn()
vi.mock('../lib/skattekonto-client', () => ({
  getSaldo: (...args: unknown[]) => getSaldoMock(...args),
  getTransaktioner: (...args: unknown[]) => getTransaktionerMock(...args),
}))

vi.mock('../lib/agi-tax-settlement', () => ({
  settleAgiTaxPayments: vi.fn().mockResolvedValue(undefined),
}))

const warnMock = vi.fn()
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: (...args: unknown[]) => warnMock(...args),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { syncSkattekonto, SKATTEKONTO_SKIPPED_ROWS_KEY } from '../lib/skattekonto-sync'
import type { ExtensionContext } from '@/lib/extensions/types'

const settingsSetMock = vi.fn().mockResolvedValue(undefined)

function makeCtx(): ExtensionContext {
  return {
    supabase,
    companyId: 'company-1',
    userId: 'user-1',
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: settingsSetMock,
    },
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as ExtensionContext
}

function skippedRowsWrites() {
  return settingsSetMock.mock.calls.filter(
    ([key]) => key === SKATTEKONTO_SKIPPED_ROWS_KEY,
  )
}

function makeSaldo() {
  return {
    nastaAvstamningsdatum: '2026-09-05',
    senastUppdaterad: '2026-08-17',
    informationstext: [],
    saldoSkatteverket: 1000,
    saldoKronofogden: 0,
    rantaSkatteverket: 0,
    rantaKronofogden: 0,
    ocrNummer: '1234567897',
  }
}

const VALID_BOOKED_A = {
  transaktionsidentitet: 9001,
  transaktionsdatum: '2026-07-13',
  ranteberakningsdatum: '2026-07-13',
  transaktionstext: 'Arbetsgivaravgift juni 2026',
  beloppSkatteverket: -15710,
  beloppKronofogden: 0,
}

const VALID_BOOKED_B = {
  transaktionsidentitet: 9002,
  transaktionsdatum: '2026-07-14',
  ranteberakningsdatum: '2026-07-14',
  transaktionstext: 'Inbetalning bokförd 260714',
  beloppSkatteverket: 20000,
  beloppKronofogden: 0,
}

// The observed failure shape: a booked row where SKV omitted the amount.
const BOOKED_NO_BELOPP = {
  transaktionsidentitet: 9003,
  transaktionsdatum: '2026-07-15',
  ranteberakningsdatum: null,
  transaktionstext: 'Överföring till Kronofogden',
  beloppSkatteverket: undefined as unknown as number,
  beloppKronofogden: -500,
}

const VALID_UPCOMING = {
  transaktionsidentitet: null,
  transaktionsdatum: '2026-09-12',
  forfallodatum: '2026-09-12',
  ranteberakningsdatum: null,
  transaktionstext: 'Moms augusti 2026',
  beloppSkatteverket: -8400,
  beloppKronofogden: 0,
}

const UPCOMING_NULL_BELOPP = {
  transaktionsidentitet: null,
  transaktionsdatum: '2026-09-12',
  forfallodatum: '2026-09-12',
  ranteberakningsdatum: null,
  transaktionstext: 'Preliminär debitering',
  beloppSkatteverket: null as unknown as number,
  beloppKronofogden: null,
}

describe('syncSkattekonto: rows missing NOT NULL fields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    reset()
    getSaldoMock.mockResolvedValue(makeSaldo())
    settingsSetMock.mockResolvedValue(undefined)
  })

  it('skips unusable rows, upserts the rest, and reports the count', async () => {
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: [VALID_BOOKED_A, BOOKED_NO_BELOPP, VALID_BOOKED_B],
      kommandeTransaktioner: [VALID_UPCOMING, UPCOMING_NULL_BELOPP],
    })

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods
    enqueue({ data: [] }) // existing dedup_key lookup
    enqueue({ data: [] }) // takeover candidate scan (both booked rows are new)
    enqueue({ data: null }) // upsert

    const result = await syncSkattekonto(makeCtx())

    expect(result.booked).toBe(2)
    expect(result.upcoming).toBe(1)
    expect(result.skipped).toBe(2)

    const upserts = findCalls('skattekonto_transactions', 'upsert')
    expect(upserts).toHaveLength(1)
    const rows = upserts[0][0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(typeof row.belopp_skatteverket).toBe('number')
    }

    // The log is minimized (no transaktionstext, no amounts); the raw rows
    // are retained in the company-scoped extension_data trace instead.
    expect(warnMock).toHaveBeenCalledWith(
      'skipped transaktioner rows missing required fields',
      {
        companyId: 'company-1',
        skipped: 2,
        traceTruncated: false,
        rows: [
          {
            status: 'booked',
            missing: ['beloppSkatteverket'],
            transaktionsidentitet: 9003,
            transaktionsdatum: '2026-07-15',
          },
          {
            status: 'upcoming',
            missing: ['beloppSkatteverket'],
            transaktionsidentitet: null,
            transaktionsdatum: '2026-09-12',
          },
        ],
      },
    )
    const logged = JSON.stringify(warnMock.mock.calls)
    expect(logged).not.toContain('Överföring till Kronofogden')
    expect(logged).not.toContain('Preliminär debitering')

    const writes = skippedRowsWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0][1]).toEqual(
      expect.objectContaining({
        rows: [
          expect.objectContaining({
            status: 'booked',
            missing: ['beloppSkatteverket'],
            row: BOOKED_NO_BELOPP,
          }),
          expect.objectContaining({
            status: 'upcoming',
            missing: ['beloppSkatteverket'],
            row: UPCOMING_NULL_BELOPP,
          }),
        ],
      }),
    )
  })

  it('keeps aged-out trace entries and drops entries whose id resolved', async () => {
    // Previous sync traced two rows; the current payload contains neither as
    // skipped: 9003 now arrives complete (resolved: the table has it), while
    // the id-less upcoming row has aged out of SKV's window entirely.
    const previousTrace = {
      updatedAt: '2026-08-01T00:00:00.000Z',
      rows: [
        {
          status: 'booked',
          missing: ['beloppSkatteverket'],
          row: BOOKED_NO_BELOPP,
          firstSeenAt: '2026-08-01T00:00:00.000Z',
          lastSeenAt: '2026-08-01T00:00:00.000Z',
        },
        {
          status: 'upcoming',
          missing: ['beloppSkatteverket'],
          row: UPCOMING_NULL_BELOPP,
          firstSeenAt: '2026-08-01T00:00:00.000Z',
          lastSeenAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    }
    const completed9003 = {
      ...BOOKED_NO_BELOPP,
      beloppSkatteverket: -500,
    }
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: [completed9003],
      kommandeTransaktioner: [],
    })
    const ctx = makeCtx()
    ;(ctx.settings.get as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string) =>
        Promise.resolve(key === SKATTEKONTO_SKIPPED_ROWS_KEY ? previousTrace : null),
    )

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods
    enqueue({ data: [] }) // existing dedup_key lookup
    enqueue({ data: [] }) // takeover candidate scan
    enqueue({ data: null }) // upsert

    const result = await syncSkattekonto(ctx)

    expect(result.skipped).toBe(0)
    const writes = skippedRowsWrites()
    expect(writes).toHaveLength(1)
    const record = writes[0][1] as { rows: Array<{ row: { transaktionstext: string } }> }
    // 9003 resolved into the table and left the trace; the aged-out id-less
    // row survives with its original firstSeenAt.
    expect(record.rows).toHaveLength(1)
    expect(record.rows[0]).toEqual(
      expect.objectContaining({
        status: 'upcoming',
        firstSeenAt: '2026-08-01T00:00:00.000Z',
        row: UPCOMING_NULL_BELOPP,
      }),
    )
  })

  it('reports the full skipped count and flags truncation past the trace cap', async () => {
    const manyInvalid = Array.from({ length: 60 }, (_, i) => ({
      transaktionsidentitet: 20000 + i,
      transaktionsdatum: '2026-07-01',
      ranteberakningsdatum: null,
      transaktionstext: `Rad ${i}`,
      beloppSkatteverket: undefined as unknown as number,
      beloppKronofogden: 0,
    }))
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: manyInvalid,
      kommandeTransaktioner: [],
    })

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods

    const result = await syncSkattekonto(makeCtx())

    expect(result.skipped).toBe(60)
    const record = skippedRowsWrites()[0][1] as { truncated?: boolean; rows: unknown[] }
    expect(record.rows).toHaveLength(50)
    expect(record.truncated).toBe(true)
    expect(warnMock).toHaveBeenCalledWith(
      'skipped transaktioner rows missing required fields',
      expect.objectContaining({ skipped: 60, traceTruncated: true }),
    )
  })

  it('skips rows missing transaktionsdatum or transaktionstext', async () => {
    const bookedNoDatum = {
      ...VALID_BOOKED_A,
      transaktionsidentitet: 9010,
      transaktionsdatum: undefined as unknown as string,
    }
    const bookedEmptyText = {
      ...VALID_BOOKED_B,
      transaktionsidentitet: 9011,
      transaktionstext: '' as string,
    }
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: [bookedNoDatum, bookedEmptyText, VALID_BOOKED_A],
      kommandeTransaktioner: [],
    })

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods
    enqueue({ data: [] }) // existing dedup_key lookup
    enqueue({ data: [] }) // takeover candidate scan
    enqueue({ data: null }) // upsert

    const result = await syncSkattekonto(makeCtx())

    expect(result.booked).toBe(1)
    expect(result.skipped).toBe(2)
    const upserts = findCalls('skattekonto_transactions', 'upsert')
    expect((upserts[0][0] as unknown[]).length).toBe(1)

    const writes = skippedRowsWrites()
    expect(writes[0][1]).toEqual(
      expect.objectContaining({
        rows: [
          expect.objectContaining({ missing: ['transaktionsdatum'] }),
          expect.objectContaining({ missing: ['transaktionstext'] }),
        ],
      }),
    )
  })

  it('completes with zero writes when every row is unusable', async () => {
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: [BOOKED_NO_BELOPP],
      kommandeTransaktioner: [UPCOMING_NULL_BELOPP],
    })

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods

    const result = await syncSkattekonto(makeCtx())

    expect(result.booked).toBe(0)
    expect(result.upcoming).toBe(0)
    expect(result.skipped).toBe(2)
    expect(findCalls('skattekonto_transactions', 'upsert')).toHaveLength(0)
  })

  it('does not warn or skip on a fully valid payload', async () => {
    getTransaktionerMock.mockResolvedValue({
      tidigareTransaktioner: [VALID_BOOKED_A],
      kommandeTransaktioner: [VALID_UPCOMING],
    })

    enqueue({ data: { org_number: '556677-8899', entity_type: 'aktiebolag' } }) // company_settings
    enqueue({ data: [] }) // fiscal_periods
    enqueue({ data: [] }) // existing dedup_key lookup
    enqueue({ data: [] }) // takeover candidate scan
    enqueue({ data: null }) // upsert

    const result = await syncSkattekonto(makeCtx())

    expect(result.skipped).toBe(0)
    expect(warnMock).not.toHaveBeenCalled()
    const upserts = findCalls('skattekonto_transactions', 'upsert')
    expect(upserts).toHaveLength(1)
    expect((upserts[0][0] as unknown[]).length).toBe(2)

    // The trace self-clears: a clean payload overwrites any previous rows.
    const writes = skippedRowsWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0][1]).toEqual(expect.objectContaining({ rows: [] }))
  })
})

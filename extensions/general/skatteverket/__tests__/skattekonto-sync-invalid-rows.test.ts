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

import { syncSkattekonto } from '../lib/skattekonto-sync'
import type { ExtensionContext } from '@/lib/extensions/types'

function makeCtx(): ExtensionContext {
  return {
    supabase,
    companyId: 'company-1',
    userId: 'user-1',
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as ExtensionContext
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
    reset()
    getSaldoMock.mockResolvedValue(makeSaldo())
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

    expect(warnMock).toHaveBeenCalledWith(
      'skipped transaktioner rows missing required fields',
      expect.objectContaining({
        companyId: 'company-1',
        skipped: 2,
        sample: BOOKED_NO_BELOPP,
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
  })
})

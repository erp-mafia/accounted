import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: vi.fn() }))
vi.mock('@/lib/vat/filing-record-store', () => ({ listVatFilings: vi.fn() }))

import {
  kontantmetodCutoffPreflight,
  kontantmetodCutoffWriteDates,
} from '../kontantmetod-cutoff-preflight'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { listVatFilings } from '@/lib/vat/filing-record-store'
import type { VatFilingRecord } from '@/lib/vat/filing-record'
import type { KontantmetodCarryPlan } from '@/lib/core/bookkeeping/kontantmetod-cutoff'

const filing = (taxPeriod: string, start: string, end: string, filedOn: string): VatFilingRecord => ({
  deadline_id: `dl-${taxPeriod}`, period_type: 'quarterly', year: Number(start.slice(0, 4)),
  period: 1, tax_period: taxPeriod, period_start: start, period_end: end, filed_on: filedOn,
  source: 'manual', reference: null,
})

const supabase = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(checkPeriodLock).mockResolvedValue({ locked: false })
  vi.mocked(listVatFilings).mockResolvedValue([])
})

describe('kontantmetodCutoffWriteDates', () => {
  const plan = {} as KontantmetodCarryPlan
  it('lists period end only when something is carried, plus every correction date, unique and sorted', () => {
    expect(kontantmetodCutoffWriteDates('2026-12-31', [plan], [{ entryDate: '2027-02-01' }, { entryDate: '2027-01-14' }, { entryDate: '2027-01-14' }]))
      .toEqual(['2026-12-31', '2027-01-14', '2027-02-01'])
    expect(kontantmetodCutoffWriteDates('2026-12-31', [], [{ entryDate: '2027-01-14' }])).toEqual(['2027-01-14'])
    expect(kontantmetodCutoffWriteDates('2026-12-31', [], [])).toEqual([])
  })
})

describe('kontantmetodCutoffPreflight', () => {
  it('passes with nothing to amend when every date is open and unfiled', async () => {
    await expect(kontantmetodCutoffPreflight(supabase, 'co-1', { dates: ['2026-12-31', '2027-01-14'] }))
      .resolves.toEqual({ ok: true, amendedVatPeriodsRequired: [] })
    expect(vi.mocked(checkPeriodLock).mock.calls.map((c) => c[2])).toEqual(['2026-12-31', '2027-01-14'])
  })

  it('refuses KONTANTMETOD_CUTOFF_PERIOD_LOCKED for the period end', async () => {
    vi.mocked(checkPeriodLock).mockImplementation(async (_s, _c, date) =>
      date === '2026-12-31' ? { locked: true, reason: 'period_is_closed', fiscal_period_id: 'fp-1' } : { locked: false })
    const result = await kontantmetodCutoffPreflight(supabase, 'co-1', { dates: ['2026-12-31', '2027-01-14'] })
    expect(result).toMatchObject({ ok: false, code: 'KONTANTMETOD_CUTOFF_PERIOD_LOCKED', date: '2026-12-31', reason: 'period_is_closed' })
    expect(listVatFilings).not.toHaveBeenCalled()
  })

  it('refuses KONTANTMETOD_CUTOFF_PERIOD_LOCKED for a correction date, naming it', async () => {
    vi.mocked(checkPeriodLock).mockImplementation(async (_s, _c, date) =>
      date === '2027-01-14' ? { locked: true, reason: 'company_lock_date_covers' } : { locked: false })
    const result = await kontantmetodCutoffPreflight(supabase, 'co-1', { dates: ['2026-12-31', '2027-01-14'] })
    expect(result).toMatchObject({ ok: false, code: 'KONTANTMETOD_CUTOFF_PERIOD_LOCKED', date: '2027-01-14' })
    if (!result.ok) {
      expect(result.message_sv).toContain('2027-01-14')
      expect(result.message_sv).not.toMatch(/[–—]/)
    }
  })

  it('fails closed, and asks for a retry, when the lock state cannot be read', async () => {
    vi.mocked(checkPeriodLock).mockResolvedValue({ locked: true, reason: 'lookup_failed' })
    const result = await kontantmetodCutoffPreflight(supabase, 'co-1', { dates: ['2026-12-31'] })
    expect(result).toMatchObject({ ok: false, code: 'KONTANTMETOD_CUTOFF_PERIOD_LOCKED', reason: 'lookup_failed' })
    if (!result.ok) {
      expect(result.message_sv).toContain('Försök igen')
      expect(result.message_sv).not.toMatch(/låsdatumet/)
    }
    expect(listVatFilings).not.toHaveBeenCalled()
  })

  it('does not read a missing fiscal period as a lock', async () => {
    vi.mocked(checkPeriodLock).mockResolvedValue({ locked: false, reason: 'no_fiscal_period' })
    await expect(kontantmetodCutoffPreflight(supabase, 'co-1', { dates: ['2027-01-14'] }))
      .resolves.toMatchObject({ ok: true })
  })

  it('refuses KONTANTMETOD_CUTOFF_VAT_PERIOD_FILED for a filed period any date falls in', async () => {
    vi.mocked(listVatFilings).mockResolvedValue([
      filing('2026-Q4', '2026-10-01', '2026-12-31', '2027-02-12'),
      filing('2027-Q1', '2027-01-01', '2027-03-31', '2027-05-12'),
      filing('2026-Q3', '2026-07-01', '2026-09-30', '2026-11-12'),
    ])
    const result = await kontantmetodCutoffPreflight(supabase, 'co-1', { dates: ['2026-12-31', '2027-01-14'] })
    expect(result).toMatchObject({
      ok: false,
      code: 'KONTANTMETOD_CUTOFF_VAT_PERIOD_FILED',
      filed: [
        { tax_period: '2026-Q4', filed_on: '2027-02-12' },
        { tax_period: '2027-Q1', filed_on: '2027-05-12' },
      ],
    })
  })

  it('passes once every hit is acknowledged and returns them as amended_vat_periods_required', async () => {
    vi.mocked(listVatFilings).mockResolvedValue([filing('2026-Q4', '2026-10-01', '2026-12-31', '2027-02-12')])
    const partly = await kontantmetodCutoffPreflight(supabase, 'co-1', {
      dates: ['2026-12-31'], acknowledgedFiledVatPeriods: ['2026-Q3'],
    })
    expect(partly).toMatchObject({ ok: false, code: 'KONTANTMETOD_CUTOFF_VAT_PERIOD_FILED' })

    const acknowledged = await kontantmetodCutoffPreflight(supabase, 'co-1', {
      dates: ['2026-12-31'], acknowledgedFiledVatPeriods: ['2026-Q4'],
    })
    expect(acknowledged).toEqual({
      ok: true,
      amendedVatPeriodsRequired: [{
        tax_period: '2026-Q4', period_start: '2026-10-01', period_end: '2026-12-31', filed_on: '2027-02-12',
      }],
    })
  })

  it('reads nothing when there is nothing to write', async () => {
    await expect(kontantmetodCutoffPreflight(supabase, 'co-1', { dates: [] }))
      .resolves.toEqual({ ok: true, amendedVatPeriodsRequired: [] })
    expect(checkPeriodLock).not.toHaveBeenCalled()
    expect(listVatFilings).not.toHaveBeenCalled()
  })

  // Review of #3440: a payment verifikat the cut-off cannot correct by rule
  // declared the moms again in its own VAT period; when that period is filed
  // the user must learn it needs a rättad momsdeklaration.
  it('reports a filed period holding a manual correction date, without refusing or lock-checking it', async () => {
    vi.mocked(listVatFilings).mockResolvedValue([
      filing('2027-Q1', '2027-01-01', '2027-03-31', '2027-05-12'),
    ])
    vi.mocked(checkPeriodLock).mockImplementation(async (_s, _c, date) =>
      date === '2027-02-01' ? { locked: true, reason: 'company_lock_date_covers' } : { locked: false })
    const result = await kontantmetodCutoffPreflight(supabase, 'co-1', {
      dates: ['2026-12-31'],
      manualCorrectionDates: ['2027-02-01'],
    })
    expect(result).toEqual({
      ok: true,
      amendedVatPeriodsRequired: [{
        tax_period: '2027-Q1', period_start: '2027-01-01', period_end: '2027-03-31', filed_on: '2027-05-12',
      }],
    })
    expect(vi.mocked(checkPeriodLock).mock.calls.map((c) => c[2])).toEqual(['2026-12-31'])

    // Manual dates alone still read the filings.
    await expect(kontantmetodCutoffPreflight(supabase, 'co-1', { dates: [], manualCorrectionDates: ['2027-02-01'] }))
      .resolves.toMatchObject({ ok: true, amendedVatPeriodsRequired: [{ tax_period: '2027-Q1' }] })
  })
})

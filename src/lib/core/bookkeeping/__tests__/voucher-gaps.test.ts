/**
 * Voucher number gaps (BFNAR 2013:2 p. 5.9: every series unbroken and
 * checkable; a gap needs a documented reason). One listing behind every door;
 * a failed read is an error, never "no gaps".
 */
import { describe, expect, it } from 'vitest'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import {
  checkVoucherGapExplanation,
  listVoucherGaps,
  saveVoucherGapExplanation,
  VoucherGapCheckError,
  voucherGapExplanationFromParams,
} from '../voucher-gaps'

type Resp = TableMockResult

/** Table-routed answers; rpc results keyed `rpc:<name>`. Records calls. */
function makeClient(queues: Record<string, Resp[]>) {
  const { supabase, calls } = createTableMockSupabase(queues)
  return { client: supabase, calls }
}

describe('listVoucherGaps', () => {
  it('checks every series the year has a sequence for and joins the explanations', async () => {
    const { client, calls } = makeClient({
      voucher_sequences: [{ data: [{ voucher_series: 'A' }, { voucher_series: 'B' }] }],
      'rpc:detect_voucher_gaps': [{ data: [{ gap_start: 3, gap_end: 3 }] }, { data: [{ gap_start: 7, gap_end: 9 }] }],
      voucher_gap_explanations: [
        {
          data: [
            { id: 'exp-1', voucher_series: 'A', gap_start: 3, gap_end: 3, explanation: 'Avbruten bokning', user_id: 'user-1', created_at: '2026-01-01' },
          ],
        },
      ],
    })

    const listing = await listVoucherGaps(client as never, 'company-1', 'fp-1')

    expect(listing.series).toEqual(['A', 'B'])
    expect(listing.sequenceSeries).toEqual(['A', 'B'])
    expect(listing.gaps).toEqual([
      {
        series: 'A',
        gap_start: 3,
        gap_end: 3,
        explanation: { id: 'exp-1', explanation: 'Avbruten bokning', user_id: 'user-1', created_at: '2026-01-01' },
      },
      { series: 'B', gap_start: 7, gap_end: 9, explanation: null },
    ])
    expect(calls).toContainEqual({ table: 'voucher_gap_explanations', method: 'eq', args: ['company_id', 'company-1'] })
    expect(calls).toContainEqual({ table: 'voucher_gap_explanations', method: 'eq', args: ['fiscal_period_id', 'fp-1'] })
  })

  it('checks series A when the year has no sequence row', async () => {
    const { client, calls } = makeClient({
      voucher_sequences: [{ data: [] }],
      'rpc:detect_voucher_gaps': [{ data: [] }],
    })

    const listing = await listVoucherGaps(client as never, 'company-1', 'fp-1')

    expect(listing.series).toEqual(['A'])
    expect(listing.sequenceSeries).toEqual([])
    expect(listing.gaps).toEqual([])
    expect(calls.find((c) => c.table === 'rpc:detect_voucher_gaps')?.args[0]).toMatchObject({ p_series: 'A' })
    // No gaps: the explanations are not read.
    expect(calls.some((c) => c.table === 'voucher_gap_explanations')).toBe(false)
  })

  it('checks only the filtered series, without reading the sequences', async () => {
    const { client, calls } = makeClient({ 'rpc:detect_voucher_gaps': [{ data: [] }] })

    const listing = await listVoucherGaps(client as never, 'company-1', 'fp-1', { series: 'F' })

    expect(listing.series).toEqual(['F'])
    expect(calls.some((c) => c.table === 'voucher_sequences')).toBe(false)
  })

  it.each([
    ['the sequence read', { voucher_sequences: [{ error: { message: 'timeout' } }] }, 'voucher_sequences'],
    [
      'gap detection',
      { voucher_sequences: [{ data: [{ voucher_series: 'A' }] }], 'rpc:detect_voucher_gaps': [{ error: { message: 'timeout' } }] },
      'detect_voucher_gaps',
    ],
    [
      'the explanation read',
      {
        voucher_sequences: [{ data: [{ voucher_series: 'A' }] }],
        'rpc:detect_voucher_gaps': [{ data: [{ gap_start: 3, gap_end: 3 }] }],
        voucher_gap_explanations: [{ error: { message: 'timeout' } }],
      },
      'voucher_gap_explanations',
    ],
  ])('throws when %s fails', async (_label, queues, stage) => {
    const { client } = makeClient(queues as Record<string, Resp[]>)

    const err = await listVoucherGaps(client as never, 'company-1', 'fp-1').catch((e) => e)

    expect(err).toBeInstanceOf(VoucherGapCheckError)
    expect(err.stage).toBe(stage)
  })
})

const PERIOD = '7b3a1c2d-0000-4000-8000-000000000001'
const GAP = { fiscal_period_id: PERIOD, voucher_series: 'A', gap_start: 5, gap_end: 7, explanation: '  Avbruten bokning vid bankimport  ' }
const SAVED = { id: 'exp-1', fiscal_period_id: PERIOD, voucher_series: 'A', gap_start: 5, gap_end: 7, explanation: 'Avbruten bokning vid bankimport', created_at: '2026-10-13T10:00:00Z' }

describe('saveVoucherGapExplanation: one write, one rule set', () => {
  it('inserts the trimmed explanation for the company\'s year', async () => {
    const { client, calls } = makeClient({ fiscal_periods: [{ data: { id: PERIOD } }], voucher_gap_explanations: [{ data: SAVED }] })

    const result = await saveVoucherGapExplanation(client as never, 'company-1', 'user-1', GAP)

    expect(result).toEqual({ ok: true, data: SAVED })
    expect(calls.find((c) => c.table === 'voucher_gap_explanations' && c.method === 'insert')?.args[0]).toEqual({
      company_id: 'company-1',
      user_id: 'user-1',
      fiscal_period_id: PERIOD,
      voucher_series: 'A',
      gap_start: 5,
      gap_end: 7,
      explanation: 'Avbruten bokning vid bankimport',
    })
    // Insert only: an explanation is write-once (it used to upsert in the app).
    expect(calls.some((c) => c.method === 'upsert' || c.method === 'update')).toBe(false)
    expect(calls).toContainEqual({ table: 'fiscal_periods', method: 'eq', args: ['company_id', 'company-1'] })
  })

  it.each([
    ['a series outside A-Z', { voucher_series: 'a' }],
    ['a two-letter series', { voucher_series: 'AB' }],
    ['gap_end before gap_start', { gap_start: 9, gap_end: 7 }],
    ['a zero gap_start', { gap_start: 0 }],
    ['a blank explanation', { explanation: '   ' }],
    ['an explanation over 500 characters (the table CHECK)', { explanation: 'x'.repeat(501) }],
    ['a fiscal_period_id that is not a UUID', { fiscal_period_id: 'fp-1' }],
  ])('400 VALIDATION_ERROR for %s, before any read', async (_label, patch) => {
    const { client, calls } = makeClient({})

    const result = await saveVoucherGapExplanation(client as never, 'company-1', 'user-1', { ...GAP, ...patch })

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', status: 400 })
    expect(calls).toEqual([])
  })

  it('404 for another company\'s year (the service role bypasses RLS, the FK accepted it)', async () => {
    const { client, calls } = makeClient({ fiscal_periods: [{ data: null }] })

    const result = await saveVoucherGapExplanation(client as never, 'company-1', 'user-1', GAP)

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND', status: 404 })
    expect(calls.some((c) => c.table === 'voucher_gap_explanations')).toBe(false)
  })

  it('409 VOUCHER_GAP_ALREADY_EXPLAINED for a gap that already has one', async () => {
    const { client } = makeClient({
      fiscal_periods: [{ data: { id: PERIOD } }],
      voucher_gap_explanations: [{ error: { code: '23505', message: 'duplicate key value' } }],
    })

    const result = await saveVoucherGapExplanation(client as never, 'company-1', 'user-1', GAP)

    expect(result).toMatchObject({ ok: false, code: 'VOUCHER_GAP_ALREADY_EXPLAINED', status: 409 })
  })

  it('403 FORBIDDEN when RLS refuses the session client', async () => {
    const { client } = makeClient({
      fiscal_periods: [{ data: { id: PERIOD } }],
      voucher_gap_explanations: [{ error: { code: '42501', message: 'permission denied' } }],
    })

    expect(await saveVoucherGapExplanation(client as never, 'company-1', 'user-1', GAP)).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
      status: 403,
    })
  })
})

describe('checkVoucherGapExplanation: the same verdict, nothing written', () => {
  it('previews the trimmed explanation', async () => {
    const { client, calls } = makeClient({ fiscal_periods: [{ data: { id: PERIOD } }], voucher_gap_explanations: [{ data: null }] })

    const result = await checkVoucherGapExplanation(client as never, 'company-1', GAP)

    expect(result).toEqual({ ok: true, preview: { ...GAP, explanation: 'Avbruten bokning vid bankimport' } })
    expect(calls.some((c) => c.method === 'insert')).toBe(false)
  })

  it('409 for an explained gap', async () => {
    const { client } = makeClient({ fiscal_periods: [{ data: { id: PERIOD } }], voucher_gap_explanations: [{ data: { id: 'exp-1' } }] })

    expect(await checkVoucherGapExplanation(client as never, 'company-1', GAP)).toMatchObject({
      ok: false,
      code: 'VOUCHER_GAP_ALREADY_EXPLAINED',
      status: 409,
    })
  })
})

describe('voucherGapExplanationFromParams', () => {
  it('reads a numeric string range as numbers, as the executor\'s Number() did', () => {
    expect(voucherGapExplanationFromParams({ ...GAP, gap_start: '5', gap_end: '7', extra: true })).toEqual({
      ...GAP,
      gap_start: 5,
      gap_end: 7,
    })
  })
})

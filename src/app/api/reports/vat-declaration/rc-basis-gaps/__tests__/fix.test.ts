/**
 * Tests for POST /api/reports/vat-declaration/rc-basis-gaps/fix.
 *
 * Exercises the route through the real withRouteContext wrapper, mocking its
 * auth/company/write dependencies and correctEntry(). Covers: 401, viewer 403
 * (the route corrects posted entries, so requireWrite must gate it),
 * validation 400, entry 404, the happy-path correction, the storno service's
 * refusals with their own codes and their own sentence, the loser of a
 * concurrent click answered as already corrected, and that only the basis the
 * verifikat itself lacks is added, per momssats and classified per momssats
 * (crm#1096).
 *
 * The crm#1096 cases run the corrected verifikat through the real gap scan
 * (findRcBasisGaps, entry-lines fetch mocked) and the real declaration and
 * filing gate (fetchDynamicVatAccounts, rutorFromTotals,
 * runVatDeclarationChecks, rcBasisTotalsByRate, withRcBasisGapFindings), so
 * "nothing missing, nothing counted twice" is what the momsdeklaration says,
 * not what the route believes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import {
  AccountsNotInChartError,
  BookkeepingDatabaseError,
  CannotCorrectNonPostedError,
  CorrectionChainTooDeepError,
  EntryAlreadyReversedError,
  MandatoryDimensionMissingError,
} from '@/lib/bookkeeping/errors'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { findRcBasisGaps } from '@/lib/reports/rc-basis-gaps'
import { rutorFromTotals } from '@/lib/reports/vat-declaration'
import { runVatDeclarationChecks } from '@/lib/reports/vat-declaration-checks'
import { rcBasisTotalsByRate, withRcBasisGapFindings } from '@/lib/reports/vat-filing-gate'
import { fetchDynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

const correctEntryMock = vi.fn()
vi.mock('@/lib/core/bookkeeping/storno-service', () => ({
  correctEntry: (...args: unknown[]) => correctEntryMock(...args),
}))

// Only the gap scan reads through these; the route does not.
const fetchEntryLinesMock = vi.fn()
const fetchLinesByEntryIdsMock = vi.fn()
vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  fetchEntryLines: (...args: unknown[]) => fetchEntryLinesMock(...args),
  fetchLinesByEntryIds: (...args: unknown[]) => fetchLinesByEntryIdsMock(...args),
}))

import { POST } from '../fix/route'

const ENTRY_ID = '11111111-1111-4111-8111-111111111111'

function fixRequest(body: Record<string, unknown>) {
  return createMockRequest('/api/reports/vat-declaration/rc-basis-gaps/fix', {
    method: 'POST',
    body,
  })
}

const validBody = {
  entryId: ENTRY_ID,
  supplierType: 'eu_business',
  supplyType: 'service',
}

type Line = { account_number: string; debit_amount: number; credit_amount: number }

describe('POST /api/reports/vat-declaration/rc-basis-gaps/fix', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer-role member (requireWrite gate)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
    expect(response.status).toBe(403)
    expect(correctEntryMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid body (bad supplierType)', async () => {
    const response = await POST(
      fixRequest({ ...validBody, supplierType: 'martian_business' }),
      { params: Promise.resolve({}) },
    )
    const { status } = await parseJsonResponse(response)
    expect(status).toBe(400)
  })

  it('returns 404 when the entry does not exist in the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('JOURNAL_ENTRY_NOT_FOUND')
  })

  it('corrects a posted entry with missing basis lines (happy path)', async () => {
    enqueue({
      data: {
        id: ENTRY_ID,
        status: 'posted',
        lines: [
          {
            account_number: '2614',
            debit_amount: 0,
            credit_amount: 2500,
            line_description: 'Beräknad utgående moms EU-tjänst',
          },
          {
            account_number: '2645',
            debit_amount: 2500,
            credit_amount: 0,
            line_description: 'Beräknad ingående moms',
          },
        ],
      },
    })
    correctEntryMock.mockResolvedValue({
      reversal: { id: 'rev-1' },
      corrected: { id: 'cor-1' },
    })

    const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      data: { reversalId: string; correctedId: string; basis: Array<{ rate: number; account: string; amount: number }> }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.reversalId).toBe('rev-1')
    expect(body.data.correctedId).toBe('cor-1')
    expect(body.data.basis).toEqual([{ rate: 0.25, account: '4535', amount: 10000 }])
    expect(correctEntryMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      ENTRY_ID,
      expect.any(Array),
    )
  })

  describe('a refusal of the storno service keeps its own code, not a calculation failure', () => {
    const gapEntry = () =>
      enqueue({
        data: {
          id: ENTRY_ID,
          status: 'posted',
          lines: [
            { account_number: '2614', debit_amount: 0, credit_amount: 2500 },
            { account_number: '2645', debit_amount: 2500, credit_amount: 0 },
          ],
        },
      })
    type Envelope = { error: { code: string; message: string; message_en: string; details?: Record<string, unknown> } }

    it.each([
      ['a locked or closed period', 'Cannot write to locked/closed fiscal period "2026" (is_closed=f, locked_at=2026-10-01)', /^Perioden är låst/],
      ['the company lock date', 'Bokföringen är låst t.o.m. 2026-09-30. Kan inte skapa verifikation med datum 2026-09-05.', /^Bokföringen är låst t\.o\.m\. 2026-09-30/],
    ])('%s is a 400 PERIOD_LOCKED with its own sentence', async (_, cause, sentence) => {
      gapEntry()
      correctEntryMock.mockRejectedValue(new BookkeepingDatabaseError('create_reversal_entry', cause))

      const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<Envelope>(response)

      expect(status).toBe(400)
      expect(body.error.code).toBe('PERIOD_LOCKED')
      expect(body.error.message).toMatch(sentence)
      // The lock's English, not the wrapped database error's.
      expect(body.error.message_en).toBe(getErrorEntry('PERIOD_LOCKED')?.message_en)
      expect(body.error.message_en).toMatch(/^Period is locked or closed/)
    })

    // The worklist row shows only error.message, so the sentence that says
    // what to fix has to be the message; the code and status stay the
    // registry's and the details the shared dispatcher's.
    it('a correction chain too deep keeps its registry code and 409, and names the depth and the root verifikat', async () => {
      gapEntry()
      correctEntryMock.mockRejectedValue(new CorrectionChainTooDeepError(3, 'A-1'))

      const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<Envelope>(response)

      expect(status).toBe(409)
      expect(body.error.code).toBe('CORRECTION_CHAIN_TOO_DEEP')
      expect(body.error.message).toMatch(/^Kedjan är redan 3 nivåer djup \(ursprungsverifikat A-1\)/)
      expect(body.error.message_en).toBe(getErrorEntry('CORRECTION_CHAIN_TOO_DEEP')?.message_en)
      expect(body.error.details).toEqual({ depth: 3, chainRootVoucher: 'A-1' })
    })

    it('a deactivated account is a 400 ACCOUNTS_NOT_IN_CHART that names the accounts to activate', async () => {
      gapEntry()
      correctEntryMock.mockRejectedValue(new AccountsNotInChartError(['4535']))

      const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<Envelope>(response)

      expect(status).toBe(400)
      expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
      expect(body.error.message).toBe('Följande konton behöver aktiveras: 4535')
      expect(body.error.message_en).toBe(getErrorEntry('ACCOUNTS_NOT_IN_CHART')?.message_en)
      expect(body.error.details).toEqual({ account_numbers: ['4535'] })
    })

    it('a required dimension is a 400 MANDATORY_DIMENSION_MISSING that names the account and the dimension', async () => {
      gapEntry()
      const violations = [{ account_number: '4535', sie_dim_no: '6', dimension_name: 'Projekt' }]
      correctEntryMock.mockRejectedValue(new MandatoryDimensionMissingError(violations))

      const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<Envelope>(response)

      expect(status).toBe(400)
      expect(body.error.code).toBe('MANDATORY_DIMENSION_MISSING')
      expect(body.error.message).toBe('Konto 4535 kräver Projekt: välj ett värde innan bokföring.')
      expect(body.error.details).toEqual({ violations })
    })

    // Two clicks on the same verifikat in the same moment both read it as
    // posted; the storno service refuses the second. The verifikat is
    // corrected, so the row is resolved, not failed.
    it.each([
      ['the reversal that lost the race', () => new EntryAlreadyReversedError()],
      ['a verifikat reversed before the storno read it', () => new CannotCorrectNonPostedError('reversed')],
    ])('answers the loser of a concurrent click (%s) as already corrected', async (_, refusal) => {
      gapEntry()
      correctEntryMock.mockRejectedValue(refusal())

      const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<Envelope>(response)

      expect(status).toBe(409)
      expect(body.error.code).toBe('VAT_RC_BASIS_NOTHING_MISSING')
      expect(body.error.message).toMatch(/redan rättats med storno/)
      expect(body.error.message_en).toMatch(/already been reversed/)
      expect(body.error.details).toEqual({ entryId: ENTRY_ID, reason: 'reversed' })
    })

    it('a verifikat that is not posted for another reason keeps its own refusal', async () => {
      gapEntry()
      correctEntryMock.mockRejectedValue(new CannotCorrectNonPostedError('cancelled'))

      const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<Envelope>(response)

      expect(status).toBe(400)
      expect(body.error.code).toBe('CANNOT_CORRECT_NON_POSTED')
      expect(body.error.message).toBe('Endast bokförda verifikationer kan rättas.')
    })

    it('an unexpected database failure stays a 500, as a failed save rather than a failed calculation', async () => {
      gapEntry()
      correctEntryMock.mockRejectedValue(new BookkeepingDatabaseError('create_reversal_entry', 'connection reset'))

      const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<Envelope>(response)

      expect(status).toBe(500)
      expect(body.error.code).toBe('BOOKKEEPING_DATABASE_ERROR')
    })
  })

  it('refuses goods from outside the EU as import VAT with a 400, booking nothing', async () => {
    enqueue({
      data: {
        id: ENTRY_ID,
        status: 'posted',
        lines: [
          { account_number: '2614', debit_amount: 0, credit_amount: 2500 },
          { account_number: '2645', debit_amount: 2500, credit_amount: 0 },
        ],
      },
    })

    const response = await POST(
      fixRequest({ ...validBody, supplierType: 'non_eu_business', supplyType: 'goods' }),
      { params: Promise.resolve({}) },
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toMatch(/hanteras som import/)
    expect(correctEntryMock).not.toHaveBeenCalled()
  })

  it('answers a row whose verifikat is already corrected with nothing to correct, not with not found', async () => {
    enqueue({ data: { id: ENTRY_ID, status: 'reversed', lines: [] } })

    const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('VAT_RC_BASIS_NOTHING_MISSING')
    expect(body.error.message).toMatch(/redan rättats med storno/)
    expect(correctEntryMock).not.toHaveBeenCalled()
  })

  it('keeps every dimension of the original lines on the corrected entry, not only the 1/6 mirrors', async () => {
    const bag = { '1': 'KS01', '2': 'AVD3', '6': 'P001', '7': 'ANST9', '20': 'KUND42' }
    enqueue({
      data: {
        id: ENTRY_ID,
        status: 'posted',
        lines: [
          {
            account_number: '6540',
            debit_amount: 10000,
            credit_amount: 0,
            line_description: 'IT-tjänst EU',
            dimensions: bag,
            // The generated mirrors of keys 1 and 6 ride along on a posted row.
            cost_center: 'KS01',
            project: 'P001',
          },
          { account_number: '2645', debit_amount: 2500, credit_amount: 0, dimensions: {} },
          { account_number: '2614', debit_amount: 0, credit_amount: 2500, dimensions: {} },
          { account_number: '1930', debit_amount: 0, credit_amount: 10000, dimensions: {} },
        ],
      },
    })
    correctEntryMock.mockResolvedValue({ reversal: { id: 'rev-1' }, corrected: { id: 'cor-1' } })

    const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
    expect(response.status).toBe(200)

    const lines = correctEntryMock.mock.calls[0][4] as Array<{ account_number: string; dimensions?: Record<string, string> }>
    expect(lines.find((l) => l.account_number === '6540')?.dimensions).toEqual(bag)
    // Untagged lines stay untagged, and so does the added basis pair.
    for (const account of ['2645', '2614', '1930', '4535', '4598']) {
      expect(lines.find((l) => l.account_number === account)?.dimensions, account).toBeUndefined()
    }
  })

  // crm#1096: the worklist row is a snapshot. The route reads the verifikat
  // again with the scan's own rule and adds only what is missing, per sats.
  describe('only the missing basis, as the scan and the filing gate read it (crm#1096)', () => {
    type ChartRow = { account: string; treatment: string; rate?: number | null }

    /** chart_of_accounts rows as the declaration's loader selects them. */
    const chartRows = (rows: ChartRow[]) =>
      rows.map(({ account, treatment, rate }) => ({
        account_number: account,
        account_name: account,
        account_class: Number(account.charAt(0)),
        default_vat_treatment: treatment,
        default_vat_rate: rate ?? null,
        vat_box: null,
      }))

    const debit = (account: string, amount: number): Line => ({ account_number: account, debit_amount: amount, credit_amount: 0 })
    const credit = (account: string, amount: number): Line => ({ account_number: account, debit_amount: 0, credit_amount: amount })

    /** The verifikat and the kontoplan the route reads, in its query order. */
    function verifikat(lines: Line[], chart: ChartRow[]) {
      enqueue({ data: { id: ENTRY_ID, status: 'posted', lines } })
      enqueue({ data: chartRows(chart) })
    }

    /**
     * One verifikat as the momsdeklaration reads it: the per-verifikat gap
     * scan, and the rutor with the findings the filing gate shows.
     */
    async function declare(lines: Line[], chart: ChartRow[]) {
      const entry = { id: 'v', voucher_number: 1, voucher_series: 'A', entry_date: '2026-10-05', description: 'Inköp' }
      fetchEntryLinesMock.mockResolvedValue(
        lines
          .filter((l) => ['2614', '2624', '2634'].includes(l.account_number))
          .map((l) => ({ ...l, journal_entry_id: 'v', journal_entries: entry })),
      )
      fetchLinesByEntryIdsMock.mockResolvedValue(lines.map((l, i) => ({ ...l, id: `l-${i}`, journal_entry_id: 'v' })))
      const scanDb = createQueuedMockSupabase()
      scanDb.enqueue({ data: chartRows(chart) })
      const gaps = await findRcBasisGaps(scanDb.supabase as never, 'company-1', 'monthly', 2026, 10)

      const totals = new Map<string, { debit: number; credit: number }>()
      for (const l of lines) {
        const t = totals.get(l.account_number) ?? { debit: 0, credit: 0 }
        totals.set(l.account_number, { debit: t.debit + l.debit_amount, credit: t.credit + l.credit_amount })
      }
      const declarationDb = createQueuedMockSupabase()
      declarationDb.enqueue({ data: chartRows(chart) })
      const dynamic = await fetchDynamicVatAccounts(declarationDb.supabase as never, 'company-1')
      const rutor = rutorFromTotals(totals, dynamic)
      const findings = withRcBasisGapFindings(
        runVatDeclarationChecks(rutor, totals),
        { status: 'scanned', gapCount: gaps.length },
        { rutor, rcBasisByRate: rcBasisTotalsByRate(totals, dynamic) },
      )
      return { gaps, rutor, findings }
    }

    /** The lines the route handed correctEntry: the corrected verifikat. */
    const corrected = () => correctEntryMock.mock.calls[0][4] as Line[]

    const fiktivMoms = (account: '2614' | '2624', moms: number) => [debit('2645', moms), credit(account, moms)]

    beforeEach(() => {
      correctEntryMock.mockResolvedValue({ reversal: { id: 'rev-1' }, corrected: { id: 'cor-1' } })
    })

    it('adds only the shortfall a cost line whose momskod reports ruta 20-24 leaves, so the purchase counts once', async () => {
      const chart = [{ account: '4056', treatment: 'reverse_charge_eu_goods' }]
      const original = [debit('4056', 600), debit('6540', 400), ...fiktivMoms('2614', 250), credit('1930', 1000)]

      const before = await declare(original, chart)
      expect(before.gaps.map((g) => [g.expectedBasisAmount, g.missingBasisAmount])).toEqual([[1000, 400]])
      expect(before.findings.map((f) => `${f.code}:${f.status}`)).toEqual(['RC_BASIS_MISSING:ERROR'])

      verifikat(original, chart)
      const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<{ data: { basis: unknown } }>(response)
      expect(status).toBe(200)
      expect(body.data.basis).toEqual([{ rate: 0.25, account: '4535', amount: 400 }])

      const after = await declare(corrected(), chart)
      expect(after.gaps).toEqual([])
      expect(after.findings).toEqual([])
      expect([after.rutor.ruta20, after.rutor.ruta21, after.rutor.ruta30]).toEqual([600, 400, 250])

      // The whole basis on top, as the route booked before crm#1096, puts
      // 600 kr of the purchase in ruta 20-24 twice.
      const whole = await declare([...original, debit('4535', 1000), credit('4598', 1000)], chart)
      expect(whole.findings.map((f) => f.code)).toEqual(['RC_OUTPUT_MISSING'])
    })

    it('refuses a stale row whose verifikat already reports the whole basis, and books nothing', async () => {
      const chart = [{ account: '6540', treatment: 'reverse_charge_eu_services' }]
      const original = [debit('6540', 1000), ...fiktivMoms('2614', 250), credit('1930', 1000)]
      expect((await declare(original, chart)).gaps).toEqual([])

      verifikat(original, chart)
      const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

      expect(status).toBe(409)
      expect(body.error.code).toBe('VAT_RC_BASIS_NOTHING_MISSING')
      expect(body.error.message).toMatch(/redan hela basbeloppet/)
      expect(correctEntryMock).not.toHaveBeenCalled()
    })

    it('says so when the verifikat has no fiktiv moms that needs a basis', async () => {
      verifikat([debit('4010', 1000), debit('2641', 250), credit('2440', 1250)], [])

      const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

      expect(status).toBe(409)
      expect(body.error.code).toBe('VAT_RC_BASIS_NOTHING_MISSING')
      expect(body.error.message).toMatch(/ingen fiktiv moms/)
      expect(correctEntryMock).not.toHaveBeenCalled()
    })

    it('adds a pair per momssats that falls short, each at its own sats', async () => {
      const original = [
        debit('4010', 1000), debit('4011', 500),
        ...fiktivMoms('2614', 250), ...fiktivMoms('2624', 60),
        credit('2440', 1500),
      ]
      expect((await declare(original, [])).gaps.map((g) => g.rcOutputAccount)).toEqual(['2614', '2624'])

      verifikat(original, [])
      const response = await POST(
        fixRequest({ ...validBody, supplyType: 'goods' }),
        { params: Promise.resolve({}) },
      )
      const { status, body } = await parseJsonResponse<{ data: { basis: unknown } }>(response)
      expect(status).toBe(200)
      expect(body.data.basis).toEqual([
        { rate: 0.25, account: '4515', amount: 1000 },
        { rate: 0.12, account: '4516', amount: 500 },
      ])

      const after = await declare(corrected(), [])
      expect(after.gaps).toEqual([])
      expect(after.findings).toEqual([])
      expect([after.rutor.ruta20, after.rutor.ruta30, after.rutor.ruta31]).toEqual([1500, 250, 60])
    })

    it('classifies each momssats on its own: EU goods at 12 % in ruta 20, an EU service at 25 % in ruta 21', async () => {
      const original = [
        debit('4010', 1000), debit('4011', 500),
        ...fiktivMoms('2614', 250), ...fiktivMoms('2624', 60),
        credit('2440', 1500),
      ]
      verifikat(original, [])
      const response = await POST(
        fixRequest({
          ...validBody,
          perOutputAccount: [{ rcOutputAccount: '2624', supplierType: 'eu_business', supplyType: 'goods' }],
        }),
        { params: Promise.resolve({}) },
      )
      const { status, body } = await parseJsonResponse<{ data: { basis: unknown } }>(response)
      expect(status).toBe(200)
      expect(body.data.basis).toEqual([
        { rate: 0.25, account: '4535', amount: 1000 },
        { rate: 0.12, account: '4516', amount: 500 },
      ])

      const after = await declare(corrected(), [])
      expect(after.findings).toEqual([])
      expect([after.rutor.ruta20, after.rutor.ruta21]).toEqual([500, 1000])
    })

    // A kontoplan that holds a BAS basis account at another sats than its
    // column: the pair would land in the other sats' bucket and close nothing.
    it('refuses when the kontoplan reads the basis account at another sats than the fiktiv moms, naming it', async () => {
      const chart = [{ account: '4536', treatment: 'reverse_charge_eu_services', rate: 0.25 }]
      const original = [debit('6540', 500), ...fiktivMoms('2624', 60), credit('1930', 500)]

      // What the pair would have done: the 12 % gap stays, 25 % gets a surplus.
      const paired = await declare([...original, debit('4536', 500), credit('4598', 500)], chart)
      expect(paired.gaps.map((g) => g.rcOutputAccount)).toEqual(['2624'])

      verifikat(original, chart)
      const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<{
        error: { code: string; message: string; details: { account: string; rate: number } }
      }>(response)

      expect(status).toBe(409)
      expect(body.error.code).toBe('VAT_RC_BASIS_ACCOUNT_RATE_CONFLICT')
      expect(body.error.message).toMatch(/^Konto 4536, där basbeloppet för 12 % ska bokföras/)
      expect(body.error.message).toMatch(/välj 12 % under Standard moms på konto 4536 i kontoplanen/)
      expect(body.error.details).toMatchObject({ account: '4536', rate: 0.12 })
      expect(correctEntryMock).not.toHaveBeenCalled()

      // With 4536 at 12 % the same click closes the gap.
      correctEntryMock.mockClear()
      const atTwelve = [{ account: '4536', treatment: 'reverse_charge_eu_services', rate: 0.12 }]
      verifikat(original, atTwelve)
      expect((await POST(fixRequest(validBody), { params: Promise.resolve({}) })).status).toBe(200)
      expect((await declare(corrected(), atTwelve)).findings).toEqual([])
    })

    it('leaves a momssats that already has its basis alone', async () => {
      const original = [
        debit('4515', 1000), credit('4598', 1000), debit('4010', 1000), debit('4011', 500),
        ...fiktivMoms('2614', 250), ...fiktivMoms('2624', 60),
        credit('2440', 1500),
      ]
      verifikat(original, [])
      const response = await POST(
        fixRequest({ ...validBody, supplyType: 'goods' }),
        { params: Promise.resolve({}) },
      )
      const { status, body } = await parseJsonResponse<{ data: { basis: unknown } }>(response)
      expect(status).toBe(200)
      expect(body.data.basis).toEqual([{ rate: 0.12, account: '4516', amount: 500 }])
      expect((await declare(corrected(), [])).findings).toEqual([])
    })

    it('refuses when the verifikat reports its basis at another sats than its fiktiv moms', async () => {
      const chart = [{ account: '6540', treatment: 'reverse_charge_eu_services', rate: 0.12 }]
      verifikat([debit('6540', 1000), ...fiktivMoms('2614', 250), credit('1930', 1000)], chart)

      const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<{ error: { code: string; message: string; message_en: string } }>(response)

      expect(status).toBe(409)
      expect(body.error.code).toBe('VAT_RC_BASIS_RATE_MISMATCH')
      expect(body.error.message).toMatch(/annan momssats \(12 %\) än den fiktiva momsen \(25 %\)/)
      expect(body.error.message_en).toMatch(/another VAT rate \(12 %\)/)
      expect(correctEntryMock).not.toHaveBeenCalled()
    })

    // A momskod for omvänd skattskyldighet on an account whose momssats is
    // not 25, 12 or 6 %: the declaration counts the box but the gate buckets
    // no basis there, so a pair made RC_OUTPUT_MISSING and removing it again
    // brought RC_BASIS_MISSING back.
    it('refuses a verifikat on an account whose reverse-charge momskod has no momssats, pointing at the kontoplan', async () => {
      const atZero = [{ account: '4056', treatment: 'reverse_charge_eu_goods', rate: 0 }]
      const original = [debit('4056', 1000), ...fiktivMoms('2614', 250), credit('1930', 1000)]

      const before = await declare(original, atZero)
      expect(before.rutor.ruta20).toBe(1000)
      expect(before.gaps).toHaveLength(1)
      expect(before.findings.map((f) => `${f.code}:${f.status}`)).toEqual(['RC_BASIS_MISSING:ERROR'])
      expect(before.findings[0].message).toMatch(/ingen Standard moms på 25, 12 eller 6 %/)
      expect(before.findings[0].message).toMatch(/kontoplanen/)

      verifikat(original, atZero)
      const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<{
        error: { code: string; message: string; message_en: string; details: { accounts: string[] } }
      }>(response)

      expect(status).toBe(409)
      expect(body.error.code).toBe('VAT_RC_BASIS_ACCOUNT_WITHOUT_RATE')
      expect(body.error.message).toMatch(/^Konto 4056 har en momskod för omvänd skattskyldighet/)
      expect(body.error.message).toMatch(/under Standard moms på kontot i kontoplanen, eller ta bort momskoden/)
      expect(body.error.message_en).toMatch(/chart of accounts/)
      expect(body.error.details.accounts).toEqual(['4056'])
      expect(correctEntryMock).not.toHaveBeenCalled()

      // What a pair beside it would have done, and what the kontoplan fixes.
      const paired = await declare([...original, debit('4535', 1000), credit('4598', 1000)], atZero)
      expect(paired.findings.map((f) => f.code)).toEqual(['RC_OUTPUT_MISSING'])
      expect(paired.findings[0].message).toMatch(/ingen Standard moms på 25, 12 eller 6 %/)
      const rated = await declare(original, [{ account: '4056', treatment: 'reverse_charge_eu_goods', rate: 0.25 }])
      expect(rated.gaps).toEqual([])
      expect(rated.findings).toEqual([])
    })
  })
})

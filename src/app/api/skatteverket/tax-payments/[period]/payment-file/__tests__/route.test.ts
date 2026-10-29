import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

const mockGenerateBgLb = vi.fn()
vi.mock('@/lib/salary/payment/bg-lb-generator', () => ({
  generateBankgiroPaymentBgLb: (...args: unknown[]) => mockGenerateBgLb(...args),
}))

const mockGeneratePain001 = vi.fn()
vi.mock('@/lib/payments/pain001-supplier', () => ({
  generateSupplierPain001: (...args: unknown[]) => mockGeneratePain001(...args),
}))

const mockResolveBatchDebtor = vi.fn()
vi.mock('@/lib/payments/batch-service', async (importOriginal) => {
  // The real ISO 2.0 rule and debtor mapping; only the settings read is mocked.
  const actual = await importOriginal<typeof import('@/lib/payments/batch-service')>()
  return {
    paysThroughSwedbankIso2: actual.paysThroughSwedbankIso2,
    supplierPain001Debtor: actual.supplierPain001Debtor,
    resolveBatchDebtor: (...args: unknown[]) => mockResolveBatchDebtor(...args),
  }
})

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted' }),
}))

vi.mock('@/lib/skatteverket/skattekonto-ocr', () => ({
  resolveSkattekontoOcr: vi.fn().mockResolvedValue('1655954700217'),
  SKATTEKONTO_BANKGIRO: '5050-1055',
}))

vi.mock('@/lib/bankgiro/luhn', () => ({
  validateBankgiroNumber: vi.fn().mockReturnValue(true),
}))

import { GET } from '../route'

describe('GET /api/skatteverket/tax-payments/[period]/payment-file', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
    mockGenerateBgLb.mockReturnValue({ content: 'LB-FILE', filename: 'skatt-2026-04.txt' })
    mockGeneratePain001.mockReturnValue('<Document/>')
    mockResolveBatchDebtor.mockResolvedValue({
      ok: true,
      debtor: {
        name: 'Test AB',
        org_number: '5566778899',
        iban: 'SE3550000000054910000003',
        bic: 'ESSESESS',
        bankgiro: '1234567',
        city: 'Stockholm',
      },
    })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file'),
      createMockRouteParams({ period: '2026-04' }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer without write permission', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file'),
      createMockRouteParams({ period: '2026-04' }),
    )
    expect(response.status).toBe(403)
  })

  it('generates the LB file (happy path)', async () => {
    enqueue({ data: { id: 'agi-1', total_tax: 1000, total_avgifter: 500 } }) // agi
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } }) // companies
    enqueue({ data: { bankgiro: '123-4567' } }) // company_settings
    enqueue({ data: null, error: null }) // update tax_payment_file_generated_at

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file'),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=iso-8859-1')
    expect(response.headers.get('Content-Disposition')).toContain('skatt-2026-04.txt')
    expect(mockGenerateBgLb).toHaveBeenCalledTimes(1)
    expect(mockGenerateBgLb.mock.calls[0][1]).toMatchObject({ amount: 1500 })
  })

  it('pays the declared whole-krona totals as-is for new-era declarations', async () => {
    // Declarations generated since the whole-krona change store the declared
    // integers (what Skatteverket computes from the underlag and draws), and
    // the matching salary booking credited 2731 with the same number: the
    // payment must be exactly their sum.
    enqueue({ data: { id: 'agi-1', total_tax: 12268, total_avgifter: 16073 } }) // agi
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } }) // companies
    enqueue({ data: { bankgiro: '123-4567' } }) // company_settings
    enqueue({ data: null, error: null }) // update tax_payment_file_generated_at

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file'),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(200)
    expect(mockGenerateBgLb.mock.calls[0][1]).toMatchObject({ amount: 28341 })
  })

  it('keeps paying öre-exact for legacy öre-bearing declarations', async () => {
    // Legacy rows predate the whole-krona storage: their salary bookings
    // credited 2731 with the öre, so the payment keeps clearing 2731 in full
    // (the öre parks as a small skattekonto överskott, the pre-existing
    // equilibrium). Truncating here would strand the öre on 2731 instead.
    enqueue({ data: { id: 'agi-1', total_tax: 12268, total_avgifter: 16073.84 } }) // agi
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } }) // companies
    enqueue({ data: { bankgiro: '123-4567' } }) // company_settings
    enqueue({ data: null, error: null }) // update tax_payment_file_generated_at

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file'),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(200)
    expect(mockGenerateBgLb.mock.calls[0][1]).toMatchObject({ amount: 28341.84 })
  })

  it('generates a pain.001 file when format=pain001', async () => {
    enqueue({ data: { id: 'agi-1', total_tax: 1000, total_avgifter: 500 } }) // agi
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } }) // companies
    enqueue({ data: null, error: null }) // update tax_payment_file_generated_at

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file', {
        searchParams: { format: 'pain001' },
      }),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/xml; charset=utf-8')
    expect(response.headers.get('Content-Disposition')).toContain('pain001_skatt_2026-04.xml')
    expect(mockGenerateBgLb).not.toHaveBeenCalled()
    expect(mockGeneratePain001).toHaveBeenCalledTimes(1)
    const [debtor, payments] = mockGeneratePain001.mock.calls[0]
    expect(debtor).toMatchObject({ iban: 'SE3550000000054910000003', bic: 'ESSESESS' })
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({
      payee: { type: 'bankgiro', bankgiro: '50501055' },
      payeeName: 'Skatteverket',
      amount: 1500,
      reference: { type: 'ocr', value: '1655954700217' },
    })
  })

  // The payee is Skatteverket's bankgiro, so the file is a bankgiro payment
  // and the debtor bank's rule for one applies. These two run the real
  // generator behind the route.
  async function pain001ThroughRealGenerator(): Promise<string> {
    const actual = await vi.importActual<typeof import('@/lib/payments/pain001-supplier')>(
      '@/lib/payments/pain001-supplier',
    )
    mockGeneratePain001.mockImplementation(
      (...args: Parameters<typeof actual.generateSupplierPain001>) => actual.generateSupplierPain001(...args),
    )
    enqueue({ data: { id: 'agi-1', total_tax: 1000, total_avgifter: 500 } }) // agi
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } }) // companies
    enqueue({ data: null, error: null }) // update tax_payment_file_generated_at

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file', {
        searchParams: { format: 'pain001' },
      }),
      createMockRouteParams({ period: '2026-04' }),
    )
    expect(response.status).toBe(200)
    return response.text()
  }

  it('debits the IBAN for the tax payment when the company banks with Danske Bank', async () => {
    mockResolveBatchDebtor.mockResolvedValue({
      ok: true,
      debtor: {
        name: 'Test AB',
        org_number: '5566778899',
        iban: 'SE7212000000012200111878',
        bic: 'DABASESX',
        bankgiro: '1234567',
        city: 'Stockholm',
      },
    })

    const xml = await pain001ThroughRealGenerator()

    // The route hands the generator the BIC that decides the rule, and the bankgiro it then leaves out.
    expect(mockGeneratePain001.mock.calls[0][0]).toMatchObject({ bic: 'DABASESX', bankgiro: '1234567' })
    const debtorAccounts = xml.match(/<DbtrAcct>[\s\S]*?<\/DbtrAcct>/g) ?? []
    expect(debtorAccounts).toHaveLength(1)
    expect(debtorAccounts[0]).toContain('<IBAN>SE7212000000012200111878</IBAN>')
    expect(debtorAccounts[0]).not.toContain('BGNR')
    expect(xml).toContain('<BIC>DABASESX</BIC>')
    // Still a payment to Skatteverket's bankgiro with the skattekonto OCR.
    const creditorAccount = xml.match(/<CdtrAcct>[\s\S]*?<\/CdtrAcct>/)![0]
    expect(creditorAccount).toContain('<Id>50501055</Id>')
    expect(creditorAccount).toContain('<SchmeNm><Prtry>BGNR</Prtry></SchmeNm>')
    expect(xml).toContain('<Ref>1655954700217</Ref>')
    expect(xml).toContain('<InstdAmt Ccy="SEK">1500.00</InstdAmt>')
  })

  it('keeps debiting the company bankgiro for the tax payment at every other bank', async () => {
    // The default debtor of this suite: SEB, with a company bankgiro.
    const xml = await pain001ThroughRealGenerator()

    const debtorAccounts = xml.match(/<DbtrAcct>[\s\S]*?<\/DbtrAcct>/g) ?? []
    expect(debtorAccounts).toHaveLength(1)
    expect(debtorAccounts[0]).toContain('<Id>1234567</Id>')
    expect(debtorAccounts[0]).toContain('<SchmeNm><Prtry>BGNR</Prtry></SchmeNm>')
    expect(xml).toContain('<BIC>ESSESESS</BIC>')
  })

  // Swedbank's ISO 2.0 file service pays to bank accounts only, and
  // Skatteverket is paid on its bankgiro (crm#1156): no file, whether the
  // company saved its Swedbank ids or not.
  it.each([
    [
      'with its Swedbank ids',
      {
        ok: true,
        debtor: {
          name: 'Test AB',
          org_number: '5566778899',
          iban: 'SE3580000832790000012345',
          bic: 'SWEDSESS',
          bankgiro: '1234567',
          city: 'Stockholm',
          swedbank_signer_id: '123456789ORI0001',
          swedbank_corporate_pay_id: '123456789CPO0001',
        },
      },
    ],
    ['without them', { ok: false, missing: 'swedbank_ids' }],
  ])('returns 400 for a Swedbank company %s: ISO 2.0 does not pay to a bankgiro', async (_case, resolution) => {
    mockResolveBatchDebtor.mockResolvedValue(resolution)
    enqueue({ data: { id: 'agi-1', total_tax: 1000, total_avgifter: 500 } }) // agi
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } }) // companies

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file', {
        searchParams: { format: 'pain001' },
      }),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toBe(
      'Swedbanks ISO 2.0-avtal betalar bara till bankkonton, och Skatteverket tar bara emot betalningar på bankgiro. Betala skatten i internetbanken.',
    )
    expect(mockGeneratePain001).not.toHaveBeenCalled()
  })

  it('returns 400 asking for the Signer ID when a Nordea company has not entered it (crm#1530)', async () => {
    mockResolveBatchDebtor.mockResolvedValue({ ok: false, missing: 'nordea_signer_id' })
    enqueue({ data: { id: 'agi-1', total_tax: 1000, total_avgifter: 500 } }) // agi
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } }) // companies

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file', {
        searchParams: { format: 'pain001' },
      }),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toContain('Nordea kräver företagets Signer ID')
    expect(body.error).toContain('Inställningar → Fakturor')
    expect(mockGeneratePain001).not.toHaveBeenCalled()
  })

  it("names a Nordea company's Signer ID as the sender of the tax payment file", async () => {
    mockResolveBatchDebtor.mockResolvedValue({
      ok: true,
      debtor: {
        name: 'Test AB',
        org_number: '5566778899',
        iban: 'SE4530000000031234567890',
        bic: 'NDEASESS',
        bankgiro: '1234567',
        city: 'Stockholm',
        nordea_signer_id: 'NB10000123456',
      },
    })
    enqueue({ data: { id: 'agi-1', total_tax: 1000, total_avgifter: 500 } }) // agi
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } }) // companies
    enqueue({ data: null, error: null }) // update tax_payment_file_generated_at

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file', {
        searchParams: { format: 'pain001' },
      }),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(200)
    expect(mockGeneratePain001.mock.calls[0][0]).toMatchObject({ bic: 'NDEASESS', nordeaSignerId: 'NB10000123456' })
  })

  it('keeps the period in every id, so two months never share an EndToEndId', async () => {
    const actual = await vi.importActual<typeof import('@/lib/payments/pain001-supplier')>(
      '@/lib/payments/pain001-supplier',
    )
    mockGeneratePain001.mockImplementation(
      (...args: Parameters<typeof actual.generateSupplierPain001>) => actual.generateSupplierPain001(...args),
    )
    const endToEndIds: string[] = []
    for (const period of ['2026-04', '2026-05']) {
      enqueue({ data: { id: 'agi-1', total_tax: 1000, total_avgifter: 500 } }) // agi
      enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } }) // companies
      enqueue({ data: null, error: null }) // update tax_payment_file_generated_at
      const response = await GET(
        createMockRequest(`/api/skatteverket/tax-payments/${period}/payment-file`, {
          searchParams: { format: 'pain001' },
        }),
        createMockRouteParams({ period }),
      )
      const xml = await response.text()
      expect(xml).toContain(`<MsgId>SKATT-${period}-5566778899</MsgId>`)
      endToEndIds.push(xml.match(/<EndToEndId>(.*?)<\/EndToEndId>/)![1])
    }
    expect(endToEndIds[0]).toContain('2026-04')
    expect(endToEndIds[1]).toContain('2026-05')
    expect(endToEndIds[0]).not.toBe(endToEndIds[1])
  })

  it('returns 400 when the pain.001 debtor is missing an IBAN', async () => {
    mockResolveBatchDebtor.mockResolvedValue({ ok: false, missing: 'iban' })
    enqueue({ data: { id: 'agi-1', total_tax: 1000, total_avgifter: 500 } }) // agi
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } }) // companies

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file', {
        searchParams: { format: 'pain001' },
      }),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(JSON.stringify(body)).toContain('IBAN')
    expect(mockGeneratePain001).not.toHaveBeenCalled()
  })

  it('returns 400 naming the paying account when it has no IBAN (crm#1483)', async () => {
    mockResolveBatchDebtor.mockResolvedValue({
      ok: false,
      missing: 'iban',
      account: { cash_account_id: 'ca-1930', name: 'Företagskonto', ledger_account: '1930', iban_last4: null },
    })
    enqueue({ data: { id: 'agi-1', total_tax: 1000, total_avgifter: 500 } }) // agi
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } }) // companies

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file', {
        searchParams: { format: 'pain001' },
      }),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe(
      'Betalfilen betalar från Företagskonto (1930), men kontot saknar IBAN. Fyll i kontots IBAN under Inställningar → Fakturor, Bankkonton för kundfakturor.',
    )
    expect(mockGeneratePain001).not.toHaveBeenCalled()
  })

  it('returns 400 for an unknown format', async () => {
    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file', {
        searchParams: { format: 'csv' },
      }),
      createMockRouteParams({ period: '2026-04' }),
    )
    expect(response.status).toBe(400)
    expect(mockGenerateBgLb).not.toHaveBeenCalled()
    expect(mockGeneratePain001).not.toHaveBeenCalled()
  })
})

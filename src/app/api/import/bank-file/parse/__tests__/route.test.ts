/**
 * Tests for POST /api/import/bank-file/parse, focused on the skattekonto
 * redirect: a skattekontoutdrag uploaded into the bank flow must be refused
 * with a pointer to the dedicated importer (its rows belong on 1630, not on
 * a bank account), while an explicit format override still forces a bank
 * parse as the escape hatch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { septemberFile } from '@/lib/import/bgmax/__tests__/bgmax-fixture'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  getCompanyRole: vi.fn().mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' }),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

const SKATTEKONTO_CSV = [
  '"Testbolaget AB";"556677-8899";""',
  '"";"Ingående saldo 2026-05-03";"-500"',
  '"2026-06-06";"Kostnadsränta";"-10"',
  '"";"Utgående saldo 2026-06-06";"-510"',
].join('\r\n')

const SEB_BANK_CSV = [
  'Bokföringsdag;Valutadag;Verifikationsnummer;Text;Belopp;Saldo',
  '2024-01-15;2024-01-15;12345;SPOTIFY AB;-99,00;12345,67',
].join('\n')

function makeFileRequest(content: string, filename: string, format?: string) {
  const formData = new FormData()
  formData.append('file', new File([content], filename, { type: 'text/csv' }))
  if (format) formData.append('format', format)
  return new Request('http://localhost:3000/api/import/bank-file/parse', {
    method: 'POST',
    body: formData,
  })
}

describe('POST /api/import/bank-file/parse (skattekonto redirect)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('refuses a skattekontoutdrag with a redirect error code', async () => {
    enqueue({ data: null }) // no prior bank_file_imports row
    const response = await POST(
      makeFileRequest(SKATTEKONTO_CSV, 'Kontoutdrag 556677-8899 2026-05-03--2026-08-01.csv'),
      emptyParams,
    )
    const body = await response.json()
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('BANK_FILE_SKATTEKONTO_DETECTED')
  })

  it('honors an explicit format override as the escape hatch', async () => {
    enqueue({ data: null }) // no prior bank_file_imports row
    const response = await POST(
      makeFileRequest(SKATTEKONTO_CSV, 'skattekonto.skv', 'generic_csv'),
      emptyParams,
    )
    // Not the redirect: the override forces a bank parse attempt.
    const body = await response.json()
    expect(body?.error?.code).not.toBe('BANK_FILE_SKATTEKONTO_DETECTED')
  })

  // crm#1170: Bankgirot's deposit specification is never a statement; with
  // or without a format override it goes to the deposit route instead of
  // creating rows that double the deposits.
  it('refuses a BG Max deposit specification, with or without a format override', async () => {
    for (const format of [undefined, 'generic_csv']) {
      const response = await POST(makeFileRequest(septemberFile(), 'BGMAX.txt', format), emptyParams)
      const body = await response.json()
      expect(response.status).toBe(400)
      expect(body.error.code).toBe('BANK_FILE_DEPOSIT_SPEC_DETECTED')
    }
    expect(supabase.from).not.toHaveBeenCalledWith('bank_file_imports')
  })

  it('parses a real bank file normally', async () => {
    enqueue({ data: null }) // no prior bank_file_imports row
    const response = await POST(makeFileRequest(SEB_BANK_CSV, 'kontoutdrag.csv'), emptyParams)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.data.detected_format).toBe('seb')
    expect(body.data.parse_result.transactions).toHaveLength(1)
  })
})

// crm#1204: the parse response says which cash account the file's own bank
// account already is, so the wizard can pre-select it.
describe('POST /api/import/bank-file/parse (account match)', () => {
  const SWEDBANK_CSV = [
    'Radnr,Clnr,Kontonr,Produkt,Valuta,Bokfdag,Transdag,Valutadag,Referens,Text,Belopp,Saldo',
    '1,8327-9,123 456 789-0,Företagskonto,SEK,2024-01-15,2024-01-15,2024-01-15,SPOTIFY,Kortköp,-99.00,12345.67',
  ].join('\n')
  const cashAccounts = [
    { ledger_account: '1930', iban: 'SE5580000832799876543210', bban: null, clearing_number: null, account_number: null, currency: 'SEK', enabled: true, is_primary: false, bank_connection_id: 'conn-1' },
    { ledger_account: '1931', iban: 'SE1280000832791234567890', bban: null, clearing_number: null, account_number: null, currency: 'SEK', enabled: true, is_primary: true, bank_connection_id: 'conn-1' },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    })
    const response = await POST(makeFileRequest(SWEDBANK_CSV, 'swedbank.csv'), emptyParams)
    expect(response.status).toBe(401)
    expect(supabase.from).not.toHaveBeenCalledWith('cash_accounts')
  })

  it('returns 400 without a file', async () => {
    const request = new Request('http://localhost:3000/api/import/bank-file/parse', {
      method: 'POST',
      body: new FormData(),
    })
    const response = await POST(request, emptyParams)
    const body = await response.json()
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('BANK_FILE_NO_FILE')
  })

  it('returns the statement account and the cash account it already is', async () => {
    enqueue({ data: null }) // no prior bank_file_imports row
    enqueue({ data: cashAccounts }) // cash_accounts for the match
    const response = await POST(makeFileRequest(SWEDBANK_CSV, 'swedbank.csv'), emptyParams)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.parse_result.account).toEqual({ iban: null, clearing: '8327-9', account_number: '123 456 789-0' })
    expect(body.data.account_match).toEqual({ ledger_account: '1931', ledger_accounts: ['1931'] })
  })

  it('still parses when the cash accounts cannot be read, leaving the choice to the user', async () => {
    enqueue({ data: null })
    enqueue({ error: { message: 'connection reset' } })
    const response = await POST(makeFileRequest(SWEDBANK_CSV, 'swedbank.csv'), emptyParams)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.account_match).toBeNull()
  })

  it('reads no cash account for a file that names none', async () => {
    enqueue({ data: null })
    const response = await POST(makeFileRequest(SEB_BANK_CSV, 'kontoutdrag.csv'), emptyParams)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.account_match).toBeNull()
    expect(supabase.from).not.toHaveBeenCalledWith('cash_accounts')
  })
})

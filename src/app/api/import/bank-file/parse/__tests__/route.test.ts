/**
 * Tests for POST /api/import/bank-file/parse, focused on the skattekonto
 * redirect: a skattekontoutdrag uploaded into the bank flow must be refused
 * with a pointer to the dedicated importer (its rows belong on 1630, not on
 * a bank account), while an explicit format override still forces a bank
 * parse as the escape hatch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as XLSX from 'xlsx'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { HANDELSBANKEN_XLSX_ROWS, streamedXlsx } from '@/tests/fixtures/streamed-xlsx'
import { septemberFile } from '@/lib/import/bgmax/__tests__/bgmax-fixture'
import { decemberFile } from '@/lib/import/camt054/__tests__/camt054-fixture'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

// A parser that throws, for the 500 a real fault still answers. Off again
// after every test, so no later test inherits it.
const parserFault = vi.hoisted(() => ({ throwOnParse: false }))
afterEach(() => {
  parserFault.throwOnParse = false
})
vi.mock('@/lib/import/bank-file/parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/import/bank-file/parser')>()
  return {
    ...actual,
    parseBankFile: (...args: Parameters<typeof actual.parseBankFile>) => {
      if (parserFault.throwOnParse) throw new TypeError('a parser bug')
      return actual.parseBankFile(...args)
    },
  }
})

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

function makeBytesRequest(bytes: ArrayBuffer, filename: string) {
  const formData = new FormData()
  formData.append('file', new File([bytes], filename))
  return new Request('http://localhost:3000/api/import/bank-file/parse', { method: 'POST', body: formData })
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

  it('sends the bank\'s notification of incoming payments (camt.054) the same way, whatever format was chosen', async () => {
    for (const format of [undefined, 'camt053']) {
      const response = await POST(makeFileRequest(decemberFile(), 'camt054.xml', format), emptyParams)
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

// The statement as it came: parse is the one request that holds the file, so
// it keeps the original under the content hash; execute records the arrival.
describe('POST /api/import/bank-file/parse (original archive)', () => {
  const COMPANY = '11111111-1111-4111-8111-111111111111'
  const bucket = supabase.storage.from('documents') as unknown as { upload: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    const { getActiveCompanyId } = await import('@/lib/company/context')
    vi.mocked(getActiveCompanyId).mockResolvedValueOnce(COMPANY)
  })

  it('archives a file with rows under its content hash, without overwriting', async () => {
    enqueue({ data: null }) // no prior bank_file_imports row
    const response = await POST(makeFileRequest(SEB_BANK_CSV, 'kontoutdrag oktober.csv'), emptyParams)
    const body = await response.json()
    expect(response.status).toBe(200)

    expect(supabase.storage.from).toHaveBeenCalledWith('documents')
    expect(bucket.upload).toHaveBeenCalledTimes(1)
    const [path, bytes, options] = bucket.upload.mock.calls[0] as [string, Uint8Array, Record<string, unknown>]
    expect(path).toBe(`documents/${COMPANY}/arrivals/bank_file/${body.data.file_hash}/kontoutdrag_oktober.csv`)
    expect(new TextDecoder().decode(bytes)).toBe(SEB_BANK_CSV)
    expect(options).toEqual({ contentType: 'text/csv', upsert: false })
  })

  it('still answers the preview when the archive fails', async () => {
    enqueue({ data: null })
    bucket.upload.mockRejectedValueOnce(new Error('storage down'))
    const response = await POST(makeFileRequest(SEB_BANK_CSV, 'kontoutdrag.csv'), emptyParams)
    expect(response.status).toBe(200)
  })

  it('keeps nothing for a file refused before parsing (a skattekontoutdrag)', async () => {
    enqueue({ data: null })
    const response = await POST(makeFileRequest(SKATTEKONTO_CSV, 'skattekonto.csv'), emptyParams)
    expect(response.status).toBe(400)
    expect(bucket.upload).not.toHaveBeenCalled()
  })
})

// crm#1236: Länsförsäkringar's kontoutdrag comes as one .xls file per month.
describe('POST /api/import/bank-file/parse (Excel files and unrecognized columns)', () => {
  function monthStatementXlsx(): ArrayBuffer {
    const serial = (iso: string) => {
      const [y, m, d] = iso.split('-').map(Number)
      return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000
    }
    const sheet: XLSX.WorkSheet = {
      A1: { t: 's', v: 'Kontoutdrag oktober 2025' },
      A2: { t: 's', v: 'Bokföringsdag' },
      B2: { t: 's', v: 'Transaktionsdag' },
      C2: { t: 's', v: 'Meddelande' },
      D2: { t: 's', v: 'Belopp' },
      A3: { t: 'n', v: serial('2025-10-03'), z: 'yyyy-mm-dd' },
      B3: { t: 'n', v: serial('2025-10-01'), z: 'yyyy-mm-dd' },
      C3: { t: 's', v: 'ICA NÄRA TESTBY' },
      D3: { t: 'n', v: -1234.5 },
      '!ref': 'A1:D3',
    }
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet, 'Kontoutdrag')
    return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('parses an Excel kontoutdrag and returns the text it was read as', async () => {
    enqueue({ data: null }) // no prior bank_file_imports row
    const response = await POST(makeBytesRequest(monthStatementXlsx(), 'Kontoutdrag 2025-10.xlsx'), emptyParams)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.detected_format).toBe('lansforsakringar')
    expect(body.data.parse_result.transactions).toEqual([
      expect.objectContaining({ date: '2025-10-03', description: 'ICA NÄRA TESTBY', amount: -1234.5 }),
    ])
    // The manual column mapping reads this text, not the workbook's bytes.
    expect(body.data.file_content.split('\n')[1]).toBe('Bokföringsdag;Transaktionsdag;Meddelande;Belopp')
  })

  it('returns no file_content for a text file', async () => {
    enqueue({ data: null })
    const response = await POST(makeFileRequest(SEB_BANK_CSV, 'kontoutdrag.csv'), emptyParams)
    const body = await response.json()
    expect(body.data.file_content).toBeNull()
  })

  it('names the found and expected columns when the chosen bank reads none of them', async () => {
    enqueue({ data: null })
    const response = await POST(
      makeFileRequest('Kontoutdrag oktober 2025\nDag;Vad;Summa kronor\n3 okt;ICA;-500\n', 'okand.csv', 'lansforsakringar'),
      emptyParams,
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('BANK_FILE_COLUMNS_UNRECOGNIZED')
    expect(body.error.message).toContain('Kolumner i filen: Dag, Vad, Summa kronor.')
    expect(body.error.message).toContain('Filen behöver en datumkolumn (Bokföringsdag, Bokföringsdatum, Transaktionsdatum eller Datum)')
    expect(body.error.details.found_columns).toEqual(['Dag', 'Vad', 'Summa kronor'])
  })
})

// Handelsbanken's Excel export answered 500 BANK_FILE_PARSE_FAILED: the xlsx
// reader could not open its streamed zip (2026-11-16 and 11-17).
describe('POST /api/import/bank-file/parse (Handelsbanken Excel export, unreadable workbooks)', () => {
  const bucket = supabase.storage.from('documents') as unknown as { upload: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it("parses Handelsbanken's export as Handelsbanken and keeps the file", async () => {
    const { getActiveCompanyId } = await import('@/lib/company/context')
    vi.mocked(getActiveCompanyId).mockResolvedValueOnce('11111111-1111-4111-8111-111111111111')
    enqueue({ data: null }) // no prior bank_file_imports row
    enqueue({ data: [] }) // cash_accounts for the statement's own account
    const response = await POST(
      makeBytesRequest(streamedXlsx({ rows: HANDELSBANKEN_XLSX_ROWS }), 'Handelsbanken_Account_Transactions_2026-11-16.xlsx'),
      emptyParams,
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.detected_format).toBe('handelsbanken')
    expect(body.data.parse_result.transactions.map((t: { date: string; amount: number }) => [t.date, t.amount])).toEqual([
      ['2026-11-16', -199.5],
      ['2026-11-12', 12500],
      ['2026-11-03', -2065.75],
    ])
    expect(bucket.upload).toHaveBeenCalledTimes(1)
  })

  it('refuses a workbook the reader cannot open, saying what to do, not a 500', async () => {
    const whole = new Uint8Array(streamedXlsx({ rows: HANDELSBANKEN_XLSX_ROWS }))
    const response = await POST(makeBytesRequest(whole.slice(0, 900).buffer, 'Handelsbanken 2026-11-17.xlsx'), emptyParams)
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('BANK_FILE_WORKBOOK_UNREADABLE')
    expect(body.error.message).toContain('Excelfilen kunde inte läsas')
    expect(bucket.upload).not.toHaveBeenCalled()
  })

  it('still answers a real fault with a 500 and logs the step and the error class', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      parserFault.throwOnParse = true
      enqueue({ data: null })
      const response = await POST(makeFileRequest(SEB_BANK_CSV, 'kontoutdrag.csv'), emptyParams)
      const body = await response.json()

      expect(response.status).toBe(500)
      expect(body.error.code).toBe('BANK_FILE_PARSE_FAILED')
      // The log line, then its serialized error on the next call (dev format).
      const at = errorLog.mock.calls.findIndex((call) => String(call[0]).includes('bank file parse failed'))
      expect(String(errorLog.mock.calls[at][0])).toContain('stage="parse"')
      expect(errorLog.mock.calls[at + 1][1]).toEqual(expect.objectContaining({ name: 'TypeError' }))
    } finally {
      errorLog.mockRestore()
    }
  })
})

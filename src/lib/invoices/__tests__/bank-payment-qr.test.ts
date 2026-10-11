/**
 * The bank-app payment QR payload (UsingQR revision 2, https://qrkod.info/,
 * crm#249): the exact JSON a Swedish bank app scans to fill in a bankgiro,
 * plusgiro or (with no giro on the invoice) bank account payment, and the QR
 * symbol the invoice PDF draws from it.
 */
import { describe, expect, it } from 'vitest'
import QRCode from 'qrcode'
import {
  BANK_PAYMENT_QR_QUIET_ZONE,
  bankPaymentQrPayee,
  bankPaymentQrSymbol,
  buildBankPaymentQrPayload,
  type BankPaymentQrCompany,
  type BankPaymentQrInput,
  type BankPaymentQrInvoice,
} from '@/lib/invoices/bank-payment-qr'

const company = (overrides: Partial<BankPaymentQrCompany> = {}): BankPaymentQrCompany => ({
  company_name: 'Testbolaget AB',
  org_number: '5566778899',
  bankgiro: '5050-1055',
  plusgiro: null,
  invoice_show_bankgiro: true,
  invoice_show_plusgiro: true,
  invoice_show_ocr: true,
  ...overrides,
})

const invoice = (overrides: Partial<BankPaymentQrInvoice> = {}): BankPaymentQrInvoice => ({
  invoice_number: '10234',
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  currency: 'SEK',
  status: 'sent',
  document_type: 'invoice',
  credited_invoice_id: null,
  ...overrides,
})

function build(overrides: {
  company?: Partial<BankPaymentQrCompany>
  invoice?: Partial<BankPaymentQrInvoice>
  amountDue?: number
  lang?: BankPaymentQrInput['lang']
} = {}): string | null {
  return buildBankPaymentQrPayload({
    company: company(overrides.company),
    invoice: invoice(overrides.invoice),
    amountDue: overrides.amountDue ?? 12500,
    lang: overrides.lang ?? 'sv',
  })
}

function parsed(payload: string | null): Record<string, unknown> {
  expect(payload).not.toBeNull()
  return JSON.parse(payload as string) as Record<string, unknown>
}

describe('buildBankPaymentQrPayload: format', () => {
  it('writes the spec payload for a bankgiro invoice, version and type first', () => {
    // OCR 102343 = invoice number 10234 + Luhn check digit 3, as printed.
    expect(build()).toBe(
      '{"uqr":1,"tp":1,"nme":"Testbolaget AB","cid":"556677-8899","iref":"102343","idt":"20261001","ddt":"20261031","due":12500,"pt":"BG","acc":"5050-1055"}',
    )
  })

  it('carries every field the spec makes mandatory for a payment (tp 1)', () => {
    const payload = parsed(build())
    for (const key of ['uqr', 'tp', 'nme', 'cid', 'iref', 'ddt', 'due', 'pt', 'acc']) {
      expect(payload, key).toHaveProperty(key)
    }
    expect(Object.keys(payload).slice(0, 2)).toEqual(['uqr', 'tp'])
    expect(payload.uqr).toBe(1)
    expect(payload.tp).toBe(1)
  })

  it('leaves out the currency on a domestic SEK invoice and carries no whitespace', () => {
    const payload = build() as string
    expect(parsed(payload)).not.toHaveProperty('cur')
    expect(payload).not.toMatch(/[\n\r\t]|": |, "/)
  })

  it('writes å, ä and ö as JSON escapes so the QR bytes are plain ASCII', () => {
    const payload = build({ company: { company_name: 'Åkesson & Öberg Fönsterputs AB' } }) as string
    expect(payload).toMatch(/^[\x20-\x7e]+$/)
    expect(payload).toContain('"nme":"\\u00c5kesson & \\u00d6berg F\\u00f6nsterputs AB"')
    expect(parsed(payload).nme).toBe('Åkesson & Öberg Fönsterputs AB')
  })

  it('escapes quotes and backslashes in the name as JSON does', () => {
    const payload = build({ company: { company_name: 'Bolaget "Bästa" AB' } })
    expect(parsed(payload).nme).toBe('Bolaget "Bästa" AB')
  })
})

describe('buildBankPaymentQrPayload: amount', () => {
  it('writes the amount as a JSON number without insignificant digits', () => {
    expect(build({ amountDue: 500 })).toContain('"due":500,')
    expect(build({ amountDue: 500.1 })).toContain('"due":500.1,')
    expect(build({ amountDue: 1234.56 })).toContain('"due":1234.56,')
  })

  it('rounds the amount to whole öre', () => {
    expect(parsed(build({ amountDue: 0.1 + 0.2 })).due).toBe(0.3)
    expect(parsed(build({ amountDue: 99.999 })).due).toBe(100)
    expect(parsed(build({ amountDue: 1250.004 })).due).toBe(1250)
  })

  it('returns null when nothing is left to pay, never a zero or negative amount', () => {
    expect(build({ amountDue: 0 })).toBeNull()
    expect(build({ amountDue: -250 })).toBeNull()
    expect(build({ amountDue: 0.004 })).toBeNull()
    expect(build({ amountDue: Number.NaN })).toBeNull()
  })
})

describe('buildBankPaymentQrPayload: dates', () => {
  it('writes the invoice and due dates as YYYYMMDD', () => {
    const payload = parsed(build({ invoice: { invoice_date: '2026-01-05', due_date: '2026-02-04' } }))
    expect(payload.idt).toBe('20260105')
    expect(payload.ddt).toBe('20260204')
  })

  it('accepts a timestamp and keeps its date part', () => {
    expect(parsed(build({ invoice: { due_date: '2026-10-31T00:00:00+00:00' } })).ddt).toBe('20261031')
  })

  it('leaves out the optional invoice date when it is missing', () => {
    expect(parsed(build({ invoice: { invoice_date: null } }))).not.toHaveProperty('idt')
  })

  it('returns null without a valid due date (mandatory)', () => {
    expect(build({ invoice: { due_date: null } })).toBeNull()
    expect(build({ invoice: { due_date: '31/10/2026' } })).toBeNull()
  })
})

describe('buildBankPaymentQrPayload: account', () => {
  it('pays to the plusgiro when the company has no bankgiro', () => {
    const payload = parsed(build({ company: { bankgiro: null, plusgiro: '1760990' } }))
    expect(payload.pt).toBe('PG')
    expect(payload.acc).toBe('176099-0')
  })

  it('prefers the bankgiro when both are on the invoice (the format carries one method)', () => {
    const payload = parsed(build({ company: { bankgiro: '9912346', plusgiro: '176099-0' } }))
    expect(payload.pt).toBe('BG')
    expect(payload.acc).toBe('991-2346')
  })

  it('uses the plusgiro when the bankgiro is hidden on the invoice', () => {
    const payload = parsed(build({ company: { plusgiro: '4567-4', invoice_show_bankgiro: false } }))
    expect(payload.pt).toBe('PG')
    expect(payload.acc).toBe('4567-4')
  })

  it('never encodes a giro whose check digit is wrong', () => {
    expect(build({ company: { bankgiro: '5050-1056' } })).toBeNull()
    expect(parsed(build({ company: { bankgiro: '5050-1056', plusgiro: '4567-4' } })).pt).toBe('PG')
  })

  it('returns null without a printed bankgiro, plusgiro or bank account', () => {
    expect(build({ company: { bankgiro: null, plusgiro: null } })).toBeNull()
    expect(build({ company: { bankgiro: '5050-1055', invoice_show_bankgiro: false } })).toBeNull()
    // Half an account does not print (lib/invoices/payment-rows), so it cannot be paid to.
    expect(build({ company: { bankgiro: null, clearing_number: '6000', account_number: null } })).toBeNull()
    expect(build({ company: { bankgiro: null, clearing_number: null, account_number: '658159712' } })).toBeNull()
  })
})

describe('buildBankPaymentQrPayload: the spec\'s own examples (chapter 8.1, domestic Swedish payments)', () => {
  const specCompany = { company_name: 'Test company AB', org_number: '5555555555' }

  it('Example 1: pt BG, byte for byte', () => {
    expect(
      build({
        company: { ...specCompany, bankgiro: '4338778', invoice_show_ocr: false },
        invoice: { invoice_number: '52456', invoice_date: null, due_date: '2013-04-08' },
        amountDue: 5,
      }),
    ).toBe(
      '{"uqr":1,"tp":1,"nme":"Test company AB","cid":"555555-5555","iref":"52456","ddt":"20130408","due":5,"pt":"BG","acc":"433-8778"}',
    )
  })

  it('Example 2: pt BBAN with the Handelsbanken account and its BIC, byte for byte', () => {
    expect(
      build({
        company: { ...specCompany, bankgiro: null, clearing_number: '6000', account_number: '658159712' },
        invoice: { invoice_number: '52456', invoice_date: '2013-04-08', due_date: '2013-05-08' },
        amountDue: 5,
      }),
    ).toBe(
      '{"uqr":1,"tp":1,"nme":"Test company AB","cid":"555555-5555","iref":"52456","idt":"20130408","ddt":"20130508","due":5,"pt":"BBAN","acc":"6000658159712","bc":"HANDSESS"}',
    )
  })
})

describe('buildBankPaymentQrPayload: bank account (pt BBAN, chapter 4.1)', () => {
  /** Only a bank account prints: no bankgiro, no plusgiro. */
  const bankOnly = (overrides: Partial<BankPaymentQrCompany> = {}) => ({
    bankgiro: null,
    plusgiro: null,
    clearing_number: '6000',
    account_number: '658159712',
    ...overrides,
  })

  it('pays to the printed bank account when the invoice prints no giro', () => {
    const payload = parsed(build({ company: bankOnly() }))
    expect(payload).toMatchObject({ pt: 'BBAN', acc: '6000658159712', bc: 'HANDSESS' })
    for (const key of ['uqr', 'tp', 'nme', 'cid', 'iref', 'ddt', 'due', 'pt', 'acc']) {
      expect(payload, key).toHaveProperty(key)
    }
    // Domestic: no country code, no address (the spec asks for them with IBAN or a foreign bank code).
    expect(payload).not.toHaveProperty('cc')
    expect(payload).not.toHaveProperty('adr')
    expect(payload).not.toHaveProperty('cur')
  })

  it('still prefers a printed bankgiro or plusgiro ("Only if the sender didn\'t provide either a PG or BG number should BBAN be used")', () => {
    expect(parsed(build({ company: bankOnly({ bankgiro: '5050-1055' }) }))).toMatchObject({ pt: 'BG', acc: '5050-1055' })
    expect(parsed(build({ company: bankOnly({ plusgiro: '4567-4' }) }))).toMatchObject({ pt: 'PG', acc: '4567-4' })
    expect(parsed(build({ company: bankOnly({ bankgiro: '5050-1055' }) }))).not.toHaveProperty('bc')
  })

  it('takes the bank account when the giro is stored but hidden on the invoice', () => {
    const payload = parsed(build({ company: bankOnly({ bankgiro: '5050-1055', invoice_show_bankgiro: false }) }))
    expect(payload).toMatchObject({ pt: 'BBAN', acc: '6000658159712' })
  })

  it('never routes around a printed giro with a wrong check digit: the page tells the payer to use it', () => {
    expect(build({ company: bankOnly({ bankgiro: '5050-1056' }) })).toBeNull()
  })

  it('never encodes an account the bank\'s check-digit rule rejects or cannot check', () => {
    // Handelsbanken, mod 11 over the account: the last digit off by one.
    expect(build({ company: bankOnly({ account_number: '658159713' }) })).toBeNull()
    // A bank without a known rule: "unknown" is not "valid".
    expect(build({ company: bankOnly({ clearing_number: '9020', account_number: '1234567' }) })).toBeNull()
    // Not an account shape any payment file accepts.
    expect(build({ company: bankOnly({ clearing_number: '600', account_number: '658159712' }) })).toBeNull()
    expect(build({ company: bankOnly({ account_number: '6581-5971x' }) })).toBeNull()
  })

  it('writes a 5-digit Swedbank clearing as the spec does ("8169-5 9139876057")', () => {
    expect(parsed(build({ company: bankOnly({ clearing_number: '8169-5', account_number: '913 987 605-7' }) }))).toMatchObject({
      pt: 'BBAN',
      acc: '8169-5 9139876057',
      bc: 'SWEDSESS',
    })
  })

  it('adds the clearing check digit when a Swedbank clearing is stored with four digits', () => {
    expect(parsed(build({ company: bankOnly({ clearing_number: '8169', account_number: '9139876057' }) })).acc).toBe(
      '8169-5 9139876057',
    )
    // A fifth digit that is not the check digit is a wrong clearing.
    expect(build({ company: bankOnly({ clearing_number: '81694', account_number: '9139876057' }) })).toBeNull()
  })

  it('reads the account without separators, and without a clearing typed in front of it', () => {
    expect(parsed(build({ company: bankOnly({ account_number: '658 159 712' }) })).acc).toBe('6000658159712')
    expect(parsed(build({ company: bankOnly({ clearing_number: '5000', account_number: '50001234560' }) }))).toMatchObject({
      acc: '50001234560',
      bc: 'ESSESESS',
    })
  })

  it('names the bank by the clearing table\'s BIC, else the payee\'s stored Swedish BIC, else not at all', () => {
    // Nordea 4000-4999 has a check-digit rule but no BIC in the clearing table.
    const nordea = bankOnly({ clearing_number: '4000', account_number: '1234567' })
    expect(parsed(build({ company: nordea }))).toMatchObject({ pt: 'BBAN', acc: '40001234567' })
    expect(parsed(build({ company: nordea }))).not.toHaveProperty('bc')
    expect(parsed(build({ company: { ...nordea, bic: 'ndea sess' } })).bc).toBe('NDEASESS')
    // A foreign BIC cannot name a Swedish account's bank.
    expect(parsed(build({ company: { ...nordea, bic: 'DABADKKK' } }))).not.toHaveProperty('bc')
    // The clearing in acc decides the bank, not a stored BIC that disagrees with it.
    expect(parsed(build({ company: bankOnly({ bic: 'ESSESESS' }) })).bc).toBe('HANDSESS')
  })

  it('uses the invoice number as the reference: the OCR row prints only beside a giro', () => {
    expect(parsed(build({ company: bankOnly(), lang: 'sv' })).iref).toBe('10234')
    expect(parsed(build({ company: bankOnly(), lang: 'en' })).iref).toBe('10234')
  })

  it('stays a small symbol', async () => {
    const symbol = await bankPaymentQrSymbol(build({ company: bankOnly({ clearing_number: '81695', account_number: '9139876057' }) }) as string)
    expect(symbol!.size).toBeLessThanOrEqual(57 + 2 * BANK_PAYMENT_QR_QUIET_ZONE)
  })
})

describe('bankPaymentQrPayee', () => {
  it('says why there is no account to pay to', () => {
    expect(bankPaymentQrPayee({ bankgiro: null })).toEqual({ ok: false, reason: 'no_printed_giro' })
    expect(bankPaymentQrPayee({ bankgiro: '5050-1056' })).toEqual({ ok: false, reason: 'invalid_giro' })
    expect(bankPaymentQrPayee({ plusgiro: '4567-5' })).toEqual({ ok: false, reason: 'invalid_giro' })
    expect(bankPaymentQrPayee({ clearing_number: '6000', account_number: '658159713' })).toEqual({
      ok: false,
      reason: 'invalid_bank_account',
    })
    expect(bankPaymentQrPayee({ clearing_number: '12', account_number: '658159712' })).toEqual({
      ok: false,
      reason: 'invalid_bank_account',
    })
    expect(bankPaymentQrPayee({ clearing_number: '9020', account_number: '1234567' })).toEqual({
      ok: false,
      reason: 'unverified_bank_account',
    })
  })

  it('calls an account too long for a bank with a known rule wrong, not unverifiable', () => {
    // SEB accounts have 7 digits, Handelsbanken 9: the validator says 'unknown'
    // for the length, but the bank is known, so the number is what is wrong.
    expect(bankPaymentQrPayee({ clearing_number: '5000', account_number: '12345678' })).toEqual({
      ok: false,
      reason: 'invalid_bank_account',
    })
    expect(bankPaymentQrPayee({ clearing_number: '6000', account_number: '6581597120' })).toEqual({
      ok: false,
      reason: 'invalid_bank_account',
    })
  })

  it('returns the account the payload writes', () => {
    expect(bankPaymentQrPayee({ bankgiro: '5050-1055', clearing_number: '6000', account_number: '658159712' })).toEqual({
      ok: true,
      pt: 'BG',
      acc: '5050-1055',
    })
    expect(bankPaymentQrPayee({ clearing_number: '6000', account_number: '658159712' })).toEqual({
      ok: true,
      pt: 'BBAN',
      acc: '6000658159712',
      bc: 'HANDSESS',
    })
  })
})

describe('buildBankPaymentQrPayload: reference and identity', () => {
  it('uses the printed OCR reference on a Swedish invoice', () => {
    expect(parsed(build({ invoice: { invoice_number: 'F-2024001' } })).iref).toBe('20240016')
  })

  it('uses the invoice number when the OCR row is switched off', () => {
    expect(parsed(build({ company: { invoice_show_ocr: false } })).iref).toBe('10234')
  })

  it('uses the invoice number on an English invoice, which prints no OCR row', () => {
    expect(parsed(build({ lang: 'en' })).iref).toBe('10234')
  })

  it('keeps the OCR reference when it pays to a printed plusgiro behind a hidden bankgiro', () => {
    const payload = parsed(build({ company: { plusgiro: '4567-4', invoice_show_bankgiro: false } }))
    expect(payload.pt).toBe('PG')
    expect(payload.iref).toBe('102343')
  })

  it('formats a ten-digit org number as on the invoice and keeps a twelve-digit one', () => {
    expect(parsed(build()).cid).toBe('556677-8899')
    expect(parsed(build({ company: { org_number: '198501011234' } })).cid).toBe('198501011234')
  })

  it('returns null without a mandatory name, org number or invoice number', () => {
    expect(build({ company: { company_name: '  ' } })).toBeNull()
    expect(build({ company: { org_number: null } })).toBeNull()
    expect(build({ invoice: { invoice_number: null } })).toBeNull()
    expect(build({ invoice: { invoice_number: ' ' } })).toBeNull()
  })
})

// Whether an invoice prints this code at all is the QR mode's call
// (lib/invoices/payment-qr.ts, tested in payment-qr.test.ts); the builder
// itself still refuses anything a bank app must not pay.
describe('buildBankPaymentQrPayload: which documents get a QR', () => {
  it('never puts a payment QR on a credit note', () => {
    expect(build({ invoice: { credited_invoice_id: 'inv-orig' } })).toBeNull()
  })

  it('only on a real invoice: no proforma, quote or delivery note', () => {
    for (const documentType of ['proforma', 'quote', 'delivery_note']) {
      expect(build({ invoice: { document_type: documentType } }), documentType).toBeNull()
    }
    expect(build({ invoice: { document_type: null } })).not.toBeNull()
  })

  it('not on a paid, cancelled or credited invoice', () => {
    for (const status of ['paid', 'cancelled', 'credited']) {
      expect(build({ invoice: { status } }), status).toBeNull()
    }
    for (const status of ['draft', 'sent', 'overdue', 'partially_paid']) {
      expect(build({ invoice: { status } }), status).not.toBeNull()
    }
  })

  it('returns null for a foreign-currency invoice (bankgiro and plusgiro are SEK)', () => {
    expect(build({ invoice: { currency: 'EUR' } })).toBeNull()
    expect(build({ invoice: { currency: 'USD' } })).toBeNull()
    expect(build({ invoice: { currency: null } })).not.toBeNull()
  })
})

describe('bankPaymentQrSymbol', () => {
  const payload = build() as string

  /** Rebuild the dark-module grid from the path the PDF draws. */
  function gridFromPath(path: string, size: number): boolean[][] {
    const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => false))
    for (const match of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
      const [x, y, run, back] = match.slice(1).map(Number)
      expect(back).toBe(run)
      for (let col = x; col < x + run; col++) grid[y][col] = true
    }
    return grid
  }

  it('draws exactly the modules of a byte-mode, level M QR code of the payload', async () => {
    const symbol = await bankPaymentQrSymbol(payload)
    expect(symbol).not.toBeNull()
    const reference = QRCode.create([{ mode: 'byte', data: new TextEncoder().encode(payload) }], {
      errorCorrectionLevel: 'M',
    })
    expect(reference.segments.every((segment) => segment.mode.id === 'Byte')).toBe(true)
    const { size, data } = reference.modules
    const q = BANK_PAYMENT_QR_QUIET_ZONE
    expect(symbol!.size).toBe(size + 2 * q)

    const grid = gridFromPath(symbol!.path, symbol!.size)
    for (let row = 0; row < symbol!.size; row++) {
      for (let col = 0; col < symbol!.size; col++) {
        const inSymbol = row >= q && row < q + size && col >= q && col < q + size
        const expected = inSymbol ? data[(row - q) * size + (col - q)] === 1 : false
        expect(grid[row][col], `module ${row},${col}`).toBe(expected)
      }
    }
  })

  it('keeps a quiet zone of four modules (spec 1.2)', () => {
    expect(BANK_PAYMENT_QR_QUIET_ZONE).toBeGreaterThanOrEqual(4)
  })

  it('stays a small symbol for an ordinary invoice, so it scans from print', async () => {
    const symbol = await bankPaymentQrSymbol(payload)
    // Version 10 is 57 modules; plus the quiet zone.
    expect(symbol!.size).toBeLessThanOrEqual(57 + 2 * BANK_PAYMENT_QR_QUIET_ZONE)
  })

  it('returns null when the payload cannot fit a QR code', async () => {
    expect(await bankPaymentQrSymbol('x'.repeat(5000))).toBeNull()
  })
})

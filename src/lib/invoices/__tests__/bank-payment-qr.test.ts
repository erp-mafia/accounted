/**
 * The bank-app payment QR payload (UsingQR revision 2, https://qrkod.info/,
 * crm#249): the exact JSON a Swedish bank app scans to fill in a bankgiro
 * or plusgiro payment, and the QR symbol the invoice PDF draws from it. No
 * code for a plain bank account (crm#1191).
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

  it('returns null without a printed bankgiro or plusgiro', () => {
    expect(build({ company: { bankgiro: null, plusgiro: null } })).toBeNull()
    expect(build({ company: { bankgiro: '5050-1055', invoice_show_bankgiro: false } })).toBeNull()
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

  it('Example 2 (pt BBAN, a Handelsbanken account) gives no code: bank apps read acc as a giro (crm#1191)', () => {
    expect(
      build({
        company: { ...specCompany, bankgiro: null, clearing_number: '6000', account_number: '658159712' },
        invoice: { invoice_number: '52456', invoice_date: '2013-04-08', due_date: '2013-05-08' },
        amountDue: 5,
      }),
    ).toBeNull()
  })
})

describe('buildBankPaymentQrPayload: a plain bank account gets no code (crm#1191)', () => {
  /** Only a bank account prints: no bankgiro, no plusgiro. */
  const bankOnly = (overrides: Partial<BankPaymentQrCompany> = {}) => ({
    bankgiro: null,
    plusgiro: null,
    clearing_number: '6000',
    account_number: '658159712',
    ...overrides,
  })

  it('Handelsbanken (clearing 6xxx, 9-digit account): no code, whichever language', () => {
    expect(build({ company: bankOnly() })).toBeNull()
    expect(build({ company: bankOnly(), lang: 'en' })).toBeNull()
    expect(bankPaymentQrPayee(bankOnly())).toEqual({ ok: false, reason: 'bank_account_only' })
  })

  it('Swedbank with a 5-digit clearing: no code, stored with or without the clearing check digit', () => {
    expect(build({ company: bankOnly({ clearing_number: '8169-5', account_number: '913 987 605-7' }) })).toBeNull()
    expect(build({ company: bankOnly({ clearing_number: '8169', account_number: '9139876057' }) })).toBeNull()
    expect(bankPaymentQrPayee(bankOnly({ clearing_number: '81695', account_number: '9139876057' }))).toEqual({
      ok: false,
      reason: 'bank_account_only',
    })
  })

  it('Nordea personkonto (clearing 3300, the personnummer as account): no code', () => {
    const personkonto = bankOnly({ clearing_number: '3300', account_number: '811218-9876' })
    expect(build({ company: personkonto })).toBeNull()
    expect(bankPaymentQrPayee(personkonto)).toEqual({ ok: false, reason: 'bank_account_only' })
  })

  it('no code when the giro is stored but hidden on the invoice and only the account prints', () => {
    expect(build({ company: bankOnly({ bankgiro: '5050-1055', invoice_show_bankgiro: false }) })).toBeNull()
  })

  it('a printed bankgiro or plusgiro beside the account still gives the same code as before', () => {
    expect(build({ company: bankOnly({ bankgiro: '5050-1055' }) })).toBe(build())
    expect(build({ company: bankOnly({ plusgiro: '4567-4' }) })).toBe(
      '{"uqr":1,"tp":1,"nme":"Testbolaget AB","cid":"556677-8899","iref":"102343","idt":"20261001","ddt":"20261031","due":12500,"pt":"PG","acc":"4567-4"}',
    )
  })

  it('never routes around a printed giro with a wrong check digit: the page tells the payer to use it', () => {
    expect(build({ company: bankOnly({ bankgiro: '5050-1056' }) })).toBeNull()
    expect(bankPaymentQrPayee(bankOnly({ bankgiro: '5050-1056' }))).toEqual({ ok: false, reason: 'invalid_giro' })
  })
})

describe('bankPaymentQrPayee', () => {
  it('says why there is no account to pay to', () => {
    expect(bankPaymentQrPayee({ bankgiro: null })).toEqual({ ok: false, reason: 'no_printed_giro' })
    expect(bankPaymentQrPayee({ bankgiro: '5050-1056' })).toEqual({ ok: false, reason: 'invalid_giro' })
    expect(bankPaymentQrPayee({ plusgiro: '4567-5' })).toEqual({ ok: false, reason: 'invalid_giro' })
    expect(bankPaymentQrPayee({ clearing_number: '6000', account_number: '658159712' })).toEqual({
      ok: false,
      reason: 'bank_account_only',
    })
    // Half an account does not print (lib/invoices/payment-rows): nothing prints to pay to.
    expect(bankPaymentQrPayee({ clearing_number: '6000', account_number: null })).toEqual({
      ok: false,
      reason: 'no_printed_giro',
    })
    expect(bankPaymentQrPayee({ clearing_number: ' ', account_number: '658159712' })).toEqual({
      ok: false,
      reason: 'no_printed_giro',
    })
  })

  it('returns the giro the payload writes', () => {
    expect(bankPaymentQrPayee({ bankgiro: '5050-1055', clearing_number: '6000', account_number: '658159712' })).toEqual({
      ok: true,
      pt: 'BG',
      acc: '5050-1055',
    })
    expect(bankPaymentQrPayee({ bankgiro: null, plusgiro: '1760990' })).toEqual({ ok: true, pt: 'PG', acc: '176099-0' })
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

  it('writes the org number as the invoice prints it, whichever form it is stored in', () => {
    expect(parsed(build()).cid).toBe('556677-8899')
    expect(parsed(build({ company: { org_number: '165566778899' } })).cid).toBe('556677-8899')
    expect(parsed(build({ company: { org_number: '198003740118' } })).cid).toBe('800374-0118')
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

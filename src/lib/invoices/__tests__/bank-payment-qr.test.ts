/**
 * The bank-app payment QR payload (UsingQR revision 2, https://qrkod.info/,
 * crm#249): the exact JSON a Swedish bank app scans to fill in a bankgiro or
 * plusgiro payment, and the QR symbol the invoice PDF draws from it.
 */
import { describe, expect, it } from 'vitest'
import QRCode from 'qrcode'
import {
  BANK_PAYMENT_QR_QUIET_ZONE,
  bankPaymentQrSymbol,
  buildBankPaymentQrPayload,
  type BankPaymentQrCompany,
  type BankPaymentQrInput,
  type BankPaymentQrInvoice,
} from '@/lib/invoices/bank-payment-qr'

const company = (overrides: Partial<BankPaymentQrCompany> = {}): BankPaymentQrCompany => ({
  invoice_show_payment_qr: true,
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

describe('buildBankPaymentQrPayload: which documents get a QR', () => {
  it('is off unless the company switched it on', () => {
    expect(build({ company: { invoice_show_payment_qr: false } })).toBeNull()
    expect(build({ company: { invoice_show_payment_qr: null } })).toBeNull()
    expect(build({ company: { invoice_show_payment_qr: undefined } })).toBeNull()
  })

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

  it('draws exactly the modules of a byte-mode, level M QR code of the payload', () => {
    const symbol = bankPaymentQrSymbol(payload)
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

  it('stays a small symbol for an ordinary invoice, so it scans from print', () => {
    const symbol = bankPaymentQrSymbol(payload)
    // Version 10 is 57 modules; plus the quiet zone.
    expect(symbol!.size).toBeLessThanOrEqual(57 + 2 * BANK_PAYMENT_QR_QUIET_ZONE)
  })

  it('returns null when the payload cannot fit a QR code', () => {
    expect(bankPaymentQrSymbol('x'.repeat(5000))).toBeNull()
  })
})

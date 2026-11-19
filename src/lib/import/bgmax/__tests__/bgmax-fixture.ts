/**
 * A synthetic BG Max file, built record by record from the layout in
 * Bankgirot's "Bankgiro Inbetalningar Teknisk manual" (oktober 2023),
 * chapter 2. Every number here is made up: bankgiro numbers carry a valid
 * Luhn check digit and nothing else.
 */
import { formatBankgiroNumber, luhnCheckDigit } from '@/lib/bankgiro/luhn'

const withCheck = (payload: string): string => `${payload}${luhnCheckDigit(payload)}`

/** The company's own bankgiro (fictional). */
export const OWN_BG_DIGITS = withCheck('999012')
export const OWN_BG = formatBankgiroNumber(OWN_BG_DIGITS)
/** Another bankgiro (fictional), never the company's. */
export const OTHER_BG_DIGITS = withCheck('555044')
export const OTHER_BG = formatBankgiroNumber(OTHER_BG_DIGITS)
/** A payer's bankgiro (fictional). */
export const PAYER_BG_DIGITS = withCheck('888034')

const zero = (value: string | number, width: number): string => String(value).padStart(width, '0')

/** One 80-character record: the transaction code, then each field at its 1-based start position. */
export function record(tk: string, fields: Array<[from: number, value: string]>): string {
  const line = Array.from({ length: 80 }, () => ' ')
  line[0] = tk[0]!
  line[1] = tk[1]!
  for (const [from, value] of fields) {
    for (let i = 0; i < value.length; i++) line[from - 1 + i] = value[i]!
  }
  return line.join('')
}

export const start = (marker: 'P' | 'T' = 'P') =>
  record('01', [[3, 'BGMAX'.padEnd(20)], [23, '01'], [25, '20261001093015123456'], [45, marker]])

export const opening = (bankgiroDigits: string = OWN_BG_DIGITS) =>
  record('05', [[3, zero(bankgiroDigits, 10)], [23, 'SEK']])

export interface PaymentFields {
  ore: number
  reference?: string
  /** Tabell 5: '2' a checked OCR, '3' free references, '0' blank. */
  referenceCode?: string
  payerBg?: string
  serial?: number
}

export const payment = (p: PaymentFields, tk: '20' | '21' = '20') => {
  const code = p.referenceCode ?? (p.reference ? '2' : '0')
  const reference = p.reference ?? ''
  return record(tk, [
    [3, zero(p.payerBg ?? '0', 10)],
    // OCR is right-aligned and blank-filled (N:hb); other references left-aligned.
    [13, code === '2' ? reference.padStart(25) : reference.padEnd(25)],
    [38, zero(p.ore, 18)],
    [56, code],
    [57, '1'],
    [58, zero(p.serial ?? 1, 12)],
    [70, '0'],
    ...(tk === '21' ? ([[71, '0']] as Array<[number, string]>) : []),
  ])
}

export const deduction = (p: PaymentFields) => payment(p, '21')

export const extraReference = (reference: string, payerBg = '0', serial = 1) =>
  record('22', [[3, zero(payerBg, 10)], [13, reference.padStart(25)], [38, zero(0, 18)], [56, '2'], [57, '1'], [58, zero(serial, 12)], [70, '0']])

export const info = (text: string) => record('25', [[3, text.padEnd(50)]])
export const name = (payer: string, extra = '') => record('26', [[3, payer.padEnd(35)], [38, extra.padEnd(35)]])
export const address = (street: string, postcode: string) => record('27', [[3, street.padEnd(35)], [38, postcode.padEnd(9)]])
export const city = (town: string) => record('28', [[3, town.padEnd(35)]])
export const orgNumber = (digits: string) => record('29', [[3, zero(digits, 12)]])

export interface DepositFields {
  date: string // YYYYMMDD
  serial: number
  ore: number
  count: number
  account?: string
}

export const depositRecord = (d: DepositFields) =>
  record('15', [
    [3, zero(d.account ?? '84800000123456', 35)],
    [38, d.date],
    [46, zero(d.serial, 5)],
    [51, zero(d.ore, 18)],
    [69, 'SEK'],
    [72, zero(d.count, 8)],
  ])

export const end = (counts: { payments: number; deductions: number; extra: number; deposits: number }) =>
  record('70', [[3, zero(counts.payments, 8)], [11, zero(counts.deductions, 8)], [19, zero(counts.extra, 8)], [27, zero(counts.deposits, 8)]])

/**
 * Four deposits to the company's bankgiro in September 2026:
 *   1. 2026-09-14 #12, 1 500,00: an OCR payment (Kund AB, 10017 = invoice 1001)
 *      and a free-text one ("Faktura 1002", extra OCR 10025, a message);
 *   2. 2026-09-15 #13, 200,00: an OCR payment of 250,00 (10033 = invoice 1003)
 *      less a 50,00 deduction;
 *   3. 2026-09-16 #14, 750,00: one OCR payment (10041 = invoice 1004);
 *   4. 2026-09-30 #15, 999,00: one payment with no reference.
 */
export function septemberFile(): string {
  return [
    start(),
    opening(),
    payment({ ore: 50000, reference: '10017', payerBg: PAYER_BG_DIGITS, serial: 101 }),
    name('Kund AB'),
    orgNumber('5560160680'),
    payment({ ore: 100000, reference: 'Faktura 1002', referenceCode: '3', serial: 102 }),
    extraReference('10025', '0', 102),
    info('Tack för leveransen'),
    name('Bolaget i Norr', 'AB'),
    address('Storgatan 1', '90325'),
    city('UMEÅ'),
    depositRecord({ date: '20260914', serial: 12, ore: 150000, count: 2 }),
    opening(),
    payment({ ore: 25000, reference: '10033', serial: 103 }),
    name('Kund AB'),
    deduction({ ore: 5000, reference: '9999', referenceCode: '3', serial: 104 }),
    depositRecord({ date: '20260915', serial: 13, ore: 20000, count: 2 }),
    opening(),
    payment({ ore: 75000, reference: '10041', serial: 105 }),
    name('Fjärde Kunden AB'),
    depositRecord({ date: '20260916', serial: 14, ore: 75000, count: 1 }),
    opening(),
    payment({ ore: 99900, serial: 106 }),
    depositRecord({ date: '20260930', serial: 15, ore: 99900, count: 1 }),
    end({ payments: 5, deductions: 1, extra: 1, deposits: 4 }),
  ].join('\r\n')
}

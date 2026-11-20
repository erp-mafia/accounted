/**
 * Synthetic Autogiro records, built field by field from the positions in
 * Bankgirot's "Bg Autogiro Teknisk manual" (november 2021). Every number here
 * is made up: bankgiro numbers carry a valid Luhn check digit and nothing
 * else.
 */
import { formatBankgiroNumber, luhnCheckDigit } from '@/lib/bankgiro/luhn'

const withCheck = (payload: string): string => `${payload}${luhnCheckDigit(payload)}`

/** The payee's bankgiro (fictional). */
export const PAYEE_BG_DIGITS = withCheck('991234')
export const PAYEE_BG = formatBankgiroNumber(PAYEE_BG_DIGITS)
/** A payer's bankgiro (fictional). */
export const PAYER_BG_DIGITS = withCheck('555044')
export const PAYER_BG = formatBankgiroNumber(PAYER_BG_DIGITS)
/** The payee's Kundnummer at Bankgirot (fictional). */
export const CUSTOMER_NUMBER = '123456'

export const zero = (value: string | number, width: number): string => String(value).padStart(width, '0')

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

/** A new-layout opening record (TK01) of a report, with its content label in 45-64. */
export function reportOpening(content: string, writtenOn = '20261030'): string {
  return record('01', [
    [3, 'AUTOGIRO'],
    [25, content === 'BET. SPEC & STOPP TK' ? `${writtenOn}101530000000` : writtenOn],
    [45, content],
    [65, CUSTOMER_NUMBER],
    [71, zero(PAYEE_BG_DIGITS, 10)],
  ])
}

export function file(records: string[]): string {
  return records.map((r) => `${r}\r\n`).join('')
}

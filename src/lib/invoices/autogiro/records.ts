/**
 * Fixed-width record primitives for Bankgirot's Autogiro files, shared by the
 * writer (files to Bankgirot) and the report parsers (files from Bankgirot).
 *
 * Source: Bankgirot, "Bg Autogiro Teknisk manual" (november 2021),
 * https://www.bankgirot.se/globalassets/dokument/tekniska-manualer/autogiro_tekniskmanual_sv.pdf
 * 6.1.3-6.1.4: every record is 80 positions, the transaction code (TK) in
 * positions 1-2; files are ISO 8859-1 with <CRLF> after each record. A
 * numeric field (N) is right-aligned and zero-filled, an alphanumeric field
 * (A) left-aligned and blank-filled. Positions in this folder are the
 * manual's (1-based, inclusive).
 */
import { formatBankgiroNumber, validateBankgiroNumber } from '@/lib/bankgiro/luhn'
import { roundOre } from '@/lib/money'

export const RECORD_LENGTH = 80
export const LINE_END = '\r\n'

/** Thrown when a value cannot be written into an Autogiro record; the message is Swedish and names the field. */
export class AutogiroFormatError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message)
    this.name = 'AutogiroFormatError'
  }
}

/** Characters `from`-`to` (the manual's 1-based inclusive positions). A trimmed line simply yields ''. */
export function field(line: string, from: number, to: number): string {
  return line.slice(from - 1, to)
}

/** A numeric field: digits only, right-aligned and zero-filled to `width`. */
export function numeric(value: string, width: number, name: string): string {
  if (!/^\d+$/.test(value)) throw new AutogiroFormatError(`${name} får bara innehålla siffror.`, name)
  if (value.length > width) throw new AutogiroFormatError(`${name} får vara högst ${width} siffror.`, name)
  return value.padStart(width, '0')
}

/**
 * An alphanumeric field, left-aligned and blank-filled to `width`. Only
 * characters ISO 8859-1 can carry are accepted, and among them only the
 * printable ones the seal knows (7-bit ASCII and åäöéü in both cases): any
 * other character would reach Bankgirot's seal as hex C3 and print as noise.
 */
export function alpha(value: string, width: number, name: string): string {
  if (value.length > width) throw new AutogiroFormatError(`${name} får vara högst ${width} tecken.`, name)
  if (!/^[\x20-\x7EåäöéüÅÄÖÉÜ]*$/.test(value)) {
    throw new AutogiroFormatError(`${name} innehåller ett tecken som Bankgirot inte tar emot.`, name)
  }
  return value.padEnd(width, ' ')
}

export function blank(width: number): string {
  return ' '.repeat(width)
}

/** Joins a record's fields and checks that it is exactly 80 positions; a mismatch is a bug in the caller. */
export function record(parts: string[]): string {
  const line = parts.join('')
  if (line.length !== RECORD_LENGTH) throw new Error(`Autogiro record is ${line.length} positions, not ${RECORD_LENGTH}: ${line}`)
  return line
}

/** YYYY-MM-DD as ÅÅÅÅMMDD; the date must exist. */
export function writeDate(iso: string, name: string): string {
  if (readDate(iso.replace(/-/g, '')) !== iso) throw new AutogiroFormatError(`${name} är inget giltigt datum (ÅÅÅÅ-MM-DD).`, name)
  return iso.replace(/-/g, '')
}

/** ÅÅÅÅMMDD as YYYY-MM-DD; null when it is not a real date. */
export function readDate(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d] = m
  const date = new Date(`${y}-${mo}-${d}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(d)) return null
  return `${y}-${mo}-${d}`
}

/** A positive SEK amount as whole öre for a 12-position amount field (the last two digits are öre). */
export function writeAmount(amount: number, name: string): string {
  if (!Number.isFinite(amount) || amount <= 0) throw new AutogiroFormatError(`${name} måste vara större än noll.`, name)
  // roundOre leaves the double nearest the two-decimal amount; times 100 it lies
  // within a few ulps of a whole number, so Math.round lands on the exact öre.
  return numeric(String(Math.round(roundOre(amount) * 100)), 12, name)
}

/** A zero-filled amount field as kronor; null when it is not digits. */
export function readAmount(value: string): number | null {
  const ore = readOre(value)
  return ore === null ? null : roundOre(ore / 100)
}

/** A zero-filled amount field as whole öre; null when it is not digits. */
export function readOre(value: string): number | null {
  const digits = value.trim()
  if (!/^\d+$/.test(digits)) return null
  return Number(digits)
}

/** A zero-filled number without its padding ('0' when it is all zeros); null when it is not digits. */
export function readNumber(value: string): string | null {
  const digits = value.trim()
  if (!/^\d+$/.test(digits)) return null
  return digits.replace(/^0+(?=\d)/, '')
}

/** A zero-filled giro number: formatted when it is a valid bankgiro, else its digits; null when empty or zero. */
export function readBankgiro(value: string): string | null {
  const digits = value.replace(/\D/g, '').replace(/^0+/, '')
  if (!digits) return null
  return validateBankgiroNumber(digits) ? formatBankgiroNumber(digits) : digits
}

/** The company's bankgiro for a 10-position field: it must carry a valid check digit. */
export function writeBankgiro(bankgiro: string, name: string): string {
  const digits = bankgiro.replace(/[-\s]/g, '')
  if (!validateBankgiroNumber(digits)) throw new AutogiroFormatError(`${name} är inget giltigt bankgironummer.`, name)
  return numeric(digits, 10, name)
}

export interface AutogiroBankAccount {
  /** Clearing number, 4 digits. */
  clearing: string
  /** Account number without the clearing, digits only. */
  number: string
}

/** A 16-position bank account field (clearing in the first 4, account right-aligned in the last 12); null when blank or zero. */
export function readBankAccount(value: string): AutogiroBankAccount | null {
  const digits = value.trim()
  if (!/^\d{16}$/.test(digits) || /^0+$/.test(digits)) return null
  return { clearing: digits.slice(0, 4), number: digits.slice(4).replace(/^0+(?=\d)/, '') }
}

/**
 * A 12-position personnummer or organisationsnummer field: a personnummer is
 * ÅÅÅÅMMDDNNNN, an organisationsnummer 00NNNNNNNNNN, or 99NNNNNNNNNN in a
 * mandate notice when the payer pays from its bankgiro. Returned as the 12
 * digits of a personnummer or the 10 of an organisationsnummer; null when blank.
 */
export function readIdentityNumber(value: string): string | null {
  const digits = value.trim()
  if (!/^\d{12}$/.test(digits) || /^0+$/.test(digits)) return null
  return digits.startsWith('00') || digits.startsWith('99') ? digits.slice(2) : digits
}

/** Free text: whitespace collapsed; null when blank. */
export function readText(value: string): string | null {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed : null
}

export interface NumberedRecord {
  /** 1-based line number in the file. */
  line: number
  text: string
}

/** The file's records with their line numbers: byte-order mark dropped, LF or CRLF, blank lines skipped. */
export function splitRecords(content: string): NumberedRecord[] {
  const out: NumberedRecord[] = []
  content
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((text, index) => {
      if (text.trim().length > 0) out.push({ line: index + 1, text })
    })
  return out
}

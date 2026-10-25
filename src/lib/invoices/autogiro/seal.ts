/**
 * Bankgirot's HMAC seal (förändringsskydd) for files to and from Bankgirot.
 *
 * Every file sent to Bankgirot must be tamper protected (Bg Autogiro Teknisk
 * manual, november 2021, chapter 4). This module implements the HMAC
 * SHA-256 method; a bank whose upload signs the file itself needs no seal.
 *
 * Source: Bankgirot, "Tamper protection with Bankgirot HMAC, Technical
 * Specification" (mars 2014),
 * https://www.bankgirot.se/globalassets/dokument/tekniska-manualer/hmac_tamperprotection_technicalmanual_en.pdf
 *
 * - The sealed file is a seal opening record (TK00: key date ÅÅMMDD and
 *   "HMAC"), the file's records, and a tamper protection record (TK99: key
 *   date, the key verification value KVV and the MAC).
 * - The MAC is HMAC-SHA256 with the 128-bit key, truncated to its first 128
 *   bits (RFC 4868), over the records from TK00 up to but not including TK99,
 *   without line endings, after normalisation: 7-bit ASCII hex 20-7E as is,
 *   ÉÄÖÅÜéäöåü as hex 40, 5B, 5C, 5D, 5E, 60, 7B, 7C, 7D, 7E, anything else as
 *   hex C3. Only the first 80 positions of TK00 count.
 * - The KVV is the MAC of the "standard file" 00000000 under the same key.
 *
 * The key lets whoever holds it send debits on the company's bankgiro: it is
 * a parameter here and never logged.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { AutogiroFormatError, LINE_END, RECORD_LENGTH, blank, record, splitRecords } from './records'

const SWEDISH_CHARACTERS: Record<string, number> = {
  É: 0x40,
  Ä: 0x5b,
  Ö: 0x5c,
  Å: 0x5d,
  Ü: 0x5e,
  é: 0x60,
  ä: 0x7b,
  ö: 0x7c,
  å: 0x7d,
  ü: 0x7e,
}

/** A seal key as Bankgirot hands it out: 32 hexadecimal digits (128 bits), returned upper-case. */
export function parseSealKey(input: string): string {
  const key = input.replace(/\s/g, '').toUpperCase()
  if (!/^[0-9A-F]{32}$/.test(key)) throw new AutogiroFormatError('Sigillnyckeln ska vara 32 hexadecimala tecken.', 'sigillnyckel')
  return key
}

/** The bytes the MAC is computed over: each character of `text` mapped to Bankgirot's normalised character set. */
export function normaliseForSeal(text: string): Buffer {
  const bytes = Buffer.alloc(text.length)
  let i = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    bytes[i++] = SWEDISH_CHARACTERS[ch] ?? (code >= 0x20 && code <= 0x7e ? code : 0xc3)
  }
  return bytes.subarray(0, i)
}

function mac(key: string, data: Buffer): string {
  return createHmac('sha256', Buffer.from(parseSealKey(key), 'hex')).update(data).digest().subarray(0, 16).toString('hex').toUpperCase()
}

/** The key verification value: the MAC of 00000000 under the key. Store it to check a re-entered key against. */
export function keyVerificationValue(key: string): string {
  return mac(key, Buffer.from('00000000', 'ascii'))
}

/** YYYY-MM-DD as the seal's key date ÅÅMMDD. */
function keyDate(iso: string): string {
  const m = /^\d{2}(\d{2})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) throw new AutogiroFormatError('Sigilldatum är inget giltigt datum (ÅÅÅÅ-MM-DD).', 'sigilldatum')
  return `${m[1]}${m[2]}${m[3]}`
}

/**
 * Seals a file to Bankgirot: puts TK00 before its records and TK99 after
 * them. `content` is the unsealed file as the writer made it; the result
 * ends every record with <CRLF>.
 */
export function sealAutogiroFile(content: string, key: string, sealedOn: string): string {
  const date = keyDate(sealedOn)
  const opening = record(['00', date, 'HMAC', blank(68)])
  const records = [opening, ...splitRecords(content).map((r) => r.text)]
  const data = Buffer.concat(records.map((r, index) => normaliseForSeal(index === 0 ? r.slice(0, RECORD_LENGTH) : r)))
  const protection = record(['99', date, keyVerificationValue(key), mac(key, data), blank(8)])
  return [...records, protection].map((r) => r + LINE_END).join('')
}

export type SealCheck =
  | { ok: true }
  | { ok: false; reason: 'not_sealed' | 'wrong_key' | 'tampered' }

/**
 * Checks a sealed file against a key. `wrong_key` when the file's KVV is not
 * the key's (the file was sealed with another key), `tampered` when the KVV
 * matches but the MAC does not (the content changed after sealing).
 */
export function verifyAutogiroSeal(content: string, key: string): SealCheck {
  const records = splitRecords(content).map((r) => r.text)
  const first = records[0]
  const last = records[records.length - 1]
  if (!first?.startsWith('00') || first.slice(8, 12) !== 'HMAC' || !last?.startsWith('99') || records.length < 2) {
    return { ok: false, reason: 'not_sealed' }
  }
  if (last.slice(8, 40).toUpperCase() !== keyVerificationValue(key)) return { ok: false, reason: 'wrong_key' }
  const data = Buffer.concat(records.slice(0, -1).map((r, index) => normaliseForSeal(index === 0 ? r.slice(0, RECORD_LENGTH) : r)))
  const expected = Buffer.from(mac(key, data), 'ascii')
  const actual = Buffer.from(last.slice(40, 72).toUpperCase(), 'ascii')
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? { ok: true } : { ok: false, reason: 'tampered' }
}

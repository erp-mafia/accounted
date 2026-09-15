import type { FieldKind } from './schemas'

/** One field as a model reading returned it. */
export interface Reading {
  value: string | number | null
  page: number | null
  quote: string | null
}

/** A region on a page in PDF points, top-left origin. */
export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** One field of a stored record. */
export interface ExtractedField {
  /** As printed, or as a person typed it. */
  value: string | number | null
  /** Canonical form for comparison and use: ISO date, number, ten-digit organisation number, collapsed text. */
  normalized: string | number | null
  /** The 1-based page the value stands on, checked against the page text. */
  page: number | null
  quote: string | null
  /** Where the quote stands on the page; null when the page has no word boxes. */
  bbox: Box | null
  /** 1 when both readings agree or a person decided; lower when a person should look. */
  confidence: number
  method: 'consensus' | 'single_reading' | 'human'
  /** What each model reading said, kept for review and audit. */
  readings: Reading[]
}

export type Payload = Record<string, ExtractedField>

const roundOre = (n: number) => Math.round(n * 100) / 100

/** Swedish organisation or personal identity number as ten digits; a 12-digit form drops its century. */
export function normalizeOrgNumber(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return digits
  if (digits.length === 12 && /^(16|19|20)/.test(digits)) return digits.slice(2)
  return null
}

/** The Luhn check digit over the first nine digits. */
export function isValidOrgNumber(digits: string): boolean {
  if (!/^\d{10}$/.test(digits)) return false
  const sum = [...digits.slice(0, 9)].reduce((acc, ch, i) => {
    const n = Number(ch) * (i % 2 === 0 ? 2 : 1)
    return acc + (n > 9 ? n - 9 : n)
  }, 0)
  return (10 - (sum % 10)) % 10 === Number(digits[9])
}

/** Amounts as printed in Swedish documents: spaces or dots between thousands, decimal comma, kr or :- suffix. */
export function normalizeAmount(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? roundOre(raw) : null
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .replace(/\s|kr|sek|:-|,-|%/gi, '')
    .replace(/\.(?=\d{3}(?!\d))/g, '')
    .replace(',', '.')
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? roundOre(Number(cleaned)) : null
}

const MONTHS: Record<string, number> = {
  januari: 1, februari: 2, mars: 3, april: 4, maj: 5, juni: 6, juli: 7, augusti: 8, september: 9, oktober: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12,
}

/** A calendar date as YYYY-MM-DD, or null when the parts do not form a real date. */
function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.toISOString().slice(0, 10)
}

/** ISO, compact (20260301), day first (1/3/2026, 01.03.2026) and Swedish month names (1 mars 2026). */
export function normalizeDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  let m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})(?:$|t)/)
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]))
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/)
  if (m) return isoDate(Number(m[3]), Number(m[2]), Number(m[1]))
  m = s.match(/^(\d{1,2})\s+([a-zåäö]+)\.?\s+(\d{4})$/)
  if (m && MONTHS[m[2]]) return isoDate(Number(m[3]), MONTHS[m[2]], Number(m[1]))
  return null
}

export function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const s = String(raw).replace(/\s+/g, ' ').trim()
  return s || null
}

export function normalizeValue(kind: FieldKind, raw: unknown): string | number | null {
  switch (kind) {
    case 'amount':
    case 'percent':
      return normalizeAmount(raw)
    case 'int': {
      const n = normalizeAmount(raw)
      return n != null && Number.isInteger(n) ? n : null
    }
    case 'date':
      return normalizeDate(raw)
    case 'orgnr':
      return normalizeOrgNumber(raw)
    case 'enum':
      return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null
    case 'text':
      return normalizeText(raw)
  }
}

const letters = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** Whether two normalized values say the same thing: numbers to the öre, text ignoring case and punctuation. */
export function valuesAgree(kind: FieldKind, a: string | number | null, b: string | number | null): boolean {
  if (a == null || b == null) return a == null && b == null
  if (kind === 'amount' || kind === 'percent' || kind === 'int') return Math.abs(Number(a) - Number(b)) < 0.005
  if (kind === 'text') return letters(String(a)) === letters(String(b))
  return String(a) === String(b)
}

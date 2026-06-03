/**
 * SCB Lönestrukturstatistik privat sektor (AM/SLP) and Svenskt Näringsliv
 * wage statistics — shared individual-level file (SCB-FS 2022:6 Bilaga 1).
 *
 * Both authorities use ONE postbeskrivning. The record is a fixed part
 * (position 1–70) followed by a variable part (71–300) of repeating
 * styrkod(3)+värde(7) pairs, up to 23 pairs. The same styrkoder (001, 051, …)
 * serve both authorities; the difference is a handful of SN-only fixed fields
 * (delägarnummer, arbetsplatsnummer, förbundsnummer, avtalskod) which are
 * zero-filled for the SCB variant.
 *
 * Värde rules (from the spec):
 *   - 7 digits, right-justified, zero-padded.
 *   - Styrkod 003/004 (veckoarbetstid): 2 implied decimals, no comma
 *     (38,50 → 0003850).
 *   - Styrkod 051 (lön): whole kronor for monthly/weekly (23 756 → 0023756);
 *     2 implied decimals for hourly (75,50 → 0007550).
 *   - Everything else: integer (heltal).
 *
 * CODE DOMAINS: personalkategori, arbetstidsart and löneform reference SCB's
 * separate "Instruktion" doc for their allowed values. We pass through the
 * codes captured on the employee; löneform/personalkategori are mapped with a
 * documented default and should be verified against the instruction.
 */

export type SlpVariant = 'scb' | 'sn'

/** SN-only organisation identifiers (membership codes). Empty for SCB. */
export interface SnOrgCodes {
  delagarnummer?: string
  arbetsplatsnummer?: string
  forbundsnummer?: string
  avtalskod?: string
  forbundsspecifikKod?: string
}

export interface SlpEmployeeInput {
  /** 12-digit personnummer (YYYYMMDDNNNN). */
  personnummer: string
  /** 'arbetare' | 'tjansteman' | null. */
  workerCategory: string | null
  /** 'monthly' | 'hourly'. */
  salaryType: string
  /** Yrkeskod SSYK 2012, up to 4 digits. */
  ssykCode: string | null
  /** Arbetsställets CFAR-nummer, up to 8 digits. */
  cfarNumber: string | null
  /** Arbetstidsart code (1 char). */
  arbetstidsart: string | null
  /** '1' tillsvidare | '2' visstid. */
  anstallningsform: string | null
  /** Överenskommen fast lön (månadslön i kr, eller timlön i kr). */
  agreedWage: number
  /** Totalt arbetad tid (timmar), styrkod 001. */
  workedHours: number
  /** Övertidstillägg (kr), styrkod 052. */
  overtimeSupplement: number
  /** Semesterdagar, styrkod 600. */
  vacationDays: number
}

export interface SlpMeta {
  /** Statistikår (YYYY), position 1–4. */
  year: number
  orgNumber: string | null
  variant: SlpVariant
  sn?: SnOrgCodes
}

// ── Fixed-width helpers ─────────────────────────────────────────────
/** Right-justified, zero-padded numeric of exactly `width` (digits only). */
function num(value: string | number | null | undefined, width: number): string {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits.slice(-width).padStart(width, '0')
}

/** Left-justified text, space-padded/truncated to `width`. */
function text(value: string | null | undefined, width: number): string {
  return (value ?? '').slice(0, width).padEnd(width, ' ')
}

/** Map löneform → SCB code (Instruktionen fält 5). Verify against the instruction. */
function loneformCode(salaryType: string): string {
  return salaryType === 'hourly' ? '2' : '1' // 1 = månadslön, 2 = timlön (assumed)
}

/** Map personalkategori → SCB code (Instruktionen fält 4). Verify against the instruction. */
function personalkategoriCode(workerCategory: string | null): string {
  if (workerCategory === 'arbetare') return '1'
  if (workerCategory === 'tjansteman') return '2'
  return '0'
}

/** 051 value: whole kronor for monthly, 2 implied decimals for hourly. */
function wageValue(wage: number, salaryType: string): string {
  const scaled = salaryType === 'hourly' ? Math.round(wage * 100) : Math.round(wage)
  return num(scaled, 7)
}

/** A styrkod+värde pair (3+7). */
function pair(code: string, value7: string): string {
  return code + value7
}

/**
 * Build one 300-char fixed record for an employee.
 */
export function buildSlpRecord(meta: SlpMeta, emp: SlpEmployeeInput): string {
  const sn = meta.sn ?? {}
  const isSn = meta.variant === 'sn'

  // Fixed part, positions 1–70.
  const fixed =
    num(meta.year, 4) +                                   // 1–4   Period
    (isSn ? num(sn.delagarnummer, 7) : num(0, 7)) +       // 5–11  Delägarnummer (SN)
    (isSn ? num(sn.arbetsplatsnummer, 3) : num(0, 3)) +   // 12–14 Arbetsplatsnummer (SN)
    num(meta.orgNumber, 10) +                             // 15–24 Organisationsnummer
    (isSn ? num(sn.forbundsnummer, 2) : num(0, 2)) +      // 25–26 Förbundsnummer (SN)
    (isSn ? text(sn.avtalskod, 3) : text('', 3)) +        // 27–29 Avtalskod (SN)
    num(emp.personnummer, 12) +                           // 30–41 Personnummer
    personalkategoriCode(emp.workerCategory) +            // 42    Personalkategori
    text(emp.arbetstidsart ?? '0', 1) +                   // 43    Arbetstidsart
    num(emp.ssykCode, 4) +                                // 44–47 Yrkeskod SSYK 2012
    (isSn ? num(sn.forbundsspecifikKod, 2) : num(0, 2)) + // 48–49 Förbundsspecifik kod (SN)
    loneformCode(emp.salaryType) +                        // 50    Löneform
    num(0, 5) +                                           // 51–55 Antal anställda per CFAR (nollutfyllnad SCB)
    num(emp.cfarNumber, 8) +                              // 56–63 CFAR-nummer
    '2' +                                                 // 64    Helglön (default Nej=2)
    num(0, 6)                                             // 65–70 Reserv

  // Variable part: styrkod+värde pairs we can populate.
  const pairs: string[] = [
    pair('051', wageValue(emp.agreedWage, emp.salaryType)),       // Överenskommen lön
    pair('001', num(Math.round(emp.workedHours), 7)),            // Totalt arbetad tid
    pair('052', num(Math.round(emp.overtimeSupplement), 7)),     // Övertidstillägg
    pair('600', num(Math.round(emp.vacationDays), 7)),           // Semesterdagar
    pair('700', num(emp.anstallningsform ?? '0', 7)),           // Anställningsform
  ]
  // Pad the variable part to position 300 (230 chars = 23 × 10).
  const variable = pairs.join('').padEnd(230, '0')

  return fixed + variable
}

export interface SlpResult {
  /** One line per employee, joined with newlines. */
  content: string
  recordCount: number
  /** Employees missing SSYK/CFAR/arbetstidsart — surfaced as a warning. */
  incompleteCount: number
}

export function buildSlpFile(meta: SlpMeta, employees: SlpEmployeeInput[]): SlpResult {
  let incompleteCount = 0
  const lines = employees.map(emp => {
    if (!emp.ssykCode || !emp.cfarNumber || !emp.arbetstidsart) incompleteCount += 1
    return buildSlpRecord(meta, emp)
  })
  return { content: lines.join('\n'), recordCount: lines.length, incompleteCount }
}

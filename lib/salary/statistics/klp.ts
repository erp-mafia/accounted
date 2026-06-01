/**
 * SCB KLP — Konjunkturstatistik, löner för privat sektor.
 *
 * Monthly survey delivered as a semicolon-separated .txt file of
 * `Variabelnamn;värde` lines (variable order is irrelevant per the spec). The
 * employees are split into three buckets:
 *   - At*  Timavlönade arbetare    (worker_category = 'arbetare', salary_type = 'hourly')
 *   - Am*  Månadsavlönade arbetare (worker_category = 'arbetare', salary_type = 'monthly')
 *   - Tm*  Tjänstemän              (worker_category = 'tjansteman')
 *
 * Format codes (Postbeskrivning KLP, v2 2018-12-05):
 *   S = positive integer or 0 (max 12 chars)   D = decimal, two decimals, comma
 *   A = date YYYYMMDD (or empty)                B = 1 (ja) / 2 (nej)
 *   P = YYYYMM                                  O = 10-digit org number
 *   F = free text
 *
 * DATA LIMITATIONS — gnubok does not yet track every KLP concept. These fields
 * are emitted as 0 / empty and need either new tracking or manual entry before
 * filing: övertidstimmar, retrolön (summa + datum), and rörliga tillägg
 * avseende tidigare perioder. `avtalade timmar` is derived from
 * MONTHLY_CONTRACT_HOURS × sysselsättningsgrad (an approximation).
 *
 * NOTE: the spec's field table prints the hourly variable as "AtTidLon", but
 * its own example file uses "AtTidpLon" (consistent with AmTidpLon). We follow
 * the example file.
 */

/** Assumed full-time monthly hours, used to derive `avtalade timmar`. */
export const MONTHLY_CONTRACT_HOURS = 172

export type KlpBucket = 'at' | 'am' | 'tm'

/** One employee's contribution for the payment month, pre-classified + costed. */
export interface KlpEmployeeRow {
  bucket: KlpBucket
  /** Hourly: utbetald lön (timlön). Monthly/tjänsteman: överenskommen månadslön. */
  baseWage: number
  /** Avtalade timmar (used by Am/Tm). */
  agreedHours: number
  /** Arbetade timmar. */
  workedHours: number
  /** Övertidstillägg (kr). */
  overtimeSupplement: number
  /** Övertidstimmar. */
  overtimeHours: number
  /** Rörliga tillägg (bonus, provision, OB) i kr. */
  variableSupplement: number
  /** Sjuklön (kr). */
  sickPay: number
  /** Andel av heltid (sysselsättningsgrad/100), för TmTrAntH. */
  fteShare: number
}

export interface KlpBucketAgg {
  count: number
  baseWage: number
  agreedHours: number
  workedHours: number
  overtimeSupplement: number
  overtimeHours: number
  variableSupplement: number
  sickPay: number
}

export interface KlpMeta {
  orgNumber: string | null
  /** YYYYMMDD — date the file was produced. */
  extractionDate: string
  system: string
  version: string
  year: number
  /** Payment month 1–12 (UtbManad). */
  month: number
}

export interface KlpRecord {
  meta: KlpMeta
  at: KlpBucketAgg
  am: KlpBucketAgg
  tm: KlpBucketAgg & { fte: number }
}

const r0 = (n: number) => Math.round(n)

function emptyAgg(): KlpBucketAgg {
  return {
    count: 0, baseWage: 0, agreedHours: 0, workedHours: 0,
    overtimeSupplement: 0, overtimeHours: 0, variableSupplement: 0, sickPay: 0,
  }
}

function addRow(agg: KlpBucketAgg, row: KlpEmployeeRow): void {
  agg.count += 1
  agg.baseWage += row.baseWage
  agg.agreedHours += row.agreedHours
  agg.workedHours += row.workedHours
  agg.overtimeSupplement += row.overtimeSupplement
  agg.overtimeHours += row.overtimeHours
  agg.variableSupplement += row.variableSupplement
  agg.sickPay += row.sickPay
}

export function buildKlp(meta: KlpMeta, rows: KlpEmployeeRow[]): KlpRecord {
  const at = emptyAgg()
  const am = emptyAgg()
  const tm = emptyAgg()
  let tmFte = 0

  for (const row of rows) {
    if (row.bucket === 'at') addRow(at, row)
    else if (row.bucket === 'am') addRow(am, row)
    else {
      addRow(tm, row)
      tmFte += row.fteShare
    }
  }

  return { meta, at, am, tm: { ...tm, fte: Math.round(tmFte * 100) / 100 } }
}

// ── Field formatters ────────────────────────────────────────────────
const fmtS = (n: number) => String(Math.max(0, r0(n)))
const fmtD = (n: number) => n.toFixed(2).replace('.', ',')
const fmtB = (present: boolean) => (present ? '1' : '2')
const fmtP = (year: number, month: number) => `${year}${String(month).padStart(2, '0')}`
const fmtO = (org: string | null) => (org ?? '').replace(/\D/g, '')

/** Render the KLP record as the semicolon-separated .txt file. */
export function klpToTxt(record: KlpRecord): string {
  const { meta, at, am, tm } = record
  const lines: Array<[string, string]> = [
    ['Datum', meta.extractionDate],
    ['System', meta.system],
    ['Version', meta.version],
    ['OrgNummer', fmtO(meta.orgNumber)],
    ['UtbManad', fmtP(meta.year, meta.month)],
    ['ATFinns', fmtB(at.count > 0)],
    ['AMFinns', fmtB(am.count > 0)],
    ['TMTFinns', fmtB(tm.count > 0)],

    // Timavlönade arbetare
    ['AtUtbLon', fmtS(at.baseWage)],
    ['AtOvtTlg', fmtS(at.overtimeSupplement)],
    ['AtArbTim', fmtS(at.workedHours)],
    ['AtOvtTim', fmtS(at.overtimeHours)],
    ['AtRetLonS', '0'],
    ['AtRetLonF', ''],
    ['AtRetLonT', ''],
    ['AtTidpLon', '0'],
    ['AtSjukLon', fmtS(at.sickPay)],
    ['AtAnt', fmtS(at.count)],

    // Månadsavlönade arbetare
    ['AmManLon', fmtS(am.baseWage)],
    ['AmAvtTim', fmtS(am.agreedHours)],
    ['AmRorLon', fmtS(am.variableSupplement)],
    ['AmOvtTlg', fmtS(am.overtimeSupplement)],
    ['AmArbTim', fmtS(am.workedHours)],
    ['AmOvtTim', fmtS(am.overtimeHours)],
    ['AmRetLonS', '0'],
    ['AmRetLonF', ''],
    ['AmRetLonT', ''],
    ['AmTidpLon', '0'],
    ['AmSjukLon', fmtS(am.sickPay)],
    ['AmAnt', fmtS(am.count)],

    // Tjänstemän
    ['TmTrAntH', fmtD(tm.fte)],
    ['TmTrManL', fmtS(tm.baseWage)],
    ['TmTAvtTi', fmtS(tm.agreedHours)],
    ['TmTrRorL', fmtS(tm.variableSupplement)],
    ['TmTOvTlg', fmtS(tm.overtimeSupplement)],
    ['TmTArbTi', fmtS(tm.workedHours)],
    ['TmTOvtTi', fmtS(tm.overtimeHours)],
    ['TmTRetLS', '0'],
    ['TmTRetLF', ''],
    ['TmTRetLT', ''],
    ['TmTTidpL', '0'],
    ['TmTSjukL', fmtS(tm.sickPay)],
    ['TmTAnt', fmtS(tm.count)],
  ]
  return lines.map(([k, v]) => `${k};${v}`).join('\n')
}

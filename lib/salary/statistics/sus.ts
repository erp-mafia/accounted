/**
 * SCB SuS — Sjukfrånvaro under sjuklöneperioden (datafilbeskrivning 2024-01-01).
 *
 * A fixed-position .txt file with one record per sjukfall (sick case) that
 * occurred during the collection month. Each record is 42 characters:
 *
 *   Position  Length  Field        Notes
 *   1–12      12      PeOrgNr      "16" + 10-digit organisationsnummer
 *   13–24     12      PersonNr     personnummer, 4-digit birth year (YYYYMMDDNNNN)
 *   25–32      8      SjukFrom     sjuklöneperiodens första dag (YYYYMMDD), or the
 *                                  month's first day if the case began earlier
 *   33–40      8      SjukTom      sjuklöneperiodens sista dag (YYYYMMDD), or the
 *                                  month's last day if it continues next month
 *   41–42      2      AntErsDagar  days with sjuklön incl. karens, ≤ 14, zero-padded
 *
 * If a case spans a month boundary it is split: each month's file carries the
 * days falling within that month. We approximate a "sjukfall" by grouping an
 * employee's sick days, bridging short gaps (weekends/non-scheduled days), and
 * clamping to the collection month. A 7-day lookback before the month lets us
 * detect cases that began in the previous month (SjukFrom → month's first day).
 *
 * Empty file: when there are no sick cases, SCB still wants a file containing
 * only the organisationsnummer (PeOrgNr).
 */

export interface SusSickDay {
  /** 12-digit personnummer. */
  personnummer: string
  /** Sick day, 'YYYY-MM-DD'. */
  date: string
}

export interface SusCase {
  personnummer: string
  /** 'YYYY-MM-DD'. */
  sjukFrom: string
  sjukTom: string
  /** Days with sjuklön incl. karens within the month (1–14). */
  ersDays: number
}

export interface SusMeta {
  orgNumber: string | null
}

const MS_PER_DAY = 86_400_000

/** Sjuklöneperioden spans at most 14 calendar days from illness onset. */
const SJUKLONEPERIOD_DAYS = 14

function dayNumber(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY)
}

function isoFromDayNumber(n: number): string {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10)
}

/**
 * Group raw sick days into sjukfall, clamped to [monthStart, monthEnd].
 * Consecutive days (and gaps up to `maxGapDays`, e.g. weekends) merge into one
 * case. Cases with no day inside the month are dropped.
 */
export function groupSickCases(
  days: SusSickDay[],
  monthStart: string,
  monthEnd: string,
  maxGapDays = 4,
): SusCase[] {
  const startNum = dayNumber(monthStart)
  const endNum = dayNumber(monthEnd)

  const byPerson = new Map<string, string[]>()
  for (const d of days) {
    const list = byPerson.get(d.personnummer) ?? []
    list.push(d.date)
    byPerson.set(d.personnummer, list)
  }

  const cases: SusCase[] = []
  for (const [personnummer, rawDates] of byPerson) {
    const dates = [...new Set(rawDates)].sort()
    let group: string[] = []

    const flush = () => {
      if (group.length === 0) return
      const caseStartNum = dayNumber(group[0])
      // The sjuklöneperiod ends 14 calendar days after onset; days beyond it are
      // not part of this period (they belong to sjukpenning, not sjuklön).
      const periodEndNum = caseStartNum + SJUKLONEPERIOD_DAYS - 1
      // Days that fall within BOTH the collection month and the 14-day period.
      const periodDays = group.filter(d => {
        const n = dayNumber(d)
        return n >= startNum && n <= endNum && n <= periodEndNum
      })
      if (periodDays.length === 0) { group = []; return }
      const caseEndNum = dayNumber(group[group.length - 1])
      const sjukFrom = caseStartNum < startNum ? monthStart : group[0]
      // SjukTom = sjuklöneperiodens sista dag: the period ends when the illness
      // ends or after 14 days, whichever comes first, clamped to the month.
      const sjukTomNum = Math.min(caseEndNum, periodEndNum, endNum)
      cases.push({
        personnummer,
        sjukFrom,
        sjukTom: isoFromDayNumber(sjukTomNum),
        ersDays: Math.min(SJUKLONEPERIOD_DAYS, periodDays.length),
      })
      group = []
    }

    for (const date of dates) {
      if (group.length === 0) {
        group.push(date)
        continue
      }
      const prev = dayNumber(group[group.length - 1])
      const cur = dayNumber(date)
      if (cur - prev <= maxGapDays + 1) {
        group.push(date)
      } else {
        flush()
        group.push(date)
      }
    }
    flush()
  }

  // Stable order: by personnummer then start date.
  cases.sort((a, b) => a.personnummer.localeCompare(b.personnummer) || a.sjukFrom.localeCompare(b.sjukFrom))
  return cases
}

function digits(value: string | null | undefined): string {
  return String(value ?? '').replace(/\D/g, '')
}

/** "16" + 10-digit organisationsnummer. */
export function formatPeOrgNr(orgNumber: string | null): string {
  return '16' + digits(orgNumber).slice(-10).padStart(10, '0')
}

const ymd = (isoDate: string) => isoDate.replace(/-/g, '')

/** One 42-char SuS record. */
export function buildSusRecord(meta: SusMeta, c: SusCase): string {
  const personNr = digits(c.personnummer).slice(-12).padStart(12, '0')
  const from = ymd(c.sjukFrom)
  const tom = ymd(c.sjukTom)
  const ers = String(Math.min(14, Math.max(0, Math.round(c.ersDays)))).padStart(2, '0')
  return formatPeOrgNr(meta.orgNumber) + personNr + from + tom + ers
}

export interface SusResult {
  content: string
  recordCount: number
}

export function buildSusFile(meta: SusMeta, cases: SusCase[]): SusResult {
  if (cases.length === 0) {
    // SCB requires a non-empty file: just the organisationsnummer.
    return { content: formatPeOrgNr(meta.orgNumber), recordCount: 0 }
  }
  return {
    content: cases.map(c => buildSusRecord(meta, c)).join('\n'),
    recordCount: cases.length,
  }
}

/**
 * Area c: kollektivavtal scenarios: OB and övertid premiums (amount forms
 * percent of timlön / månadslön-divisor / kr per hour, validity dates) and
 * agreement sick pay.
 *
 * The premium scenarios run against computePremiumLines
 * (shift-premium-engine.ts): each rule carries its `engine` encoding, the
 * shift_premium_rules rows a company would enter for it (one row per clock
 * window). The engine awards every worked minute to one rule (priority, then
 * rate per hour) and treats övertid as a window like OB: it does not know
 * which worked hours are beyond the schedule. A scenario that runs here
 * therefore runs under that window model, with the registered worked shift
 * being the overtime hours; one that needs the engine to tell ordinary from
 * overtime hours stays todo (AG-04, AG-16). The timlön paid for an overtime
 * hour (kind overtime_hourly_pay) is pay for the hour, not a premium rule:
 * it has no engine encoding and the runner compares the premium lines only.
 *
 * Every rate, window and date was checked against the agreement text; the
 * citation names the agreement, section and printed page, plus the line of
 * the plain-text extract (e.g. handels_da.txt:1395).
 *
 * Rounding: no agreement here prescribes one. The expectation rounds each
 * rate per hour to öre (the à-pris a payslip prints) and each line to öre.
 * The two karens comparisons (AG-13, AG-14) run today under the existing
 * sick_rate = annual_hourly convention, within a stated tolerance.
 */
import { roundOre } from '@/lib/money'
import type { ShiftPremiumItemType } from '@/types'
import type { SourceRef, Scenario } from './catalogue'
import { SRC } from './catalogue'
import { addDays, calendarDays, ceilHalfHours, datesBetween, overlapHours, weekday } from './formulas'
import { sickDay, type PayslipInputs } from './harness'

export type AmountForm = 'percent_of_hourly' | 'monthly_divisor' | 'kr_per_hour'

export interface AgreementRule {
  id: string
  kind: 'ob' | 'overtime_premium' | 'overtime_hourly_pay'
  label: string
  form: AmountForm
  /** Percent (50 = 50 %), divisor (480) or kronor per hour (26.79). */
  value: number
  /** For percent_of_hourly: how the timlön is derived. */
  hourlyBasis?: string
  /** Days and clock window as the agreement words them. */
  when: string
  validFrom?: string
  validTo?: string
  /** Agreement rounding of worked time, when it has one. */
  timeRounding?: 'started_half_hour'
  source: SourceRef
  /**
   * The rule as shift_premium_rules rows (computePremiumLines): one row per
   * clock window, the same form, value and validity. Absent on
   * overtime_hourly_pay (the hour's timlön is not a premium rule).
   */
  engine?: EngineEncoding
}

export interface EngineEncoding {
  itemType: ShiftPremiumItemType
  /** ISO weekdays (1 = Monday) and a window; an end at or before the start runs past midnight. */
  windows: Array<{ days: number[]; start: string; end: string }>
  /** Higher wins a minute; equal priority goes to the higher rate per hour. Default 0. */
  priority?: number
  /** percent_of_hourly: the agreement's timlön divisor of the full-time månadslön (numeric(7,2)). */
  hourlyDivisor?: number
}

const MON_FRI = [1, 2, 3, 4, 5]
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7]

export interface Shift {
  date: string
  start: string
  /** At or before start = runs past midnight. */
  end: string
  kind: 'ordinary' | 'overtime'
}

export interface PremiumInputs {
  agreement: string
  monthlySalary: number
  hoursPerWeek: number
  period: { start: string; end: string }
  shifts: Shift[]
  rules: AgreementRule[]
}

export interface PremiumLine {
  rule: string
  date: string
  hours: number
  ratePerHour: number
  amount: number
}

export interface PremiumExpected {
  lines: PremiumLine[]
  total: number
  /** Premiums the agreement says are NOT paid on these hours, so an engine that pays them is wrong. */
  notPaid: Array<{ rule: string; date: string; hours: number; reason: string }>
}

export interface SickTopUpInputs {
  agreement: string
  monthlySalary: number
  prisbasbelopp: number
  /** First day of the sjukperiod; day 15 onward is the agreement's. */
  firstSickDay: string
  /** The days of the pay period on day 15 or later (calendar days, weekends included). */
  from: string
  to: string
  employedAtLeastOneYear: boolean
}

export interface SickTopUpExpected {
  ceilingMonthly: number
  deductionPerDay: number
  fullCalendarDay: number
  topUpPerDay: number
  days: number
  totalDeduction: number
  totalTopUp: number
  /** Last calendar day of the sjukperiod the agreement pays sjuklön for. */
  lastSickPayDay: number
}

export interface KarensCompareInputs {
  payslip: PayslipInputs
  monthlySalary: number
  hoursPerWeek: number
  sickHours: number
}

export interface KarensCompareExpected {
  teknik: number
  almega: number
  /** Allowed engine deviation: the agreements do not say when to round; the engine rounds the timlön to öre first. */
  toleranceSek: number
}

export type AgreementScenario =
  | Scenario<'premium', PremiumInputs, PremiumExpected>
  | Scenario<'sick-topup', SickTopUpInputs, SickTopUpExpected>
  | Scenario<'karens-compare', KarensCompareInputs, KarensCompareExpected>

// ---------------------------------------------------------------------------
// Sources (agreement extracts)
// ---------------------------------------------------------------------------

const ALMEGA = 'Almega Tjänsteförbunden, Serviceföretagen Tjänstemannaavtalet 2025-04-01 to 2027-03-31'
const TEKNIK = 'Teknikavtalet Unionen/Sveriges Ingenjörer/Ledarna 2025-04-01 to 2027-03-31'
const HANDELS = 'Detaljhandelsavtalet Svensk Handel/Handels 2025-04-01 to 2027-03-31'
const GRONA = 'Gröna Riksavtalet Visita/HRF 2025-04-01 to 2027-03-31'
const BYGG = 'Byggavtalet Byggföretagen/Byggnads 2025-05-01 to 2027-04-30'

const S = {
  almegaOb: { kind: 'agreement', ref: ALMEGA, at: '§ 7.1 Förskjuten arbetstid; almega_service.txt:497-524', quote: 'Kvälls- och nattetid från kl 18 till kl 06: månadslönen/480; Sön- och helgdagstid från kl 06 lördag ...: månadslönen/300; Storhelgstid ... från kl 06 midsommarafton ...: månadslönen/150' },
  almegaNoOverlap: { kind: 'agreement', ref: ALMEGA, at: '§ 7.1; almega_service.txt:529', quote: 'Ersättning för förskjuten arbetstid och övertidsersättning kan ej utges samtidigt.' },
  almegaOvertime: { kind: 'agreement', ref: ALMEGA, at: '§ 5.3.2; almega_service.txt:393-424', quote: 'för övertidsarbete kl 06-20 helgfria måndagar-fredagar månadslönen/94; för övertidsarbete på annan tid månadslönen/72 ... divisorerna justerats så att de inbegriper semesterlön' },
  almegaSick15: { kind: 'agreement', ref: ALMEGA, at: '§ 10.3.6 and 10.3.7; almega_service.txt:1041-1100', quote: 'Lönegränsen ... 10 × pbb / 12 ... högst lönegränsen: 90 % × månadslönen × 12 / 365; över lönegränsen: 90 % × 10 × pbb / 365 + 10 % × (månadslönen × 12 − 10 × pbb) / 365' },
  almegaSickLength: { kind: 'agreement', ref: ALMEGA, at: '§ 10.4.1; almega_service.txt:1106-1118', quote: 'Sjuklön betalas t o m den 90:e kalenderdagen i sjukperioden till den som varit anställd minst ett år i följd (grupp 1) ... t o m den 45:e kalenderdagen ... till övriga (grupp 2).' },
  almegaKarens: { kind: 'agreement', ref: ALMEGA, at: '§ 10.3.2; almega_service.txt:982-1013', quote: 'För sjukfrånvaro upp till 20% av genomsnittlig veckoarbetstid (karens): månadslönen × 12 / (52 × veckoarbetstiden); överstigande 20 % till och med dag 14: 20 % × månadslönen × 12 / (52 × veckoarbetstiden)' },
  almegaCeiling2025: { kind: 'agreement', ref: ALMEGA, at: '§ 10.3.6 example; almega_service.txt:1049-1066', quote: '10 × 58 800 / 12 = 49 000 kr för år 2025' },
  teknikOb: { kind: 'agreement', ref: TEKNIK, at: 'Förskjuten arbetstid B punkt 4, p. 61-62; teknik_tjm.txt:2686-2717', quote: 'kl. 18 till 24: månadslönen/600; från kl. 00 till 07: månadslönen/400 ... Ersättning för förskjuten arbetstid och övertidsersättning kan ej utges samtidigt.' },
  teknikSick: { kind: 'agreement', ref: TEKNIK, at: '§ 6 mom 4:1, p. 21-22; teknik_tjm.txt:849-891', quote: 'löneavdrag för varje timme 100 % × månadslönen × 12 / (52 × veckoarbetstiden) ... Karensavdraget ska vara 20 procent av den genomsnittliga sjuklönen per vecka (80 % × månadslönen × 12 / 52) ... Om karensavdraget överstiger det löneavdrag ... ska sjuklönen vara 0 kronor.' },
  teknikSick15: { kind: 'agreement', ref: TEKNIK, at: '§ 6 mom 4:2, p. 22-23; teknik_tjm.txt:928-960', quote: 'högst 49 000 kronor: 90 % × månadslönen × 12 / 365; över: 80 % × 10 × prisbasbelopp / 365 + 10 % × månadslönen × 12 / 365 ... lönegränsen är 10 × gällande prisbasbelopp/12' },
  handelsOb: { kind: 'agreement', ref: HANDELS, at: '§ 8.1, p. 33; handels_da.txt:1389-1411', quote: 'måndag-fredag kl. 18.15 till 20.00: 50 %; måndag-fredag efter kl. 20.00: 70 % ... De procentuella tilläggen utges på timlönen beräknad som 1/166 av arbetstagarens utgående fasta kontanta månadslön' },
  handelsHighest: { kind: 'agreement', ref: HANDELS, at: '§ 8.1 Anmärkning and § 9.1 Anmärkning, p. 33-34; handels_da.txt:1409-1411, 1471-1473', quote: 'Om arbetstagare har rätt till övertidsersättning ... på tid då ob-ersättning ska betalas har arbetstagaren endast rätt till den procentuellt sett högsta ersättningen.' },
  handelsOvertime: { kind: 'agreement', ref: HANDELS, at: '§ 9.2, p. 34-35; handels_da.txt:1475-1522', quote: 'För övertidsarbete som utförs till och med den 31 mars 2026: 50 procent de första två timmarna per dag ... från och med den 1 april 2026: 35 procent de första två timmarna ... arbetstagarens personliga timlön samt kontant övertidsersättning' },
  gronaOb: { kind: 'agreement', ref: GRONA, at: '13 § punkt 1, p. 20; grona.txt:760-772', quote: 'Måndag t.o.m. fredag från kl 20.00 till kl 06.00 påföljande dag ... Fr.o.m. 2025-04-01 26:79 kr/timme, Fr.o.m. 2026-04-01 27:59 kr/timme. Varje påbörjad halvtimme betalas som full halvtimme.' },
  byggOb: { kind: 'agreement', ref: BYGG, at: '§ 2 punkt 5, p. 27; bygg.txt:972-994 (table verified in bygg.pdf)', quote: 'OB 2 = 40 % av utgående lön kl. 18.00 to 22.00 Mon-Fri ... OB-ersättning utges inte vid övertidsarbete ... (månadslönen x 12) / (52 x genomsnittlig veckoarbetstid)' },
  byggOvertime: { kind: 'agreement', ref: BYGG, at: '§ 2 punkt 6.1, p. 28-29; bygg.txt:1022-1062 (table verified in bygg.pdf)', quote: 'Mon-Fri: kl. 06-17 Övertid A 30 %, 17-19 Övertid B 50 %, 19-22 Övertid C 70 %, 22-05 Övertid D 100 % ... Arbetstagare ska erhålla timersättning för arbetade timmar samt övertidsersättning ... När övertidsersättning utges ska inte OB-ersättning utges.' },
} as const satisfies Record<string, SourceRef>

// ---------------------------------------------------------------------------
// Expected-side helpers
// ---------------------------------------------------------------------------

/** Guard: a scenario date on the wrong weekday would test the wrong window. */
function on(date: string, isoWeekday: number): string {
  if (weekday(date) !== isoWeekday) throw new Error(`${date} is not ISO weekday ${isoWeekday}`)
  return date
}

function rate(rule: AgreementRule, monthly: number, hourly?: number): number {
  switch (rule.form) {
    case 'monthly_divisor':
      return roundOre(monthly / rule.value)
    case 'kr_per_hour':
      return rule.value
    case 'percent_of_hourly':
      if (hourly === undefined) throw new Error(`${rule.id} needs a timlön`)
      return roundOre((hourly * rule.value) / 100)
  }
}

function line(rule: AgreementRule, date: string, hours: number, perHour: number): PremiumLine {
  return { rule: rule.id, date, hours, ratePerHour: perHour, amount: roundOre(hours * perHour) }
}

function premium(lines: PremiumLine[], notPaid: PremiumExpected['notPaid'] = []): PremiumExpected {
  return { lines, total: roundOre(lines.reduce((s, l) => s + l.amount, 0)), notPaid }
}

/** Midsommarafton: the Friday before midsommardagen, the Saturday between 20 and 26 June. */
function midsommarafton(year: number): string {
  const saturday = datesBetween(`${year}-06-20`, `${year}-06-26`).find((d) => weekday(d) === 6)
  if (!saturday) throw new Error('no midsommardag')
  return addDays(saturday, -1)
}

const OCT = { start: '2026-10-01', end: '2026-10-31' }
const MAR_APR = { start: '2026-03-16', end: '2026-04-15' }

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function agreementScenarios(): AgreementScenario[] {
  const list: AgreementScenario[] = []

  // Almega Serviceföretagen ---------------------------------------------------
  const almegaEvening: AgreementRule = {
    id: 'almega_ob_kvall_natt',
    kind: 'ob',
    label: 'Kvälls- och nattetid',
    form: 'monthly_divisor',
    value: 480,
    when: 'every day 18:00-06:00',
    source: S.almegaOb,
    engine: { itemType: 'ob_weekday_evening', windows: [{ days: EVERY_DAY, start: '18:00', end: '06:00' }] },
  }
  // Saturday 06:00 to Monday 06:00 as three windows. The day before a
  // holiday from 18:00 has no window form (holiday-eve windows are missing).
  const almegaWeekend: AgreementRule = {
    id: 'almega_ob_helg',
    kind: 'ob',
    label: 'Sön- och helgdagstid',
    form: 'monthly_divisor',
    value: 300,
    when: 'Saturday 06:00 to 06:00 after the Sunday or holiday; from 18:00 the day before a holiday',
    source: S.almegaOb,
    engine: {
      itemType: 'ob_weekend',
      windows: [
        { days: [6], start: '06:00', end: '00:00' },
        { days: [7], start: '00:00', end: '00:00' },
        { days: [1], start: '00:00', end: '06:00' },
      ],
    },
  }
  // ob_holiday fires on every Swedish holiday the engine knows (aftnar
  // included), from 06:00: it cannot tell a storhelg from an ordinary
  // helgdag, nor carry the night after midsommardagen to 06:00.
  const almegaStorhelg: AgreementRule = {
    id: 'almega_ob_storhelg',
    kind: 'ob',
    label: 'Storhelgstid',
    form: 'monthly_divisor',
    value: 150,
    when: 'midsommarafton 06:00 to 06:00 after midsommardagen (and the other storhelger listed)',
    source: S.almegaOb,
    engine: { itemType: 'ob_holiday', windows: [{ days: EVERY_DAY, start: '06:00', end: '00:00' }] },
  }
  const almegaOtDay: AgreementRule = { id: 'almega_ot_vardag', kind: 'overtime_premium', label: 'Övertid kl 06-20 helgfria mån-fre', form: 'monthly_divisor', value: 94, when: 'Mon-Fri 06:00-20:00, not holidays', source: S.almegaOvertime }
  const almegaOtOther: AgreementRule = { id: 'almega_ot_annan_tid', kind: 'overtime_premium', label: 'Övertid annan tid', form: 'monthly_divisor', value: 72, when: 'all other time', source: S.almegaOvertime }
  {
    const m = 36000
    const tue = on('2026-10-06', 2)
    list.push({
      id: 'AG-01',
      title: 'Almega: ordinary hours 16-22 on a Tuesday, four hours at månadslön / 480',
      area: 'agreement',
      status: 'runnable',
      kind: 'premium',
      inputs: { agreement: ALMEGA, monthlySalary: m, hoursPerWeek: 40, period: OCT, shifts: [{ date: tue, start: '16:00', end: '22:00', kind: 'ordinary' }], rules: [almegaEvening] },
      expected: premium([line(almegaEvening, tue, overlapHours('16:00', '22:00', '18:00', '24:00'), rate(almegaEvening, m))]),
      formula: 'Förskjuten arbetstid 18:00-22:00 = 4 h × (36 000 / 480).',
      sources: [S.almegaOb, SRC.obContractual],
    })
    const sat = on('2026-10-10', 6)
    list.push({
      id: 'AG-02',
      title: 'Almega: ordinary hours 10-16 on a Saturday, six hours at månadslön / 300',
      area: 'agreement',
      status: 'runnable',
      kind: 'premium',
      inputs: { agreement: ALMEGA, monthlySalary: m, hoursPerWeek: 40, period: OCT, shifts: [{ date: sat, start: '10:00', end: '16:00', kind: 'ordinary' }], rules: [almegaEvening, almegaWeekend] },
      expected: premium([line(almegaWeekend, sat, overlapHours('10:00', '16:00', '06:00', '24:00'), rate(almegaWeekend, m))]),
      formula: 'Sön- och helgdagstid runs from Saturday 06:00: 6 h × (36 000 / 300). The evening window does not touch 10-16.',
      sources: [S.almegaOb],
    })
    const afton = on(midsommarafton(2026), 5)
    list.push({
      id: 'AG-03',
      title: 'Almega: ordinary hours 10-16 on midsommarafton 2026, six hours at månadslön / 150',
      area: 'agreement',
      status: 'runnable',
      kind: 'premium',
      inputs: {
        agreement: ALMEGA,
        monthlySalary: m,
        hoursPerWeek: 40,
        period: { start: '2026-06-01', end: '2026-06-30' },
        shifts: [{ date: afton, start: '10:00', end: '16:00', kind: 'ordinary' }],
        rules: [almegaEvening, almegaWeekend, almegaStorhelg],
      },
      expected: premium([line(almegaStorhelg, afton, overlapHours('10:00', '16:00', '06:00', '24:00'), rate(almegaStorhelg, m))]),
      formula:
        `Storhelgstid from 06:00 on midsommarafton (${afton}): 6 h × (36 000 / 150); the highest band applies, not also /300 or /480. ` +
        'Engine: an ob_holiday rule, which fires on every holiday it knows (midsommarafton included), so it cannot tell storhelg from helgdag.',
      sources: [S.almegaOb],
    })
    const otDay = overlapHours('18:00', '22:00', '06:00', '20:00')
    const otOther = overlapHours('18:00', '22:00', '20:00', '24:00')
    list.push({
      id: 'AG-04',
      title: 'Almega: overtime 18-22 on a Tuesday pays /94 and /72, never the /480 OB on the same hours',
      area: 'agreement',
      status: 'todo',
      todoReason: 'needs overtime detection: Almega övertid /94 covers 06-20 on weekdays, the ordinary day, so no time window can carry it',
      kind: 'premium',
      inputs: { agreement: ALMEGA, monthlySalary: m, hoursPerWeek: 40, period: OCT, shifts: [{ date: tue, start: '18:00', end: '22:00', kind: 'overtime' }], rules: [almegaEvening, almegaOtDay, almegaOtOther] },
      expected: premium(
        [line(almegaOtDay, tue, otDay, rate(almegaOtDay, m)), line(almegaOtOther, tue, otOther, rate(almegaOtOther, m))],
        [{ rule: almegaEvening.id, date: tue, hours: otDay + otOther, reason: 'Ersättning för förskjuten arbetstid och övertidsersättning kan ej utges samtidigt.' }],
      ),
      formula:
        '18:00-20:00 = 2 h × (36 000 / 94); 20:00-22:00 = 2 h × (36 000 / 72). The divisors include semesterlön, so the overtime ' +
        'should not also be semesterlönegrundande (flag for the feature: is_vacation_basis false on these lines).',
      sources: [S.almegaOvertime, S.almegaNoOverlap],
    })
  }

  // Teknikavtalet --------------------------------------------------------------
  {
    const m = 36000
    const evening: AgreementRule = {
      id: 'teknik_ob_18_24',
      kind: 'ob',
      label: 'kl. 18 till 24',
      form: 'monthly_divisor',
      value: 600,
      when: 'working days 18:00-24:00',
      source: S.teknikOb,
      engine: { itemType: 'ob_weekday_evening', windows: [{ days: MON_FRI, start: '18:00', end: '00:00' }] },
    }
    const night: AgreementRule = {
      id: 'teknik_ob_00_07',
      kind: 'ob',
      label: 'kl. 00 till 07',
      form: 'monthly_divisor',
      value: 400,
      when: '00:00-07:00',
      source: S.teknikOb,
      engine: { itemType: 'ob_night', windows: [{ days: MON_FRI, start: '00:00', end: '07:00' }] },
    }
    const wed = on('2026-10-07', 3)
    const thu = addDays(wed, 1)
    list.push({
      id: 'AG-05',
      title: 'Teknik: a shift Wednesday 20:00 to Thursday 02:00 splits at midnight into /600 and /400',
      area: 'agreement',
      status: 'runnable',
      kind: 'premium',
      inputs: { agreement: TEKNIK, monthlySalary: m, hoursPerWeek: 40, period: OCT, shifts: [{ date: wed, start: '20:00', end: '02:00', kind: 'ordinary' }], rules: [evening, night] },
      expected: premium([
        line(evening, wed, overlapHours('20:00', '24:00', '18:00', '24:00'), rate(evening, m)),
        line(night, thu, overlapHours('00:00', '02:00', '00:00', '07:00'), rate(night, m)),
      ]),
      formula: '20:00-24:00 = 4 h × (36 000 / 600) on Wednesday; 00:00-02:00 = 2 h × (36 000 / 400) on Thursday.',
      sources: [S.teknikOb, SRC.obContractual],
    })
  }

  // Handels detaljhandel --------------------------------------------------------
  const handelsHourly = (m: number) => roundOre(m / 166)
  const hOb50: AgreementRule = {
    id: 'handels_ob_50',
    kind: 'ob',
    label: 'mån-fre 18.15 to 20.00',
    form: 'percent_of_hourly',
    value: 50,
    hourlyBasis: 'månadslön / 166',
    when: 'Mon-Fri 18:15-20:00',
    source: S.handelsOb,
    engine: { itemType: 'ob_weekday_evening', windows: [{ days: MON_FRI, start: '18:15', end: '20:00' }], hourlyDivisor: 166 },
  }
  const hOb70: AgreementRule = {
    id: 'handels_ob_70',
    kind: 'ob',
    label: 'mån-fre efter 20.00',
    form: 'percent_of_hourly',
    value: 70,
    hourlyBasis: 'månadslön / 166',
    when: 'Mon-Fri after 20:00',
    source: S.handelsOb,
    engine: { itemType: 'ob_weekday_evening', windows: [{ days: MON_FRI, start: '20:00', end: '00:00' }], hourlyDivisor: 166 },
  }
  const hOtPay: AgreementRule = { id: 'handels_ot_timlon', kind: 'overtime_hourly_pay', label: 'personlig timlön för övertidstimmen', form: 'percent_of_hourly', value: 100, hourlyBasis: 'månadslön / 166', when: 'every overtime hour', source: S.handelsOvertime }
  // "The first two overtime hours per day" is a count, not a clock window:
  // the engine encoding stands in with the window the scenario's overtime
  // falls in (06-08 and 17-19 on weekdays).
  const hOt50: AgreementRule = {
    id: 'handels_ot_50',
    kind: 'overtime_premium',
    label: 'de första två timmarna',
    form: 'percent_of_hourly',
    value: 50,
    hourlyBasis: 'månadslön / 166',
    when: 'first two overtime hours per day, before and after ordinary hours together',
    validTo: '2026-03-31',
    source: S.handelsOvertime,
    engine: {
      itemType: 'overtime_50',
      windows: [
        { days: MON_FRI, start: '06:00', end: '08:00' },
        { days: MON_FRI, start: '17:00', end: '19:00' },
      ],
      hourlyDivisor: 166,
    },
  }
  const hOt35: AgreementRule = { ...hOt50, id: 'handels_ot_35', value: 35, validFrom: '2026-04-01', validTo: undefined }
  {
    const m = 30000
    const t = handelsHourly(m)
    const tue = on('2026-10-06', 2)
    list.push({
      id: 'AG-06',
      title: 'Handels: ordinary hours 17-21 on a Tuesday, 18.15-20 at 50 % and 20-21 at 70 % of månadslön / 166',
      area: 'agreement',
      status: 'runnable',
      kind: 'premium',
      inputs: { agreement: HANDELS, monthlySalary: m, hoursPerWeek: 38.25, period: OCT, shifts: [{ date: tue, start: '17:00', end: '21:00', kind: 'ordinary' }], rules: [hOb50, hOb70] },
      expected: premium([
        line(hOb50, tue, overlapHours('17:00', '21:00', '18:15', '20:00'), rate(hOb50, m, t)),
        line(hOb70, tue, overlapHours('17:00', '21:00', '20:00', '24:00'), rate(hOb70, m, t)),
      ]),
      formula: 'Timlön = 30 000 / 166. 1,75 h × 50 % of it plus 1 h × 70 % of it.',
      sources: [S.handelsOb, SRC.obContractual],
    })
    const mon = on('2026-03-30', 1)
    const wed = on('2026-04-08', 3)
    const twoHours = overlapHours('06:00', '08:00', '06:00', '08:00')
    list.push({
      id: 'AG-07',
      title: 'Handels: the first-two-hours overtime premium steps from 50 % to 35 % on 1 April 2026 inside one pay period',
      area: 'agreement',
      status: 'runnable',
      kind: 'premium',
      inputs: {
        agreement: HANDELS,
        monthlySalary: m,
        hoursPerWeek: 38.25,
        period: MAR_APR,
        shifts: [
          { date: mon, start: '06:00', end: '08:00', kind: 'overtime' },
          { date: wed, start: '06:00', end: '08:00', kind: 'overtime' },
        ],
        rules: [hOtPay, hOt50, hOt35],
      },
      expected: premium([
        line(hOtPay, mon, twoHours, rate(hOtPay, m, t)),
        line(hOt50, mon, twoHours, rate(hOt50, m, t)),
        line(hOtPay, wed, twoHours, rate(hOtPay, m, t)),
        line(hOt35, wed, twoHours, rate(hOt35, m, t)),
      ]),
      formula:
        'Each overtime hour pays the personlig timlön (30 000 / 166) plus the premium valid on the day the work is done: ' +
        '50 % on 30 March (to 31 March 2026), 35 % on 8 April (from 1 April 2026). Morning overtime avoids every OB window. ' +
        'Engine: the premium rules split by validity date; the timlön line is pay for the hour, not compared.',
      sources: [S.handelsOvertime],
    })
    const thu = on('2026-04-09', 4)
    const before = overlapHours('17:00', '19:00', '17:00', '18:15')
    const inOb = overlapHours('17:00', '19:00', '18:15', '20:00')
    list.push({
      id: 'AG-08',
      title: 'Handels: overtime 17-19 on a Thursday; on 18.15-19 only the higher of overtime 35 % and OB 50 % is paid',
      area: 'agreement',
      status: 'runnable',
      kind: 'premium',
      inputs: { agreement: HANDELS, monthlySalary: m, hoursPerWeek: 38.25, period: MAR_APR, shifts: [{ date: thu, start: '17:00', end: '19:00', kind: 'overtime' }], rules: [hOtPay, hOt35, hOb50] },
      expected: premium(
        [
          line(hOtPay, thu, before + inOb, rate(hOtPay, m, t)),
          line(hOt35, thu, before, rate(hOt35, m, t)),
          // The 50 % OB rate is the higher one on 18.15-19.00; it is paid instead of, not on top of, the 35 %.
          line(hOb50, thu, inOb, rate(hOb50, m, t)),
        ],
        [{ rule: hOt35.id, date: thu, hours: inOb, reason: 'endast rätt till den procentuellt sett högsta ersättningen: 50 % replaces 35 % on 18.15-19.00, they are not added' }],
      ),
      formula:
        '2 h timlön; 17:00-18:15 premium 35 %; 18:15-19:00 falls in the 50 % OB window, so the premium is max(35 %, 50 %) = 50 %, never 85 %. ' +
        'Reading: the Anmärkning applies to overtime worked on OB time; confirm with the agreement parties if a customer disputes it. ' +
        'Engine: equal priority, so the higher rate per hour (OB 50 %) wins 18:15-19:00; the timlön line is not compared.',
      sources: [S.handelsHighest, S.handelsOvertime, S.handelsOb],
    })
  }

  // One Handels rule set for ordinary and overtime hours -------------------------
  {
    const m = 30000
    const t = handelsHourly(m)
    const tue = on('2026-04-07', 2)
    const thu = on('2026-04-09', 4)
    list.push({
      id: 'AG-16',
      title: 'Handels: one rule set prices Tuesday\'s ordinary 17-21 as OB only and Thursday\'s overtime 17-19 as overtime premium plus OB',
      area: 'agreement',
      status: 'todo',
      todoReason: 'needs overtime detection: the engine sees worked minutes, not ordinary versus overtime, so 35 % on 17-19 also hits ordinary hours',
      kind: 'premium',
      inputs: {
        agreement: HANDELS,
        monthlySalary: m,
        hoursPerWeek: 38.25,
        period: MAR_APR,
        shifts: [
          { date: tue, start: '17:00', end: '21:00', kind: 'ordinary' },
          { date: thu, start: '17:00', end: '19:00', kind: 'overtime' },
        ],
        rules: [hOb50, hOb70, hOt35],
      },
      expected: premium(
        [
          line(hOb50, tue, overlapHours('17:00', '21:00', '18:15', '20:00'), rate(hOb50, m, t)),
          line(hOb70, tue, overlapHours('17:00', '21:00', '20:00', '24:00'), rate(hOb70, m, t)),
          line(hOt35, thu, overlapHours('17:00', '19:00', '17:00', '18:15'), rate(hOt35, m, t)),
          line(hOb50, thu, overlapHours('17:00', '19:00', '18:15', '20:00'), rate(hOb50, m, t)),
        ],
        [{ rule: hOt35.id, date: tue, hours: overlapHours('17:00', '21:00', '17:00', '18:15'), reason: 'ordinary hours carry no övertid premium' }],
      ),
      formula: 'AG-06 and AG-08 in one company and one period: the same clock time is OB-only when ordinary and premium-bearing when overtime.',
      sources: [S.handelsOb, S.handelsOvertime, S.handelsHighest],
    })
  }

  // Gröna Riks (Visita/HRF) ------------------------------------------------------
  {
    // Only the weekday window is encoded: the scenarios work Monday to Friday.
    const ob2025: AgreementRule = {
      id: 'grona_ob_2025',
      kind: 'ob',
      label: 'Ordinarie OB',
      form: 'kr_per_hour',
      value: 26.79,
      when: 'Mon-Fri 20:00-06:00, Sat and aftnar from 16:00, Sun and holidays 06:00-06:00',
      validFrom: '2025-04-01',
      validTo: '2026-03-31',
      timeRounding: 'started_half_hour',
      source: S.gronaOb,
      engine: { itemType: 'ob_night', windows: [{ days: MON_FRI, start: '20:00', end: '06:00' }] },
    }
    const ob2026: AgreementRule = { ...ob2025, id: 'grona_ob_2026', value: 27.59, validFrom: '2026-04-01', validTo: undefined }
    const mon = on('2026-03-30', 1)
    const wed = on('2026-04-08', 3)
    const marchHours = ceilHalfHours(overlapHours('18:00', '23:00', '20:00', '24:00'))
    const aprilHours = ceilHalfHours(overlapHours('19:00', '22:20', '20:00', '24:00'))
    list.push({
      id: 'AG-09',
      title: 'Gröna Riks: OB 26,79 kr/h until 31 March, 27,59 kr/h from 1 April 2026, started half hours paid in full',
      area: 'agreement',
      status: 'todo',
      todoReason: 'no time rounding on premium rules: a started half hour (22:00-22:20) is not paid as a full half hour',
      kind: 'premium',
      inputs: {
        agreement: GRONA,
        monthlySalary: 27000,
        hoursPerWeek: 40,
        period: MAR_APR,
        shifts: [
          { date: mon, start: '18:00', end: '23:00', kind: 'ordinary' },
          { date: wed, start: '19:00', end: '22:20', kind: 'ordinary' },
        ],
        rules: [ob2025, ob2026],
      },
      expected: premium([line(ob2025, mon, marchHours, ob2025.value), line(ob2026, wed, aprilHours, ob2026.value)]),
      formula:
        '30 March: 20:00-23:00 = 3 h × 26,79. 8 April: 20:00-22:20 = 2 h 20 min, a started half hour counts in full, so 2,5 h × 27,59. ' +
        'The rate follows the date the hours are worked, not the payment date.',
      sources: [S.gronaOb, SRC.obContractual],
    })
    // The rate step alone, on whole hours (AG-09 keeps the half-hour rounding).
    const aprilWhole = overlapHours('19:00', '22:00', '20:00', '24:00')
    list.push({
      id: 'AG-15',
      title: 'Gröna Riks: OB 26,79 kr/h on 30 March and 27,59 kr/h on 8 April 2026, one pay period, whole hours',
      area: 'agreement',
      status: 'runnable',
      kind: 'premium',
      inputs: {
        agreement: GRONA,
        monthlySalary: 27000,
        hoursPerWeek: 40,
        period: MAR_APR,
        shifts: [
          { date: mon, start: '18:00', end: '23:00', kind: 'ordinary' },
          { date: wed, start: '19:00', end: '22:00', kind: 'ordinary' },
        ],
        rules: [ob2025, ob2026],
      },
      expected: premium([line(ob2025, mon, marchHours, ob2025.value), line(ob2026, wed, aprilWhole, ob2026.value)]),
      formula: '30 March: 20:00-23:00 = 3 h × 26,79. 8 April: 20:00-22:00 = 2 h × 27,59. The rate follows the date the hours are worked.',
      sources: [S.gronaOb, SRC.obContractual],
    })
    // PROCESS.md P5: the agreement ran out and no successor was entered.
    list.push({
      id: 'AG-17',
      title: 'Gröna Riks: an OB rule valid to 31 March 2026 with no successor pays 30 March and nothing on 8 April',
      area: 'agreement',
      status: 'runnable',
      kind: 'premium',
      inputs: {
        agreement: GRONA,
        monthlySalary: 27000,
        hoursPerWeek: 40,
        period: MAR_APR,
        shifts: [
          { date: mon, start: '18:00', end: '23:00', kind: 'ordinary' },
          { date: wed, start: '19:00', end: '22:00', kind: 'ordinary' },
        ],
        rules: [ob2025],
      },
      expected: premium(
        [line(ob2025, mon, marchHours, ob2025.value)],
        [{ rule: ob2025.id, date: wed, hours: aprilWhole, reason: 'the rule ended 31 March; the old rate is not carried forward' }],
      ),
      formula: '30 March: 3 h × 26,79 under the rule; 8 April falls after valid_to, so the expired rule pays nothing (no silent carry-forward).',
      sources: [S.gronaOb],
    })
  }

  // Byggavtalet --------------------------------------------------------------
  {
    const m = 36000
    const hourly = roundOre((m * 12) / (52 * 40))
    // Timlön = månadslön × 12 / (52 × 40) = månadslön / 173,33 (2080 / 12 at
    // the two decimals hourly_divisor holds). "No OB on overtime" is the
    // övertid rules at a higher priority than OB 2 on the same window.
    const byggDivisor = roundOre((52 * 40) / 12)
    const pay: AgreementRule = { id: 'bygg_timersattning', kind: 'overtime_hourly_pay', label: 'timersättning för arbetade timmar', form: 'percent_of_hourly', value: 100, hourlyBasis: 'månadslön × 12 / (52 × veckoarbetstid)', when: 'every overtime hour', source: S.byggOvertime }
    const otB: AgreementRule = {
      id: 'bygg_ot_b',
      kind: 'overtime_premium',
      label: 'Övertid B',
      form: 'percent_of_hourly',
      value: 50,
      hourlyBasis: pay.hourlyBasis,
      when: 'Mon-Fri 17:00-19:00 and 05:00-06:00',
      source: S.byggOvertime,
      engine: {
        itemType: 'overtime_50',
        windows: [
          { days: MON_FRI, start: '17:00', end: '19:00' },
          { days: MON_FRI, start: '05:00', end: '06:00' },
        ],
        priority: 10,
        hourlyDivisor: byggDivisor,
      },
    }
    const otC: AgreementRule = {
      id: 'bygg_ot_c',
      kind: 'overtime_premium',
      label: 'Övertid C',
      form: 'percent_of_hourly',
      value: 70,
      hourlyBasis: pay.hourlyBasis,
      when: 'Mon-Fri 19:00-22:00',
      source: S.byggOvertime,
      engine: { itemType: 'overtime_50', windows: [{ days: MON_FRI, start: '19:00', end: '22:00' }], priority: 10, hourlyDivisor: byggDivisor },
    }
    const ob2: AgreementRule = {
      id: 'bygg_ob_2',
      kind: 'ob',
      label: 'OB 2',
      form: 'percent_of_hourly',
      value: 40,
      hourlyBasis: pay.hourlyBasis,
      when: 'Mon-Fri 18:00-22:00',
      source: S.byggOb,
      engine: { itemType: 'ob_weekday_evening', windows: [{ days: MON_FRI, start: '18:00', end: '22:00' }], hourlyDivisor: byggDivisor },
    }
    const tue = on('2026-10-06', 2)
    const hB = overlapHours('17:00', '21:00', '17:00', '19:00')
    const hC = overlapHours('17:00', '21:00', '19:00', '22:00')
    list.push({
      id: 'AG-10',
      title: 'Bygg: overtime 17-21 on a Tuesday pays Övertid B and C; no OB 2 on the overtime hours',
      area: 'agreement',
      status: 'runnable',
      kind: 'premium',
      inputs: { agreement: BYGG, monthlySalary: m, hoursPerWeek: 40, period: OCT, shifts: [{ date: tue, start: '17:00', end: '21:00', kind: 'overtime' }], rules: [pay, otB, otC, ob2] },
      expected: premium(
        [line(pay, tue, hB + hC, rate(pay, m, hourly)), line(otB, tue, hB, rate(otB, m, hourly)), line(otC, tue, hC, rate(otC, m, hourly))],
        [{ rule: ob2.id, date: tue, hours: overlapHours('17:00', '21:00', '18:00', '22:00'), reason: 'OB-ersättning utges inte vid övertidsarbete.' }],
      ),
      formula:
        'Timlön = 36 000 × 12 / (52 × 40). 4 h timersättning; 17-19 = 2 h × 50 %; 19-21 = 2 h × 70 %. OB 2 (40 %, 18-22) is not paid on overtime. ' +
        'Engine: övertid B and C outrank OB 2 by priority on every weekday minute 17-22; the timersättning line is not compared.',
      sources: [S.byggOvertime, S.byggOb],
    })
  }

  // Agreement sick pay from day 15 --------------------------------------------------
  {
    const pbb = 59200
    const ceiling = roundOre((10 * pbb) / 12)
    const almegaDeduction = (m: number) =>
      m <= ceiling ? roundOre((0.9 * m * 12) / 365) : roundOre((0.9 * 10 * pbb) / 365 + (0.1 * (m * 12 - 10 * pbb)) / 365)
    const teknikDeduction = (m: number) => (m <= ceiling ? roundOre((0.9 * m * 12) / 365) : roundOre((0.8 * 10 * pbb) / 365 + (0.1 * m * 12) / 365))
    const first = '2026-09-21'
    const from = addDays(first, 14)
    const to = '2026-10-16'
    const days = calendarDays(from, to)
    for (const [id, m] of [
      ['AG-11', 36000],
      ['AG-12', 60000],
    ] as const) {
      const deductionPerDay = almegaDeduction(m)
      const fullCalendarDay = roundOre((m * 12) / 365)
      const topUpPerDay = roundOre(fullCalendarDay - deductionPerDay)
      list.push({
        id,
        title: `Almega sick day 15-90 at ${m} kr (${m <= ceiling ? 'below' : 'above'} the 10 pbb / 12 ceiling): the employer tops up Försäkringskassan`,
        area: 'agreement',
        status: 'todo',
        todoReason: 'no agreement sjuklön from day 15: the engine deducts sick day 15+ in full and pays no top-up to day 90',
        kind: 'sick-topup',
        inputs: { agreement: ALMEGA, monthlySalary: m, prisbasbelopp: pbb, firstSickDay: first, from, to, employedAtLeastOneYear: true },
        expected: {
          ceilingMonthly: ceiling,
          deductionPerDay,
          fullCalendarDay,
          topUpPerDay,
          days,
          totalDeduction: roundOre(days * deductionPerDay),
          totalTopUp: roundOre(days * topUpPerDay),
          lastSickPayDay: 90,
        },
        formula:
          m <= ceiling
            ? 'Up to the ceiling (10 × 59 200 / 12): sjukavdrag per calendar day = 90 % × månadslön × 12 / 365, so 10 % of the day stays paid.'
            : 'Above the ceiling: sjukavdrag per calendar day = 90 % × 10 × pbb / 365 + 10 % × (månadslön × 12 − 10 × pbb) / 365; never more than månadslön × 12 / 365 (10.3.7).',
        sources: [S.almegaSick15, S.almegaSickLength, SRC.pbb2026, S.teknikSick15],
        anchors: [
          { label: 'Almega 2025 example: ceiling 10 × 58 800 / 12 = 49 000 kr', computed: roundOre((10 * 58800) / 12), published: 49000, tolerance: 0 },
          { label: 'Teknik mom 4:2 gives the same deduction per day (equivalent formulas)', computed: deductionPerDay, published: teknikDeduction(m), tolerance: 0.01 },
        ],
      })
    }
  }

  // Karens: Teknik in money vs Almega in hours (runnable today) --------------------
  {
    const m = 36000
    const w = 40
    const t = (m * 12) / (52 * w)
    const teknik = (h: number) => roundOre(h * t - 0.8 * h * t + Math.min(0.2 * 0.8 * ((m * 12) / 52), 0.8 * h * t))
    const almega = (h: number) => roundOre(Math.min(h, 0.2 * w) * t + Math.max(0, h - 0.2 * w) * 0.2 * t)
    const employee = {
      salaryType: 'monthly' as const,
      monthlySalary: m,
      personnummer: '198811020000',
      taxTable: 33,
      vacationRule: 'procentregeln' as const,
      employmentStart: '2019-03-01',
    }
    const period = { start: '2026-10-01', end: '2026-10-31', paymentDate: '2026-10-23' }
    const threeDays = ['2026-10-06', '2026-10-07', '2026-10-08'].map((d) => sickDay(d))
    list.push({
      id: 'AG-13',
      title: 'Karens three full days: Teknik (20 % of a week\'s sjuklön in money) equals Almega (first 20 % of the week in hours), and the engine matches',
      area: 'agreement',
      status: 'runnable',
      kind: 'karens-compare',
      inputs: { payslip: { employee, period, policy: { sick_rate: 'annual_hourly' }, absence: { periodDays: threeDays } }, monthlySalary: m, hoursPerWeek: w, sickHours: 24 },
      expected: { teknik: teknik(24), almega: almega(24), toleranceSek: 0.1 },
      formula:
        'T = månadslön × 12 / (52 × 40). Teknik: 24 h × T − 24 h × 80 % × T + min(20 % × 80 % × månadslön × 12 / 52, sjuklön). ' +
        'Almega: 8 h × T + 16 h × 20 % × T. Both are 11,2 × T; the engine (sick_rate = annual_hourly) rounds T to öre first.',
      sources: [S.teknikSick, S.almegaKarens, SRC.convSickAnnualHourly],
    })
    list.push({
      id: 'AG-14',
      title: 'Karens for a half day (4 h): the karensavdrag is capped at the sjuklön, so the day costs 4 h of pay under both agreements',
      area: 'agreement',
      status: 'runnable',
      kind: 'karens-compare',
      inputs: { payslip: { employee, period, policy: { sick_rate: 'annual_hourly' }, absence: { periodDays: [sickDay('2026-10-06', 4)] } }, monthlySalary: m, hoursPerWeek: w, sickHours: 4 },
      expected: { teknik: teknik(4), almega: almega(4), toleranceSek: 0.1 },
      formula: 'Teknik: 4 h × T less 4 h × 80 % × T plus a karensavdrag capped at that sjuklön ("sjuklönen ska vara 0 kronor"); Almega: 4 h within the first 20 % at full T.',
      sources: [S.teknikSick, S.almegaKarens, SRC.sickKarens],
    })
  }

  return list
}

export const AGREEMENT_SCENARIOS: AgreementScenario[] = agreementScenarios()

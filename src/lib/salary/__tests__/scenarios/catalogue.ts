/**
 * Payroll scenario catalogue: shared types and the source registry.
 *
 * Every scenario names its inputs, the figures the law, the agreement or the
 * documented company convention says it must produce, the formula in words
 * and where the formula comes from. Expected figures are computed in code
 * from the cited formula (formulas.ts), never by calling the engine helper
 * under test and never typed in from mental arithmetic.
 *
 * Status:
 *   - runnable: runs against the engine today and must pass.
 *   - engine-bug: runs today and is expected to fail (it.fails); the note
 *     says what the engine does instead and why the scenario believes the
 *     source. Fixing the engine turns the it.fails red, which is the signal
 *     to flip the status to runnable.
 *   - todo: the engine lacks a capability the scenario needs (it.todo); the
 *     expected data is complete, and todoReason names the missing capability
 *     in one line, so the feature that adds it can turn it runnable.
 *
 * Source extracts: agreement and statute citations give the document, the
 * section and the printed page, plus the line in the plain-text extract the
 * catalogue was verified against (e.g. handels_da.txt:1395), so a reviewer
 * can find the exact sentence.
 */

export type ScenarioArea = 'law-baseline' | 'vacation-liability' | 'agreement'

export type ScenarioStatus = 'runnable' | 'engine-bug' | 'todo'

export type SourceKind = 'statute' | 'skill' | 'agreement' | 'standard' | 'url' | 'convention'

export interface SourceRef {
  kind: SourceKind
  /** Document or file: 'Semesterlagen (1977:480) 16 a §', '.claude/skills/swedish-payroll/references/sick-pay.md'. */
  ref: string
  /** Lines, section or page inside the document. */
  at?: string
  /** The load-bearing words, verbatim from the source. */
  quote?: string
}

export interface Scenario<Kind extends string = string, Inputs = unknown, Expected = unknown> {
  id: string
  title: string
  area: ScenarioArea
  status: ScenarioStatus
  /** Which runner executes the scenario (the test files switch on it). */
  kind: Kind
  inputs: Inputs
  expected: Expected
  /** The formula in words, including the rounding convention. */
  formula: string
  sources: SourceRef[]
  /** Required for engine-bug: what the engine does instead. Optional otherwise. */
  note?: string
  /** Required for todo: the capability the engine lacks, in one line (shown in the test name). */
  todoReason?: string
  /**
   * Published worked examples the cited formula must reproduce: the
   * catalogue test checks |computed - published| <= tolerance, which pins
   * the formula (not the engine) to the source.
   */
  anchors?: Array<{ label: string; computed: number; published: number; tolerance: number }>
}

// ---------------------------------------------------------------------------
// Source registry: one place per citation, reused by the data files.
// ---------------------------------------------------------------------------

const SKILL = '.claude/skills/swedish-payroll/references'

export const SRC = {
  // Semesterlagen (1977:480), text extract sem.txt (riksdagen.se).
  seml3: { kind: 'statute', ref: 'Semesterlagen (1977:480) 3 §', at: 'sem.txt:57-60', quote: 'Med semesterår avses tiden från och med den 1 april ett år till och med den 31 mars påföljande år.' },
  seml7: { kind: 'statute', ref: 'Semesterlagen (1977:480) 7 §', at: 'sem.txt:107-117', quote: 'Kvoten multipliceras med tjugofem. Om ett brutet tal då uppstår, avrundas detta till närmast högre hela tal.' },
  seml12a: { kind: 'statute', ref: 'Semesterlagen (1977:480) 12 a §', at: 'sem.txt:203' },
  seml16: { kind: 'statute', ref: 'Semesterlagen (1977:480) 16 §', at: 'sem.txt:264-290' },
  seml16a: { kind: 'statute', ref: 'Semesterlagen (1977:480) 16 a § andra stycket', at: 'sem.txt:298-300', quote: 'Semestertillägget för varje betald semesterdag är ... för månadsavlönade arbetstagare 0,43 procent av månadslönen.' },
  seml16a1: { kind: 'statute', ref: 'Semesterlagen (1977:480) 16 a § första stycket', at: 'sem.txt:294-296', quote: 'den vid semestertillfället aktuella vecko- eller månadslönen' },
  seml16b: { kind: 'statute', ref: 'Semesterlagen (1977:480) 16 b § första stycket', at: 'sem.txt:311-313', quote: 'Semesterlön enligt procentregeln utgör tolv procent av arbetstagarens förfallna lön i en anställning under intjänandeåret.' },
  seml16b2: { kind: 'statute', ref: 'Semesterlagen (1977:480) 16 b § andra stycket 1-2', at: 'sem.txt:315-320', quote: 'I lönesumman ska inte följande inräknas: 1. semesterlön, 2. ersättning för dag då arbetstagaren ... haft semesterlönegrundande frånvaro' },
  seml16b3: { kind: 'statute', ref: 'Semesterlagen (1977:480) 16 b § tredje stycket', at: 'sem.txt:326-331', quote: 'ökas i stället lönesumman med ett belopp motsvarande den inkomst arbetstagaren skulle ha haft' },
  seml17: { kind: 'statute', ref: 'Semesterlagen (1977:480) 17 §', at: 'sem.txt:338-342', quote: 'semesterlönegrundande när det gäller ledighet på grund av sjukdom, om frånvaron under intjänandeåret inte överstiger 180 dagar' },
  seml17a1: { kind: 'statute', ref: 'Semesterlagen (1977:480) 17 a § första stycket 1', at: 'sem.txt:353-355', quote: 'om frånvaron under intjänandeåret inte överstiger 120 dagar' },
  seml17a3: { kind: 'statute', ref: 'Semesterlagen (1977:480) 17 a § första stycket 3', at: 'sem.txt:360-364', quote: 'om frånvaron för varje barn ... sammanlagt inte överstiger 120 dagar' },
  seml18: { kind: 'statute', ref: 'Semesterlagen (1977:480) 18 §', at: 'sem.txt:406-416', quote: 'mer än tjugo semesterdagar med lön, får spara en eller flera sådana överskjutande dagar' },
  seml22: { kind: 'statute', ref: 'Semesterlagen (1977:480) 22 §', at: 'sem.txt:452-455', quote: 'Samtliga sparade semesterdagar som läggs ut ska betraktas som intjänade under det närmast föregående intjänandeåret.' },
  seml28: { kind: 'statute', ref: 'Semesterlagen (1977:480) 28 §', at: 'sem.txt:496-499', quote: 'Om anställningen upphör innan arbetstagaren har fått den semesterlön som tjänats in, ska arbetstagaren i stället få semesterersättning.' },
  seml29: { kind: 'statute', ref: 'Semesterlagen (1977:480) 29 §', at: 'sem.txt:517-518', quote: 'Semesterersättning bestäms enligt grunderna för beräkning av semesterlön.' },

  // swedish-payroll skill references (the worktree copy).
  sickKarens: { kind: 'skill', ref: `${SKILL}/sick-pay.md`, at: '7-17', quote: 'karensavdrag = weekly_sjuklön × 0.20; For a 30,000 SEK/month employee at 40 hrs/week: karensavdrag ≈ 1,108 SEK.' },
  sickOnePerPeriod: { kind: 'skill', ref: `${SKILL}/sick-pay.md`, at: '19', quote: 'Only one karensavdrag per sjuklöneperiod. The allmänt högriskskydd limits karensavdrag to maximum 10 per rolling 12-month period.' },
  sickDay2to14: { kind: 'skill', ref: `${SKILL}/sick-pay.md`, at: '21-23', quote: 'Sjuklön = 80% of the salary and anställningsförmåner the employee loses due to sickness, calculated per scheduled work hour.' },
  sickLakarintyg: { kind: 'skill', ref: `${SKILL}/sick-pay.md`, at: '27', quote: 'Required from day 8 (SjLL 8 §).' },
  sickAterinsjuknande: { kind: 'skill', ref: `${SKILL}/sick-pay.md`, at: '29-31', quote: 'If the employee falls sick again within 5 calendar days, the same sjuklöneperiod continues (no new karensavdrag). The remaining days of the original 14-day period are used.' },
  sickDay15: { kind: 'skill', ref: `${SKILL}/sick-pay.md`, at: '33-35', quote: 'Day 15+: Försäkringskassan. The employer must report to Försäkringskassan within 7 calendar days after the sjuklöneperiod ends.' },
  avgifterTotal: { kind: 'skill', ref: `${SKILL}/social-charges.md`, at: '5-16', quote: 'Total: 31.42% (unchanged since 2009). Calculated on full gross with no cap.' },
  avgifterReduced: { kind: 'skill', ref: `${SKILL}/social-charges.md`, at: '23', quote: 'The reduced rate (only ålderspensionsavgift 10.21%) applies if the person reached the riktålder at year\'s start. ... For 2026: born 1938-1958' },
  avgifterYouth: { kind: 'skill', ref: `${SKILL}/social-charges.md`, at: '25', quote: '20.81% in total, on salary up to 25,000 SEK/month ... the part above 25,000 SEK/month is charged at 31.42% ... born 2003-2007 for tax year 2026' },
  pbb2026: { kind: 'skill', ref: `${SKILL}/social-charges.md`, at: '45', quote: 'Prisbasbelopp (PBB) | 58,800 | 59,200' },
  vacProcent: { kind: 'skill', ref: `${SKILL}/vacation-pay.md`, at: '9-11', quote: 'Semesterlön = 12% of total semesterlönegrundande income during the intjänandeår.' },
  vacSammalon: { kind: 'skill', ref: `${SKILL}/vacation-pay.md`, at: '5-7', quote: 'semestertillägg of minimum 0.43% of monthly salary per vacation day (many CBAs use 0.8%)' },
  vacAccrual: { kind: 'skill', ref: `${SKILL}/vacation-pay.md`, at: '27-29', quote: 'Debit 7519 and credit 2940 for social charges on the accrual (31.42% for standard employees, 10.21% for 67+).' },
  vacSaved: { kind: 'skill', ref: `${SKILL}/vacation-pay.md`, at: '39-43', quote: 'Saved days are valued using the most recent intjänandeår\'s calculation. Upon termination, all untaken days must be paid as semesterersättning within 1 month.' },
  vacShortWeek: { kind: 'skill', ref: `${SKILL}/vacation-pay.md`, at: '56-57', quote: 'Days off = paid days x workdays per week / 5, rounded up ... Pay and pools stay on the paid days: the semestertillägg is "för varje betald semesterdag"' },
  vacQualifyingAbsence: { kind: 'skill', ref: `${SKILL}/vacation-pay.md`, at: '45-47', quote: 'sjukfrånvaro (first 180 days), föräldraledighet (up to 120 days per child ...)' },
  kostforman2026: { kind: 'skill', ref: `${SKILL}/benefits.md`, at: '44-54', quote: '2026 | 310 SEK | 124 SEK | 62 SEK ... If the employee pays ≥ schablonvärde via nettolöneavdrag, no taxable benefit arises.' },
  taxTableLookup: { kind: 'skill', ref: `${SKILL}/tax-tables.md`, at: '22-28', quote: 'Look up the monthly gross salary bracket to find the withholding amount' },
  taxColumns: { kind: 'skill', ref: `${SKILL}/tax-tables.md`, at: '11-20' },
  processingOrder: { kind: 'skill', ref: '.claude/skills/swedish-payroll/SKILL.md', at: 'Processing order for gross-to-net', quote: 'bruttolöneavdrag → förmånsvärden (reduced by nettolöneavdrag) → tax base → skattetabell lookup → net pay' },
  obContractual: { kind: 'skill', ref: `${SKILL}/ob-overtime.md`, at: '3-5', quote: 'No Swedish law sets OB rates. ... payroll software must treat every rate, window, and divisor as configuration' },
  agiCorrection: { kind: 'skill', ref: `${SKILL}/agi-filing.md`, at: '53-55', quote: 'Corrections require resubmitting a complete AGI for the same period with the same specifikationsnummer.' },

  // Other statutes and standards.
  sff22: { kind: 'statute', ref: 'Skatteförfarandeförordningen (2011:1261) 22 kap. 1 §', quote: 'öretal bortfaller (skatteavdrag i hela kronor)' },
  sfl11: { kind: 'statute', ref: 'Skatteförfarandelagen (2011:1244) 11 kap. 16-17 §§ (engångsbelopp)' },
  skv434: { kind: 'standard', ref: 'Skatteverket SKV 434, allmänna tabeller månad 2026 (bundled as src/lib/salary/tax-tables-fallback.ts)' },
  agiTruncation: { kind: 'standard', ref: 'Skatteverket Teknisk beskrivning AGI 1.1.18, kontroll B_006 (avgift per sats on whole-krona underlag)', at: 'cited in src/lib/salary/declared-avgifter.ts:6-16' },
  k2_1710: { kind: 'standard', ref: 'BFNAR 2016:10 (K2) punkt 17.10', at: 'k2.txt:14750-14759', quote: 'Lagstadgade arbetsgivaravgifter ska ingå i semesterlöneskulden. ... Semesterlöneskulden ska beräknas individuellt för varje anställd.' },
  k2_17b: { kind: 'standard', ref: 'BFNAR 2016:10 (K2) exempel 17 b', at: 'k2.txt:21423-21449', quote: 'Semesterlönen per semesterdag beräknas till 5,4 % av månadslönen. Den består dels av lön (4,6 %), dels av semesterlönetillägg (0,8 %). Semesterlöneskulden blir 162 000 kr (30 000 × 0,054 × 100 dagar).' },
  fortnoxProcent: { kind: 'url', ref: 'https://www.fortnox.se/fortnox-foretagsguide/lon-och-loneadministration/sa-mycket-kostar-en-anstalld', at: 'fetched 2026-10-27', quote: '(100 000 * 12%) / 25 = 480 kronor; (100 000 * 14,4%) / 30 = 480 kronor; (30 000 0,43%) 25 = 3225 kronor' },
  spirisSammalon: { kind: 'url', ref: 'https://www.spiris.se/support/lon/semesterarsavslut', at: 'fetched 2026-10-27', quote: 'Ersättningen beräknas Månadslön * (4,6 % + Semestertillägg %) = Semesterdaglön' },

  // Company calculation conventions (documented choices, not law).
  convDailyDivisor: { kind: 'convention', ref: 'src/lib/salary/work-schedule.ts', at: '26-27', quote: 'LEGACY_DAILY_DIVISOR = 21 (52 weeks x 5 workdays / 12 months, rounded down)' },
  convPolicy: { kind: 'convention', ref: 'src/lib/salary/calculation-policy.ts', at: '27-103', quote: 'partial_month, sick_rate, long_leave, leave_context, net_rounding, one_off_tax_rounding' },
  convPartialWorkdays: { kind: 'convention', ref: 'src/lib/salary/calculation-policy.ts', at: '31-35', quote: 'workdays: månadslön × arbetsdagar i anställning / arbetsdagar i perioden (Mon-Fri, no holiday exclusion)' },
  convPartialCalendar: { kind: 'convention', ref: 'src/lib/salary/calculation-policy.ts', at: '36-40', quote: 'annual_calendar_days: (månadslön × 12 / 365) rounded to öre, times the calendar days employed inside the period' },
  convSickAnnualHourly: { kind: 'convention', ref: 'src/lib/salary/calculation-policy.ts', at: '42-53', quote: 'Timlön = månadslön × 12 / (52 × veckoarbetstid); sjukavdrag per timme = timlön; sjuklön per timme = 80 % × timlön' },
  convLongLeaveCalendar: { kind: 'convention', ref: 'src/lib/salary/calculation-policy.ts', at: '54-67', quote: 'A longer episode deducts per CALENDAR day, weekends included, at månadslön × 12 / 365. ... Sick day 15+ is always priced at the calendar rate.' },
  convOneOffRounding: { kind: 'convention', ref: 'src/lib/salary/calculation-policy.ts', at: '88-94', quote: 'truncate: belopp × procent, öretal bortfaller ... nearest: compatibility with systems that round the one-off tax to the nearest krona' },
  convDayValue: { kind: 'convention', ref: 'src/lib/salary/semesterberedning.ts', at: '19-23', quote: 'sammalöneregeln (monthly): monthly/dailyDivisor + monthly x tillägg; procentregeln (monthly): monthly x 12 x rate / entitled days; procentregeln (hourly): hourly x hours_per_week x 52 x rate / entitled' },
  convDayValue4_6: { kind: 'convention', ref: 'src/lib/salary/calculation-policy.ts', at: '96-107 (vacation_day_value)', quote: 'percent_4_6: 4,6 % of the månadslön per paid day, the value the market (Fortnox, Spiris, K2 exempel 17 b) uses.' },
  remeasurePlan: { kind: 'convention', ref: 'src/lib/salary/vacation-liability-plan.ts', at: 'buildRemeasurePlan', quote: 'The plan from a valuation, the booked specification per employee and the booked balances.' },
  convSammaloneAccrual: { kind: 'convention', ref: 'src/lib/salary/calculation-engine.ts', at: '879-912', quote: 'Only the month\'s earned share accrues: månadslön × tillägg × semesterdagar / 12' },
  convVacationDeduction: { kind: 'convention', ref: 'src/lib/salary/vacation-days-pay.ts', at: '19-23', quote: 'the salary for the days goes (one dagslön per day off, the engine\'s day: månadslön / dagdivisor) and the semesterlön comes' },
} as const satisfies Record<string, SourceRef>

/** Shorthand used by the data files. */
export const at = (source: SourceRef, extra: Partial<SourceRef>): SourceRef => ({ ...source, ...extra })

/** The test name: id and title, plus the missing capability on a todo. */
export function scenarioTestName(s: Pick<Scenario, 'id' | 'title' | 'status' | 'todoReason'>): string {
  const base = `${s.id} ${s.title}`
  return s.status === 'todo' && s.todoReason ? `${base} [todo: ${s.todoReason}]` : base
}

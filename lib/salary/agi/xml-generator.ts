import { decryptPersonnummer } from '../personnummer'

/**
 * AGI XML generator: Arbetsgivardeklaration på individnivå.
 *
 * Produces XML conforming to Skatteverket's schema:
 *   http://xmls.skatteverket.se/se/skatteverket/da/instans/schema/1.1
 *
 * The XML can be uploaded on Skatteverket's AGI e-tjänst. For programmatic
 * submission use the JSON API flow via the skatteverket extension instead.
 *
 * Sources verified against Skatteverket's schema + technical description
 * (SKV 269, teknisk beskrivning 1.1.16):
 *   - Root: <Skatteverket omrade="Arbetsgivardeklaration">
 *   - HU totals: SummaSkatteavdr (497), SummaArbAvgSlf (487), TotalSjuklonekostnad (499)
 *   - IU identity: BetalningsmottagarId (215), Specifikationsnummer (570)
 *   - IU amounts: KontantErsattningUlagAG (011), AvdrPrelSkatt (001)
 *   - Every HU and IU must include AgRegistreradId (201) + RedovisningsPeriod (006)
 *
 * CRITICAL: FK570 (specifikationsnummer) must stay consistent per employee.
 * Corrections are detected by Skatteverket matching the same FK570.
 *
 * Frånvarouppgift emission is implemented per Skatteverket SKV 4785 + the
 * "Frånvarouppgift i samband med Arbetsgivardeklaration" technical doc:
 *   - One <gem:Franvarouppgift> per (employee, date, specifikationsnummer)
 *   - Sibling of <gem:Blankett>, top-level under <Skatteverket>
 *   - FranvaroChoice contains FranvaroTyp (TILLFALLIG_FORALDRAPENNING for VAB,
 *     FORALDRAPENNING for parental leave): the borttag flow is not used.
 *   - Hours emitted via FranvaroTimmarTFP (FK825) for VAB or FranvaroTimmarFP
 *     (FK827) for parental. The procent variants (824/826) are not used:
 *     Accounted tracks hours, not percent.
 *   - FranvaroSpecifikationsnummer is persisted on salary_absence_days
 *     (column franvaro_specifikationsnummer; assigned by DB trigger on
 *     INSERT, never re-numbered). Skatteverket replaces a Frånvarouppgift
 *     on match of (BetalningsmottagarId, FranvaroDatum,
 *     FranvaroSpecifikationsnummer, RedovisningsPeriod, AgRegistreradId).
 *     Because the number is stable, corrections survive day deletions:
 *     remaining events keep their original numbers, and Skatteverket
 *     matches each event back to its prior submission.
 *   - Periods before 202501 emit no Frånvarouppgift (Skatteverket rejects).
 *
 * Per-employee sick days are NOT reported via AGI under any version: they
 * go to Försäkringskassan separately. The company-level FK499
 * TotalSjuklonekostnad in HU is correctly emitted from sick_day2_14 line
 * items × dailyRate × 0.80 (see agi/xml/route.ts).
 */

const INSTANS_NS = 'http://xmls.skatteverket.se/se/skatteverket/da/instans/schema/1.1'
const KOMPONENT_NS = 'http://xmls.skatteverket.se/se/skatteverket/da/komponent/schema/1.1'

// Programnamn: software identifier embedded in every AGI submission.
// Free-text per Skatteverket's schema (no vendor registry), but kept stable
// across visual rebrands so the value the tax authority sees never churns.
// Bump only if Skatteverket ever introduces a formal vendor registration
// and 'accounted' is the registered name there.
const AGI_PROGRAMNAMN = 'gnubok'

/**
 * One absence event for AGI Frånvarouppgift emission. Loaded from
 * salary_absence_days (per-day records). Sick days are NOT included: they
 * go to Försäkringskassan, not Skatteverket.
 */
export interface AGIAbsenceEvent {
  /** YYYY-MM-DD: emitted as FK821 FranvaroDatum. */
  date: string
  /** Mapped to FranvaroTyp:
   *    'vab'      → TILLFALLIG_FORALDRAPENNING (FK825 hours field)
   *    'parental' → FORALDRAPENNING            (FK827 hours field) */
  type: 'vab' | 'parental'
  /** Hours absent on this date, 0.01-24.00. Defaults to 8 in salary_absence_days. */
  hours: number
  /**
   * FK822 FranvaroSpecifikationsnummer: stable per-(employee, year-month)
   * sequence assigned at the DB level (see migration
   * 20260517120000_salary_absence_days_franvaro_specifikationsnummer.sql).
   * MUST stay constant across corrections: never recompute from array
   * index. Persisted on salary_absence_days.franvaro_specifikationsnummer.
   */
  specifikationsnummer: number
}

export interface AGIEmployeeData {
  personnummer: string       // Encrypted: decrypted for XML
  specificationNumber: number // FK570: MUST stay consistent per employee
  grossSalary: number         // FK011 KontantErsattningUlagAG
  taxWithheld: number         // FK001 AvdrPrelSkatt
  avgifterBasis: number       // Retained for backwards compat; equals grossSalary for standard cases. Not emitted separately (FK011 already captures basis).
  /**
   * FK205 Borttag: tombstone this IU. When true, the XML emits only the
   * identity fields (FK201, FK215, FK570, FK006) plus <Borttag>1</Borttag>;
   * amounts and benefits are skipped. Skatteverket then removes the prior
   * IU matching (AgRegistreradId, BetalningsmottagarId, RedovisningsPeriod,
   * Specifikationsnummer). Only meaningful for periods that already had an
   * AGI declaration filed.
   */
  removed?: boolean
  /**
   * Växa-stöd flag: emitted as one of two mutually exclusive boolean fields:
   *   'forsta_anstalld' → FK062 ForstaAnstalld (anställd före 2024-05-01)
   *   'vaxa_stod'       → FK063 VaxaStod      (anställd efter 2024-04-30)
   * Set when the employer claims växa-stöd reduction (10.21% avgifter rate)
   * for this employee in the period. The cutoff date is hard-coded in the
   * spec (Prop. 2023/24:80, see Skatteverket FK 1.7 revisionshistorik 1.19).
   */
  vaxaStod?: 'forsta_anstalld' | 'vaxa_stod'
  /**
   * FK048 FormanHarJusterats: set when any benefit value on this IU has
   * been adjusted away from the standard schablon. Reflects
   * salary_run_employees.benefits_adjusted.
   */
  benefitsAdjusted?: boolean
  fSkattPayment?: number      // FK131 KontantErsattningEjUlagSA
  benefitCar?: number         // FK013 SkatteplBilformanUlagAG (amount, BELOPP7)
  benefitFuel?: number        // FK018 DrivmVidBilformanUlagAG (amount, BELOPP7)
  /**
   * FK015 KostformanUlagAG (amount, BELOPP10). Kostförmån has its own
   * dedicated field in the AGI spec with a PBB-linked schablon value:
   * Skatteverket cross-checks the reported amount against the schablon.
   * Aggregating meals into FK012 (övriga förmåner) triggers automated
   * discrepancy notices. Always emit FK015 separately when > 0.
   */
  benefitMeals?: number
  /**
   * Housing benefit indicator. FK041 (smahus) and FK043 (ej_smahus) are
   * boolean KRYSS flags in the XSD: they just signal that this kind of
   * benefit was given. The AMOUNT must be folded into benefitOther
   * (FK012). Pass 'smahus' or 'ej_smahus' to set the flag; omit if no
   * housing benefit applies.
   */
  housingBenefit?: 'smahus' | 'ej_smahus'
  /**
   * FK012 SkatteplOvrigaFormanerUlagAG (amount, BELOPP10). Catch-all for
   * taxable benefits without their own dedicated FK code: bike, wellness,
   * "other", AND the full krona-amount for housing (since FK041/FK043
   * carry only the flag). Meals go in benefitMeals (FK015), NOT here.
   */
  benefitOther?: number
  /**
   * When true, benefit amounts and housing flags emit as the "ej underlag
   * SA" variants (FK132/FK133/FK134/FK137/FK138) instead of the standard
   * UlagAG variants (FK012/FK013/FK018/FK041/FK043). Set this for F-skatt
   * holders and other payees whose benefits should not form basis for
   * arbetsgivaravgifter. Defaults to false. FK131 (cash, ej UlagSA) is
   * controlled separately via fSkattPayment.
   */
  benefitsExcludedFromSAUnderlag?: boolean
  /** @deprecated Per-employee sick days are not reported via AGI (goes to Försäkringskassan separately). Kept for snapshot compatibility. */
  sickDays?: number
  /** @deprecated VAB is reported via top-level <Franvarouppgift> as per-event records (see absenceEvents), not as an IU day count. Kept for snapshot compatibility. */
  vabDays?: number
  /** @deprecated Parental leave is reported via top-level <Franvarouppgift> as per-event records (see absenceEvents), not as an IU day count. Kept for snapshot compatibility. */
  parentalDays?: number
  /**
   * Per-event absence records for the period. Drives <gem:Franvarouppgift>
   * emission. VAB and parental only: sick days excluded by spec (FK).
   */
  absenceEvents?: AGIAbsenceEvent[]
}

export interface AGICompanyData {
  orgNumber: string          // 10 digits after stripping dashes
  companyName: string
  periodYear: number
  periodMonth: number
  contactName: string
  contactPhone: string
  contactEmail: string
}

export interface AGITotals {
  totalTax: number                // FK497 SummaSkatteavdr
  totalAvgifterBasis: number      // retained for compat (sum of IU underlag)
  totalAvgifterAmount: number     // FK487 SummaArbAvgSlf (sum of calculated avgifter across categories)
  /**
   * FK499 TotalSjuklonekostnad: company's total sjuklön cost for the period
   * (sum of sjuklön paid days 2-14 across all employees). Required per 2025+ rules.
   * Day 1 is karens (unpaid); day 15+ is Försäkringskassan, not employer.
   */
  totalSjuklonekostnad?: number
  avgifterByCategory: {
    standard?: { basis: number; amount: number }
    reduced65plus?: { basis: number; amount: number }
    youth?: { basis: number; amount: number }
  }
}

/**
 * Thrown when required AGI data is missing. Caller should surface the message
 * to the user so they can fill in the missing field (org number, contact info).
 */
export class AGIIncompleteDataError extends Error {
  constructor(message: string, public readonly missingFields: string[]) {
    super(message)
    this.name = 'AGIIncompleteDataError'
  }
}

function assertRequiredCompanyData(company: AGICompanyData): void {
  const missing: string[] = []
  const orgNumberDigits = (company.orgNumber || '').replace(/\D/g, '')
  // Skatteverket's IDENTITET type requires either 10 digits (AB orgnr, we prefix
  // with "16") or 12 digits (personnummer for enskild firma). Any other length
  // is a data-entry error that we cannot silently fix.
  if (orgNumberDigits.length !== 10 && orgNumberDigits.length !== 12) missing.push('organisationsnummer')
  if (!company.contactName.trim()) missing.push('kontaktperson (namn)')
  if (!company.contactPhone.trim()) missing.push('telefon')
  if (!company.contactEmail.trim()) missing.push('e-post')

  if (missing.length > 0) {
    throw new AGIIncompleteDataError(
      `AGI kan inte genereras, följande uppgifter saknas: ${missing.join(', ')}. ` +
        'Fyll i dem under Inställningar → Företag och Inställningar → Lön.',
      missing
    )
  }
}

/**
 * Smallest period the AGI API accepts, per Skatteverket v1.7 spec §6.3:
 * "redovisningsperiod (URI-parameter): YYYYMM, tidigast 201807".
 * Periods before this raise HTTP 404 felkod 31 at SKV's gateway.
 */
const AGI_MIN_PERIOD_YYYYMM = 201807

function assertRequiredPeriod(year: number, month: number): void {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new AGIIncompleteDataError(
      `Ogiltig redovisningsperiod: ${year}-${month}. Ange ett giltigt år och månad (1-12).`,
      ['redovisningsperiod'],
    )
  }
  const yyyymm = year * 100 + month
  if (yyyymm < AGI_MIN_PERIOD_YYYYMM) {
    throw new AGIIncompleteDataError(
      `Redovisningsperioden ${year}-${String(month).padStart(2, '0')} är tidigare än ` +
        `${Math.floor(AGI_MIN_PERIOD_YYYYMM / 100)}-${String(AGI_MIN_PERIOD_YYYYMM % 100).padStart(2, '0')}, ` +
        'som är den tidigaste period Skatteverkets AGI-API accepterar (Tjänstebeskrivning v1.7 §6.3). ' +
        'Kontrollera att lönekörningens period är korrekt.',
      ['redovisningsperiod'],
    )
  }
}

/**
 * File-size ceilings from v1.7 §1: 100 MB on the test environment,
 * 300 MB in production. Rejecting locally just means a cleaner Swedish
 * error than the 413 felkod 27 SKV would otherwise return.
 */
const AGI_TEST_MAX_BYTES = 100 * 1024 * 1024
const AGI_PROD_MAX_BYTES = 300 * 1024 * 1024

export class AGIPayloadTooLargeError extends Error {
  constructor(message: string, public readonly sizeBytes: number, public readonly limitBytes: number) {
    super(message)
    this.name = 'AGIPayloadTooLargeError'
  }
}

/**
 * Resolve the Skatteverket environment from a dedicated env var. Default
 * to the stricter 'test' bucket when unset/unrecognised: a missing or
 * misconfigured value must never silently raise the size ceiling.
 *
 * Documented in deployment runbook; substring-matching the API URL is
 * forbidden (a misconfigured URL containing 'api.test.skatteverket.se'
 * would otherwise lower the limit on a production tenant: the inverse
 * was equally bad).
 */
function resolveSkatteverketEnv(): 'test' | 'production' {
  const raw = process.env.SKATTEVERKET_ENV?.trim().toLowerCase()
  if (raw === 'production' || raw === 'prod') return 'production'
  if (raw === 'test') return 'test'
  if (raw && raw !== '') {
    // Unrecognised value: fail closed to test. Logged once so deployments
    // catch typos in CI rather than at audit time.
    // eslint-disable-next-line no-console
    console.warn(
      `SKATTEVERKET_ENV='${raw}' is not 'test' | 'production'; defaulting to 'test' (stricter limits).`,
    )
  }
  return 'test'
}

function assertPayloadSize(xml: string): void {
  const bytes = Buffer.byteLength(xml, 'utf8')
  const env = resolveSkatteverketEnv()
  const envLimit = env === 'production' ? AGI_PROD_MAX_BYTES : AGI_TEST_MAX_BYTES
  if (bytes > envLimit) {
    const mb = (bytes / (1024 * 1024)).toFixed(1)
    const limitMb = Math.floor(envLimit / (1024 * 1024))
    throw new AGIPayloadTooLargeError(
      `AGI XML är för stort (${mb} MB). Skatteverkets gräns för denna miljö är ${limitMb} MB ` +
        '(Tjänstebeskrivning v1.7 §1). Dela upp inlämningen i mindre paket per arbetsgivare eller period.',
      bytes,
      envLimit,
    )
  }
}

/**
 * Skatteverket's IDENTITET pattern (from the AGI XSD). Accepts:
 *   - 12-digit personnummer YYYYMMDDXXXX (real dates 19xx/20xx, incl. leap days
 *     and samordningsnummer where day = actual_day + 60)
 *   - 12-digit AB/organisationsnummer: literal "16" + 10-digit orgnr, where the
 *     3rd digit (first of the 10-digit orgnr) is 1-3, 5, 6, 7, 8 or 9 (NOT 4,
 *     and with specific restrictions) and the 5th is 2-9.
 *
 * Mirrored here so we can fail fast with a user-friendly message instead of
 * emitting XML that Skatteverket's validator will reject cryptically.
 */
const IDENTITET_PATTERN = /^(((19|20)[0-9][0-9])((((01|03|05|07|08|10|12)(6[1-9]|7[0-9]|8[0-9]|9[0-1]))|((04|06|09|11)(6[1-9]|7[0-9]|8[0-9]|90))|((02)(6[1-9]|7[0-9]|8[0-8])))|00[6-9][0-9]|[0-9][0-9]60)|(((19|20)(04|08|12|16|20|24|28|32|36|40|44|48|52|56|60|64|68|72|76|80|84|88|92|96)(0289))|(20000289)))(00[1-9]|0[1-9][0-9]|[1-9][0-9][0-9])[0-9]|16(1[0-9]|2[0-9]|3[0-9]|5[0-9]|6[0-4]|66|68|7[0-9]|8[0-9]|9[0-9])[2-9]\d{7}|((((19|20)[0-9][0-9])(((01|03|05|07|08|10|12)(0[1-9]|1[0-9]|2[0-9]|3[0-1]))|((04|06|09|11)(0[1-9]|1[0-9]|2[0-9]|30))|((02)(0[1-9]|1[0-9]|2[0-8]))))|(((19|20)(04|08|12|16|20|24|28|32|36|40|44|48|52|56|60|64|68|72|76|80|84|88|92|96)(0229))|(20000229)))(00[1-9]|0[1-9][0-9]|[1-9][0-9][0-9])[0-9]$/

/**
 * Normalize an org number or personnummer to Skatteverket's 12-character
 * IDENTITET format, required by the AGI schema for Avsandare/Organisationsnummer,
 * AgRegistreradId, and Arendeagare.
 *
 *   - 10-digit orgnr (AB e.g. 5561234567) → prefixed with "16" → 165561234567
 *   - 12-digit personnummer (EF e.g. 196904206942) → used as-is
 *
 * Throws AGIIncompleteDataError if the resulting value cannot match the
 * IDENTITET pattern: this catches bogus test data (e.g. "420694-2069") before
 * the file reaches Skatteverket.
 */
function toIdentitet(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  let candidate: string
  if (digits.length === 12) candidate = digits
  else if (digits.length === 10) candidate = `16${digits}`
  else {
    throw new AGIIncompleteDataError(
      `Ogiltigt organisations-/personnummer (${digits.length} siffror). ` +
        'Ange ett giltigt svenskt organisationsnummer (10 siffror, t.ex. 556123-4567) ' +
        'eller fullständigt personnummer (12 siffror, YYYYMMDD-XXXX) under Inställningar → Företag.',
      ['organisationsnummer']
    )
  }

  if (!IDENTITET_PATTERN.test(candidate)) {
    throw new AGIIncompleteDataError(
      `Ogiltigt organisationsnummer "${raw}": värdet är inte ett svenskt organisationsnummer eller personnummer enligt Skatteverkets format. ` +
        'Kontrollera värdet under Inställningar → Företag. För AB ska det vara 10 siffror (t.ex. 556123-4567). ' +
        'För enskild firma ska det vara ett fullständigt 12-siffrigt personnummer (YYYYMMDD-XXXX).',
      ['organisationsnummer']
    )
  }
  return candidate
}

/**
 * Generate AGI XML for a period.
 *
 * Throws AGIIncompleteDataError if required fields (orgNumber, contact info)
 * are missing: we never emit partial XML that Skatteverket would reject.
 */
export function generateAGIXml(
  company: AGICompanyData,
  employees: AGIEmployeeData[],
  totals: AGITotals,
  _isCorrection: boolean = false
): string {
  assertRequiredCompanyData(company)
  assertRequiredPeriod(company.periodYear, company.periodMonth)

  const orgIdentitet = toIdentitet(company.orgNumber)
  const period = `${company.periodYear}${String(company.periodMonth).padStart(2, '0')}`
  const createdAt = new Date().toISOString().replace(/\.\d+Z$/, '')

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(
    `<Skatteverket omrade="Arbetsgivardeklaration" xmlns="${INSTANS_NS}" xmlns:gem="${KOMPONENT_NS}">`
  )

  // ── Avsandare (komponent namespace) ──────────────────────────
  lines.push('  <gem:Avsandare>')
  lines.push(`    <gem:Programnamn>${AGI_PROGRAMNAMN}</gem:Programnamn>`)
  lines.push(`    <gem:Organisationsnummer>${orgIdentitet}</gem:Organisationsnummer>`)
  lines.push('    <gem:TekniskKontaktperson>')
  lines.push(`      <gem:Namn>${escapeXml(company.contactName)}</gem:Namn>`)
  lines.push(`      <gem:Telefon>${escapeXml(company.contactPhone)}</gem:Telefon>`)
  lines.push(`      <gem:Epostadress>${escapeXml(company.contactEmail)}</gem:Epostadress>`)
  lines.push('    </gem:TekniskKontaktperson>')
  lines.push(`    <gem:Skapad>${createdAt}</gem:Skapad>`)
  lines.push('  </gem:Avsandare>')

  // ── Blankettgemensamt (komponent namespace) ──────────────────
  lines.push('  <gem:Blankettgemensamt>')
  lines.push('    <gem:Arbetsgivare>')
  lines.push(`      <gem:AgRegistreradId>${orgIdentitet}</gem:AgRegistreradId>`)
  lines.push('      <gem:Kontaktperson>')
  lines.push(`        <gem:Namn>${escapeXml(company.contactName)}</gem:Namn>`)
  lines.push(`        <gem:Telefon>${escapeXml(company.contactPhone)}</gem:Telefon>`)
  lines.push(`        <gem:Epostadress>${escapeXml(company.contactEmail)}</gem:Epostadress>`)
  lines.push('      </gem:Kontaktperson>')
  lines.push('    </gem:Arbetsgivare>')
  lines.push('  </gem:Blankettgemensamt>')

  // ── Blankett: Huvuduppgift (komponent namespace) ─────────────
  lines.push('  <gem:Blankett>')
  lines.push('    <gem:Arendeinformation>')
  lines.push(`      <gem:Arendeagare>${orgIdentitet}</gem:Arendeagare>`)
  lines.push(`      <gem:Period>${period}</gem:Period>`)
  lines.push('    </gem:Arendeinformation>')
  lines.push('    <gem:Blankettinnehall>')
  // HU/IU substitute for the abstract gem:Uppgift element in the komponent
  // namespace (substitution group head). Use the concrete element directly:
  // gem:Uppgift itself is abstract and cannot appear in an instance document.
  lines.push('      <gem:HU>')
  // AgRegistreradId is wrapped in ArbetsgivareHUGROUP, all payload elements
  // live in the komponent namespace (gem: prefix).
  lines.push('        <gem:ArbetsgivareHUGROUP>')
  lines.push(`          <gem:AgRegistreradId faltkod="201">${orgIdentitet}</gem:AgRegistreradId>`)
  lines.push('        </gem:ArbetsgivareHUGROUP>')
  lines.push(`        <gem:RedovisningsPeriod faltkod="006">${period}</gem:RedovisningsPeriod>`)

  // FK497: Summa skatteavdrag (total from all IU)
  if (totals.totalTax > 0) {
    lines.push(`        <gem:SummaSkatteavdr faltkod="497">${formatAmount(totals.totalTax)}</gem:SummaSkatteavdr>`)
  }

  // FK487: Summa arbetsgivaravgifter och SLF (calculated total, NOT basis)
  if (totals.totalAvgifterAmount > 0) {
    lines.push(`        <gem:SummaArbAvgSlf faltkod="487">${formatAmount(totals.totalAvgifterAmount)}</gem:SummaArbAvgSlf>`)
  }

  // FK499: Total sjuklönekostnad (legal requirement from 2025 when > 0)
  if (totals.totalSjuklonekostnad && totals.totalSjuklonekostnad > 0) {
    lines.push(`        <gem:TotalSjuklonekostnad faltkod="499">${formatAmount(totals.totalSjuklonekostnad)}</gem:TotalSjuklonekostnad>`)
  }

  lines.push('      </gem:HU>')
  lines.push('    </gem:Blankettinnehall>')
  lines.push('  </gem:Blankett>')

  // ── Blankett: Individuppgift (one per employee) ──────────────
  for (const emp of employees) {
    // FK570 must be ≥ 1 (HELTAL, min 1 per spec). A 0 here would produce a
    // STOPP-level rejection at Skatteverket; fail fast with a clearer
    // Swedish message pointing at the missing column rather than letting
    // bogus XML reach SKV.
    if (!Number.isInteger(emp.specificationNumber) || emp.specificationNumber < 1) {
      throw new AGIIncompleteDataError(
        `Anställd saknar giltigt specifikationsnummer (FK570). ` +
          'Specifikationsnumret måste vara ett heltal ≥ 1 och stabilt över korrigeringar. ' +
          'Kontrollera fältet specification_number på den anställdes profil.',
        ['specifikationsnummer'],
      )
    }

    let pnr: string
    try {
      pnr = decryptPersonnummer(emp.personnummer)
    } catch {
      throw new Error(
        `Kunde inte dekryptera personnummer för anställd med FK570=${emp.specificationNumber}. ` +
          'AGI kan inte genereras utan giltigt personnummer.'
      )
    }

    lines.push('  <gem:Blankett>')
    lines.push('    <gem:Arendeinformation>')
    lines.push(`      <gem:Arendeagare>${orgIdentitet}</gem:Arendeagare>`)
    lines.push(`      <gem:Period>${period}</gem:Period>`)
    lines.push('    </gem:Arendeinformation>')
    lines.push('    <gem:Blankettinnehall>')
    lines.push('      <gem:IU>')
    // Identity groups wrap AgRegistreradId and BetalningsmottagarId in IU.
    lines.push('        <gem:ArbetsgivareIUGROUP>')
    lines.push(`          <gem:AgRegistreradId faltkod="201">${orgIdentitet}</gem:AgRegistreradId>`)
    lines.push('        </gem:ArbetsgivareIUGROUP>')
    // BetalningsmottagarId must be inside BetalningsmottagareIDChoice (an
    // xs:choice allowing BetalningsmottagarId | Fodelsetid | AnnatId).
    lines.push('        <gem:BetalningsmottagareIUGROUP>')
    lines.push('          <gem:BetalningsmottagareIDChoice>')
    lines.push(`            <gem:BetalningsmottagarId faltkod="215">${pnr}</gem:BetalningsmottagarId>`)
    lines.push('          </gem:BetalningsmottagareIDChoice>')
    lines.push('        </gem:BetalningsmottagareIUGROUP>')
    lines.push(`        <gem:RedovisningsPeriod faltkod="006">${period}</gem:RedovisningsPeriod>`)
    lines.push(`        <gem:Specifikationsnummer faltkod="570">${emp.specificationNumber}</gem:Specifikationsnummer>`)

    // FK205 Borttag: tombstone this IU. When set, skip all amount/benefit
    // fields; only the identity quintuple above (FK201, FK215, FK006, FK570)
    // plus this flag are needed for Skatteverket to remove the prior IU.
    if (emp.removed) {
      lines.push('        <gem:Borttag faltkod="205">1</gem:Borttag>')
      lines.push('      </gem:IU>')
      lines.push('    </gem:Blankettinnehall>')
      lines.push('  </gem:Blankett>')
      continue
    }

    // FK011: Kontant ersättning, underlag arbetsgivaravgifter (= gross salary)
    if (emp.grossSalary > 0) {
      lines.push(`        <gem:KontantErsattningUlagAG faltkod="011">${formatAmount(emp.grossSalary)}</gem:KontantErsattningUlagAG>`)
    }

    // FK001: Avdragen preliminärskatt
    if (emp.taxWithheld > 0) {
      lines.push(`        <gem:AvdrPrelSkatt faltkod="001">${formatAmount(emp.taxWithheld)}</gem:AvdrPrelSkatt>`)
    }

    const exclSA = emp.benefitsExcludedFromSAUnderlag === true

    // Car benefit AMOUNT: FK013 (UlagAG) or FK133 (ej UlagSA)
    if (emp.benefitCar && emp.benefitCar > 0) {
      const code = exclSA ? '133' : '013'
      const elem = exclSA ? 'SkatteplBilformanEjUlagSA' : 'SkatteplBilformanUlagAG'
      lines.push(`        <gem:${elem} faltkod="${code}">${formatAmount(emp.benefitCar)}</gem:${elem}>`)
    }

    // Fuel for car benefit AMOUNT: FK018 (UlagAG) or FK134 (ej UlagSA)
    if (emp.benefitFuel && emp.benefitFuel > 0) {
      const code = exclSA ? '134' : '018'
      const elem = exclSA ? 'DrivmVidBilformanEjUlagSA' : 'DrivmVidBilformanUlagAG'
      lines.push(`        <gem:${elem} faltkod="${code}">${formatAmount(emp.benefitFuel)}</gem:${elem}>`)
    }

    // Kostförmån AMOUNT: FK015 (UlagAG) or FK139 (ej UlagSA). Has its own
    // field because Skatteverket cross-checks the krona-belopp against the
    // PBB-anchored schablon: folding it into FK012 triggers discrepancy
    // notices. Always emit separately when > 0.
    if (emp.benefitMeals && emp.benefitMeals > 0) {
      const code = exclSA ? '139' : '015'
      const elem = exclSA ? 'KostformanEjUlagSA' : 'KostformanUlagAG'
      lines.push(`        <gem:${elem} faltkod="${code}">${formatAmount(emp.benefitMeals)}</gem:${elem}>`)
    }

    // Housing benefit FLAGS (KRYSS, no amount on this element). The
    // krona-amount belongs in benefitOther (FK012/FK132).
    //   FK041 BostadsformanSmahusUlagAG    | FK137 BostadsformanSmahusEjUlagSA
    //   FK043 BostadsformanEjSmahusUlagAG  | FK138 BostadsformanEjSmahusEjUlagSA
    if (emp.housingBenefit === 'smahus') {
      const code = exclSA ? '137' : '041'
      const elem = exclSA ? 'BostadsformanSmahusEjUlagSA' : 'BostadsformanSmahusUlagAG'
      lines.push(`        <gem:${elem} faltkod="${code}">1</gem:${elem}>`)
    } else if (emp.housingBenefit === 'ej_smahus') {
      const code = exclSA ? '138' : '043'
      const elem = exclSA ? 'BostadsformanEjSmahusEjUlagSA' : 'BostadsformanEjSmahusUlagAG'
      lines.push(`        <gem:${elem} faltkod="${code}">1</gem:${elem}>`)
    }

    // Övriga skattepliktiga förmåner AMOUNT: FK012 (UlagAG) or FK132 (ej UlagSA).
    // Includes meals, bike, wellness, "other", and the full housing krona-amount.
    if (emp.benefitOther && emp.benefitOther > 0) {
      const code = exclSA ? '132' : '012'
      const elem = exclSA ? 'SkatteplOvrigaFormanerEjUlagSA' : 'SkatteplOvrigaFormanerUlagAG'
      lines.push(`        <gem:${elem} faltkod="${code}">${formatAmount(emp.benefitOther)}</gem:${elem}>`)
    }

    // FK131: Ersättning till mottagare med F-skattsedel (ej underlag SA)
    if (emp.fSkattPayment && emp.fSkattPayment > 0) {
      lines.push(`        <gem:KontantErsattningEjUlagSA faltkod="131">${formatAmount(emp.fSkattPayment)}</gem:KontantErsattningEjUlagSA>`)
    }

    // FK048: FormanHarJusterats (any benefit value adjusted away from schablon)
    if (emp.benefitsAdjusted) {
      lines.push('        <gem:FormanHarJusterats faltkod="048">1</gem:FormanHarJusterats>')
    }

    // FK062 / FK063: Växa-stöd. Mutually exclusive: FK062 for employees
    // hired before 2024-05-01 (legacy "första anställda"-reglerna), FK063
    // for those hired 2024-05-01 and later (utvidgat växa-stöd).
    if (emp.vaxaStod === 'forsta_anstalld') {
      lines.push('        <gem:ForstaAnstalld faltkod="062">1</gem:ForstaAnstalld>')
    } else if (emp.vaxaStod === 'vaxa_stod') {
      lines.push('        <gem:VaxaStod faltkod="063">1</gem:VaxaStod>')
    }

    // Sjuk/VAB/föräldra-dagar flows elsewhere:
    //   - Per-employee sick days are reported to Försäkringskassan, not AGI.
    //     The company-level total goes in HU as TotalSjuklonekostnad (FK499).
    //   - VAB and parental leave are reported via the top-level
    //     <Franvarouppgift> section (FK820-827) as per-event date records,
    //     not as per-IU day counts. Not implemented in this generator yet.
    void emp.sickDays
    void emp.vabDays
    void emp.parentalDays

    lines.push('      </gem:IU>')
    lines.push('    </gem:Blankettinnehall>')
    lines.push('  </gem:Blankett>')
  }

  // ── Frånvarouppgift (per-event VAB/parental records, FK820-827) ───────
  // Skatteverket only accepts Frånvarouppgift from period 202501 onward.
  const periodAsNumber = company.periodYear * 100 + company.periodMonth
  if (periodAsNumber >= 202501) {
    for (const emp of employees) {
      if (!emp.absenceEvents || emp.absenceEvents.length === 0) continue
      // Tombstoned IU: skip absence records too. A removed individuppgift
      // can't be the parent of frånvarouppgifter for the period.
      if (emp.removed) continue

      let pnr: string
      try {
        pnr = decryptPersonnummer(emp.personnummer)
      } catch {
        // Already surfaced as a hard error in the IU loop above; skip silently here.
        continue
      }

      // Sort by date for stable XML output. The specifikationsnummer
      // itself comes from salary_absence_days.franvaro_specifikationsnummer
      // (assigned by DB trigger on INSERT and never re-numbered) so
      // corrections survive day deletions without index shifts.
      const sorted = [...emp.absenceEvents].sort((a, b) => {
        if (a.date < b.date) return -1
        if (a.date > b.date) return 1
        return a.specifikationsnummer - b.specifikationsnummer
      })

      sorted.forEach((event) => {
        const specNumber = event.specifikationsnummer
        const isVab = event.type === 'vab'
        const franvaroTyp = isVab ? 'TILLFALLIG_FORALDRAPENNING' : 'FORALDRAPENNING'
        const hoursElement = isVab ? 'FranvaroTimmarTFP' : 'FranvaroTimmarFP'
        const hoursFaltkod = isVab ? '825' : '827'

        lines.push('  <gem:Franvarouppgift>')
        // Element order follows the spec example file (SKV 4785 doc, section 4).
        lines.push(`    <gem:AgRegistreradId faltkod="201">${orgIdentitet}</gem:AgRegistreradId>`)
        lines.push(`    <gem:RedovisningsPeriod faltkod="006">${period}</gem:RedovisningsPeriod>`)
        lines.push(`    <gem:FranvaroDatum faltkod="821">${event.date}</gem:FranvaroDatum>`)
        lines.push(`    <gem:BetalningsmottagarId faltkod="215">${pnr}</gem:BetalningsmottagarId>`)
        lines.push(`    <gem:FranvaroSpecifikationsnummer faltkod="822">${specNumber}</gem:FranvaroSpecifikationsnummer>`)
        lines.push('    <gem:FranvaroChoice>')
        lines.push(`      <gem:FranvaroTyp faltkod="823">${franvaroTyp}</gem:FranvaroTyp>`)
        lines.push('    </gem:FranvaroChoice>')
        lines.push(`    <gem:${hoursElement} faltkod="${hoursFaltkod}">${formatHours(event.hours)}</gem:${hoursElement}>`)
        lines.push('  </gem:Franvarouppgift>')
      })
    }
  }

  lines.push('</Skatteverket>')

  const xml = lines.join('\n')
  assertPayloadSize(xml)
  return xml
}

/**
 * Build individuppgifter snapshot for storage in agi_declarations.individuppgifter
 * (jsonb). Sole purpose: stabilise FK570 (specifikationsnummer) across
 * corrections by recording the (personnummer → specificationNumber) binding
 * along with the headline totals that drive a re-issue decision.
 *
 * GDPR Art.25 (data minimisation): xml_content is the authoritative record
 * of what was filed. Storing the full per-benefit breakdown here would
 * duplicate sensitive financial detail with no incremental audit value, so
 * detailed benefit fields (car/fuel/housing/meals/other/fSkatt) are
 * deliberately omitted from the snapshot. Reconstruct them from
 * xml_content when needed.
 */
export function buildIndividuppgifterSnapshot(
  employees: AGIEmployeeData[]
): Record<string, unknown>[] {
  return employees.map(emp => {
    let pnr: string
    try {
      pnr = decryptPersonnummer(emp.personnummer)
    } catch {
      pnr = 'DECRYPTION_FAILED'
    }

    return {
      personnummer: pnr,
      specificationNumber: emp.specificationNumber,
      grossSalary: emp.grossSalary,
      taxWithheld: emp.taxWithheld,
      avgifterBasis: emp.avgifterBasis,
      removed: emp.removed ?? false,
    }
  })
}

// ============================================================
// Helpers
// ============================================================

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function formatAmount(amount: number): string {
  return Math.round(amount).toString()
}

/**
 * Format hours for FranvaroTimmarTFP/FP (FK825/827).
 * Spec range: 0.01 - 24.00, up to two decimals. Whole-hour values emit
 * without trailing zeros (e.g. 8 → "8") to match Skatteverket's example
 * file ("4" not "4.00"); fractional values keep their decimals.
 */
function formatHours(hours: number): string {
  const clamped = Math.max(0.01, Math.min(24, hours))
  const rounded = Math.round(clamped * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

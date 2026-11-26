import { decryptPersonnummer } from '../personnummer'
import { FilingIdentityError, isOrgNumberShaped, toRedovisare12 } from '@/lib/invariants/org-number'
import { truncateToWholeKronor } from '@/lib/money'
import { escapeXml } from '@/lib/xml/escape'
import type { EntityType } from '@/types'

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
 *   - HU totals: SummaSkatteavdr (497), SummaArbAvgSlf (487)
 *   - IU identity: BetalningsmottagarId (215), Specifikationsnummer (570)
 *   - IU amounts: KontantErsattningUlagAG (011), AvdrPrelSkatt (001)
 *   - Every HU and IU must include AgRegistreradId (201) + RedovisningsPeriod (006)
 *   - Every IU that is not a borttag carries FK001, as 0 when no tax was
 *     withheld (kontroll S_183)
 *
 * CRITICAL: FK570 (specifikationsnummer) must stay consistent per employee.
 * Corrections are detected by Skatteverket matching the same FK570.
 *
 * Frånvarouppgift emission is implemented per Skatteverket SKV 4785 + the
 * "Frånvarouppgift i samband med Arbetsgivardeklaration" technical doc:
 *   - One <gem:Franvarouppgift> per (employee, date, specifikationsnummer)
 *   - Sibling of <gem:Blankett>, top-level under <Skatteverket>
 *   - FranvaroTyp (FK823) is a direct child of Franvarouppgift:
 *     TILLFALLIG_FORALDRAPENNING for VAB, FORALDRAPENNING for parental
 *     leave. The komponent schema declares Franvarouppgift as an xs:all
 *     with no wrapper element; Skatteverket rejects a <FranvaroChoice>
 *     ("elementnamnet FranvaroChoice är inte giltigt", PH 217). The
 *     borttag flow (FK820) is not used.
 *   - Hours emitted via FranvaroTimmarTFP (FK825) for VAB or FranvaroTimmarFP
 *     (FK827) for parental. The procent variants (824/826) are not used:
 *     Accounted tracks hours, not percent.
 *   - FranvaroSpecifikationsnummer is persisted on salary_absence_days
 *     (column franvaro_specifikationsnummer; assigned by DB trigger on
 *     INSERT, never re-numbered). A Frånvarouppgift with the same
 *     (BetalningsmottagarId, FranvaroDatum, FranvaroSpecifikationsnummer,
 *     RedovisningsPeriod, AgRegistreradId) replaces the one saved in the
 *     draft (Bilaga Fältlista FK822), so a file uploaded again before
 *     signing keeps each day's number.
 *   - Only the period's first declaration carries Frånvarouppgift: a
 *     rättelse of a filed period carries none (ba_824, see generateAGIXml).
 *   - Periods before 202501 emit no Frånvarouppgift (Skatteverket rejects).
 *
 * Sick pay never reaches the AGI. Per-employee sick days go to
 * Försäkringskassan, and the company-level FK499 TotalSjuklonekostnad in HU
 * (the input for högkostnadsskyddet för sjuklönekostnader) is only valid up
 * to period 202406: the scheme was abolished 2024-07-01 and Skatteverket
 * rejects the whole file when the field appears in a later period.
 *
 * Växa-stöd never reaches the AGI either. FK062 ForstaAnstalld and FK063
 * VaxaStod have no valid period after 202512 (Teknisk beskrivning 1.1.18.2):
 * from 202601 the IU carries the full avgifter and the employer applies for
 * the refund separately (Lag 2025:1334, lib/salary/vaxa-stod.ts). Payroll
 * can only be calculated from 2026, so no declaration generated here has a
 * period in which the fields were valid.
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

/**
 * What an IU's cash and benefits are underlag for, which picks the field
 * family they are declared in (Bilaga Fältlista 1.1.18.1):
 *
 *  - 'arbetsgivaravgifter': the default. FK011 cash, FK012 övriga förmåner,
 *    FK013 bil, FK018 drivmedel, housing flags FK041/FK043.
 *  - 'egenavgifter': inkomst av tjänst for a mottagare med F-skatt. FK125
 *    cash ("Det kan till exempel vara inkomst av tjänst för mottagare med
 *    F-skatt"), FK126/FK127/FK128, housing flags FK123/FK124. The payer pays
 *    no arbetsgivaravgifter on it (SAL 2 kap. 5 §) but it is underlag for
 *    the recipient's egenavgifter (SAL 3 kap. 8 §).
 *  - 'ej_socialavgifter': pay that is no underlag for socialavgifter. FK131
 *    cash, FK132/FK133/FK134, housing flags FK137/FK138. The Fältlista text
 *    for FK131 names "ersättning under 1 000 kronor" (SAL 2 kap. 14 §), pay to
 *    an employee in another country's social insurance and pay to a juridisk
 *    person with A-skatt; Teknisk beskrivning 1.1.18.2 avsnitt 5.4 puts
 *    kontant ersättning "och eventuella förmåner, som totalt under året inte
 *    uppgår till 1 000 kronor" in these fields, with FK001 = 0 when no tax
 *    was withheld.
 *
 * Skatteverket computes the avgift from the UlagAG fields only (Bilaga
 * Summering och beräkningsregler, AeIU = FK011 + FK012 + FK013 - FK019 plus
 * the drivmedel term), so the family is what decides whether an amount
 * carries arbetsgivaravgifter, whatever FK487 says.
 */
export type AGIUnderlag = 'arbetsgivaravgifter' | 'egenavgifter' | 'ej_socialavgifter'

export interface AGIEmployeeData {
  personnummer: string       // Encrypted: decrypted for XML
  specificationNumber: number // FK570: MUST stay consistent per employee
  /** Cash for work: FK011 KontantErsattningUlagAG, FK125 for 'egenavgifter', FK131 for 'ej_socialavgifter' (see `underlag`). */
  grossSalary: number
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
   * FK048 FormanHarJusterats: the employer has a decision from Skatteverket
   * that adjusts a förmånsvärde for this payee (Fältlista 1.1.18.1 FK048;
   * SAL 2 kap. 10 b-10 c §§), and the IU carries the adjusted value. Not a
   * value the employer set below schablon on its own. Reflects
   * salary_run_employees.benefits_adjusted. Emitted only next to a benefit
   * amount kontroll S_017 accepts (FK012/FK013, FK126/FK127, FK132/FK133):
   * Skatteverket rejects FK048 without one.
   */
  benefitsAdjusted?: boolean
  /** The field family for cash and benefits. Defaults to 'arbetsgivaravgifter'. */
  underlag?: AGIUnderlag
  /**
   * FK013 SkatteplBilformanUlagAG (amount, BELOPP7), FK127 / FK133 per
   * underlag. Undefined when there is no car benefit. A number is declared
   * even at 0: a benefit the employee paid in full by nettolöneavdrag is
   * still reported, with the value 0 (Teknisk beskrivning 1.1.18.2 avsnitt
   * 5.3). The same holds for benefitOther.
   */
  benefitCar?: number
  benefitFuel?: number        // FK018 DrivmVidBilformanUlagAG (amount, BELOPP7), FK128 / FK134 per underlag
  /**
   * Housing benefit indicator. FK041 (smahus) and FK043 (ej_smahus) are
   * boolean KRYSS flags in the XSD: they just signal that this kind of
   * benefit was given. The AMOUNT must be folded into benefitOther
   * (FK012). Pass 'smahus' or 'ej_smahus' to set the flag; omit if no
   * housing benefit applies.
   */
  housingBenefit?: 'smahus' | 'ej_smahus'
  /**
   * FK012 SkatteplOvrigaFormanerUlagAG (amount, BELOPP10). Every taxable
   * benefit except bil (FK013) and drivmedel (FK018), summed: kost, bike,
   * wellness, "other", AND the full krona-amount for housing (FK041/FK043
   * carry only the flag). Kostförmån has no field of its own: Skatteverket's
   * XML schema (arbetsgivardeklaration_component_1.1.xsd) and Bilaga
   * Fältlista 1.1.18.1 define no KostformanUlagAG, so a file carrying one
   * fails schema validation (#81). FK126 / FK132 per underlag. Undefined
   * when there is no such benefit; a number is declared even at 0 (see
   * benefitCar).
   */
  benefitOther?: number
  /**
   * FK050 Bilersattning (KRYSS): skattefri bilersättning was paid this period
   * for trips in tjänsten with a private car or a förmånsbil. The tax-free
   * part is declared with this flag only, never with an amount; a payment
   * above the schablon is lön and its excess goes in the cash field
   * (Fältlista 1.1.18.1 FK050 and FK013). One flag per IU, whatever the
   * underlag family.
   */
  mileageAllowancePaid?: boolean
  /**
   * FK051 Traktamente (KRYSS): skattefritt traktamente was paid this period
   * for trips in tjänsten. Same rule as FK050: the tax-free part is the flag,
   * the excess over the schablon is lön (Fältlista 1.1.18.1 FK051).
   */
  traktamentePaid?: boolean
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
  orgNumber: string          // as stored: a 12-digit form keeps its exact century
  entityType: EntityType     // decides 16 or the owner's birth century (toRedovisare12)
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
  totalAvgifterAmount: number     // FK487 SummaArbAvgSlf (calculated avgifter across categories, less regionalSupport.deduction)
  avgifterByCategory: {
    standard?: { basis: number; amount: number }
    reduced65plus?: { basis: number; amount: number }
    youth?: { basis: number; amount: number }
  }
  /**
   * Regionalt stöd (lib/salary/regional-support.ts): FK471 underlag and
   * FK476 avdrag in HU. When present, totalAvgifterAmount is the category
   * amounts less the avdrag (Skatteverket's IK587, kontroll B_006).
   */
  regionalSupport?: { underlag: number; deduction: number } | null
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

/**
 * Where each required field is filled in, by the labels the settings pages
 * show. The kontaktperson for skatteärenden (Moms och skatt) is what the AGI
 * files with; telefon and e-post fall back to the company's own (Allmänt).
 */
const COMPANY_FIELD_PLACES: Readonly<Record<string, string>> = {
  organisationsnummer: 'organisationsnummer under Inställningar → Företagsuppgifter',
  'kontaktperson (namn)': 'namn under Inställningar → Moms och skatt → Kontaktperson för skatteärenden',
  telefon:
    'telefon under Inställningar → Moms och skatt → Kontaktperson för skatteärenden (eller Telefon under Inställningar → Företagsuppgifter)',
  'e-post':
    'e-post under Inställningar → Moms och skatt → Kontaktperson för skatteärenden (eller E-post under Inställningar → Företagsuppgifter)',
}

/**
 * The company data an AGI cannot be filed without, as the error naming each
 * missing field and where to fill it in; null when nothing is missing.
 * Generation throws it; the staging doors answer it before anyone is asked
 * to approve a generation that would fail (crm#1435).
 */
export function findMissingCompanyData(
  company: Pick<AGICompanyData, 'orgNumber' | 'entityType' | 'contactName' | 'contactPhone' | 'contactEmail'>,
): AGIIncompleteDataError | null {
  const missing: string[] = []
  // Shared rule (lib/invariants/org-number.ts), not a local digit-strip: the
  // previous `replace(/\D/g, '')` also swallowed letters, so a field holding
  // stray text still measured 10 digits and passed.
  if (!isOrgNumberShaped(company.orgNumber)) missing.push('organisationsnummer')
  if (!company.contactName.trim()) missing.push('kontaktperson (namn)')
  if (!company.contactPhone.trim()) missing.push('telefon')
  if (!company.contactEmail.trim()) missing.push('e-post')

  if (missing.length === 0) return identitetRefusal(company.orgNumber, company.entityType)
  return new AGIIncompleteDataError(
    `AGI kan inte genereras, följande uppgifter saknas: ${missing.join(', ')}. ` +
      `Fyll i ${missing.map((field) => COMPANY_FIELD_PLACES[field]).join('; ')}.`,
    missing
  )
}

function assertRequiredCompanyData(company: AGICompanyData): void {
  const missing = findMissingCompanyData(company)
  if (missing) throw missing
}

/** What toIdentitet would refuse this number with, or null when it passes. */
function identitetRefusal(orgNumber: string, entityType: EntityType): AGIIncompleteDataError | null {
  try {
    toIdentitet(orgNumber, entityType)
    return null
  } catch (err) {
    if (err instanceof AGIIncompleteDataError) return err
    throw err
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
 * The company's identity in Skatteverket's 12-character IDENTITET format,
 * required by the AGI schema for Avsandare/Organisationsnummer, AgRegistreradId
 * and Arendeagare: toRedovisare12, the conversion every filing shares, so an
 * enskild firma stored in 10-digit form takes the owner's birth century here as
 * it does on the VAT return.
 *
 * Throws AGIIncompleteDataError when the conversion refuses the number or the
 * result cannot match the IDENTITET pattern: this catches bogus test data (e.g.
 * "420694-2069") before the file reaches Skatteverket. The refusal's text is the
 * shared one, with its way out: a valid number is locked at the settings door.
 */
function toIdentitet(raw: string, entityType: EntityType): string {
  try {
    const candidate = toRedovisare12(raw, entityType)
    if (IDENTITET_PATTERN.test(candidate)) return candidate
    throw new FilingIdentityError()
  } catch (err) {
    if (!(err instanceof FilingIdentityError)) throw err
    throw new AGIIncompleteDataError(err.message, ['organisationsnummer'])
  }
}

/** [faltkod, XML element] of one IU field. */
type AGIField = readonly [string, string]

interface AGIUnderlagFields {
  cash: AGIField
  other: AGIField
  car: AGIField
  fuel: AGIField
  housingSmahus: AGIField
  housingEjSmahus: AGIField
}

/** Each underlag's field family, per Bilaga Fältlista 1.1.18.1 (see AGIUnderlag). */
const UNDERLAG_FIELDS: Record<AGIUnderlag, AGIUnderlagFields> = {
  arbetsgivaravgifter: {
    cash: ['011', 'KontantErsattningUlagAG'],
    other: ['012', 'SkatteplOvrigaFormanerUlagAG'],
    car: ['013', 'SkatteplBilformanUlagAG'],
    fuel: ['018', 'DrivmVidBilformanUlagAG'],
    housingSmahus: ['041', 'BostadsformanSmahusUlagAG'],
    housingEjSmahus: ['043', 'BostadsformanEjSmahusUlagAG'],
  },
  egenavgifter: {
    cash: ['125', 'KontantErsattningUlagEA'],
    other: ['126', 'SkatteplOvrigaFormanerUlagEA'],
    car: ['127', 'SkatteplBilformanUlagEA'],
    fuel: ['128', 'DrivmVidBilformanUlagEA'],
    housingSmahus: ['123', 'BostadsformanSmahusUlagEA'],
    housingEjSmahus: ['124', 'BostadsformanEjSmahusUlagEA'],
  },
  ej_socialavgifter: {
    cash: ['131', 'KontantErsattningEjUlagSA'],
    other: ['132', 'SkatteplOvrigaFormanerEjUlagSA'],
    car: ['133', 'SkatteplBilformanEjUlagSA'],
    fuel: ['134', 'DrivmVidBilformanEjUlagSA'],
    housingSmahus: ['137', 'BostadsformanSmahusEjUlagSA'],
    housingEjSmahus: ['138', 'BostadsformanEjSmahusEjUlagSA'],
  },
}

/**
 * Generate AGI XML for a period.
 *
 * `firstDeclarationFiled`: the period's first declaration is already filed,
 * so this one is a rättelse, and it carries no Frånvarouppgift.
 * "Frånvarouppgifter får inte finnas för RedovisningsPeriod, FK006, där
 * första deklaration redan har skickats in" (Skatteverket, Bilaga Kontroller
 * 1.1.18.1, ba_824) is a Bearbetningskontroll: a file that breaks it is not
 * uploaded at all (Teknisk beskrivning 1.1.18.2, 12.5.1). The uppgifter went
 * in with the first declaration, and changed or added ones cannot be sent
 * with a rättelse (TB 1.1.18.2, 3 and 9.3).
 *
 * Throws AGIIncompleteDataError if required fields (orgNumber, contact info)
 * are missing: we never emit partial XML that Skatteverket would reject.
 */
export function generateAGIXml(
  company: AGICompanyData,
  employees: AGIEmployeeData[],
  totals: AGITotals,
  firstDeclarationFiled: boolean = false
): string {
  assertRequiredCompanyData(company)
  assertRequiredPeriod(company.periodYear, company.periodMonth)

  const orgIdentitet = toIdentitet(company.orgNumber, company.entityType)
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

  // FK471/FK476: regionalt stöd, both or neither (kontroll S_106/S_108).
  // FK487 above already carries the avgift after the avdrag (IK587, B_006).
  if (totals.regionalSupport && totals.regionalSupport.deduction > 0) {
    lines.push(`        <gem:UlagRegionaltStod faltkod="471">${formatAmount(totals.regionalSupport.underlag)}</gem:UlagRegionaltStod>`)
    lines.push(`        <gem:AvdragRegionaltStod faltkod="476">${formatAmount(totals.regionalSupport.deduction)}</gem:AvdragRegionaltStod>`)
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

    const fields = UNDERLAG_FIELDS[emp.underlag ?? 'arbetsgivaravgifter']
    const emit = ([code, elem]: AGIField, value: string) =>
      lines.push(`        <gem:${elem} faltkod="${code}">${value}</gem:${elem}>`)

    // Cash for work: FK011 (underlag arbetsgivaravgifter), FK125 (underlag
    // egenavgifter) or FK131 (ej underlag), never two for the same payment.
    if (emp.grossSalary > 0) {
      emit(fields.cash, formatAmount(emp.grossSalary))
    }

    // FK001: Avdragen preliminärskatt, on every IU that is not a borttag,
    // with 0 when no tax was withheld (jämkning to 0 %, a wage below the
    // tax table threshold, an F-skatt payee, a benefit-only IU). Kontroll
    // S_183 rejects an IU without FK205 unless one of the seven skattefält
    // (FK001, FK274, FK275, FK094, FK114, FK253, FK276) has a value, and
    // this generator emits none of the other six; S_175 allows at most one
    // (Bilaga Kontroller 1.1.18.1). Teknisk beskrivning 1.1.18.2, 8.3.2:
    // "Om ett beloppsfält ska användas men något skatteavdrag inte gjorts,
    // ska noll (0) redovisas i beloppsfältet." (crm#1265)
    lines.push(`        <gem:AvdrPrelSkatt faltkod="001">${formatAmount(emp.taxWithheld)}</gem:AvdrPrelSkatt>`)

    // Car benefit AMOUNT: FK013 (UlagAG), FK127 (UlagEA) or FK133 (ej UlagSA).
    // Declared at 0 too when the employee paid the whole benefit by
    // nettolöneavdrag: "Har den anställda betalat hela förmånen genom
    // nettolöneavdrag så att värdet blir noll (0) så ska det ändå redovisas"
    // (Teknisk beskrivning 1.1.18.2 avsnitt 5.3).
    const hasCar = typeof emp.benefitCar === 'number' && emp.benefitCar >= 0
    if (hasCar) {
      emit(fields.car, formatAmount(emp.benefitCar as number))
    }

    // Fuel for car benefit AMOUNT: FK018 (UlagAG), FK128 (UlagEA) or FK134 (ej UlagSA)
    if (emp.benefitFuel && emp.benefitFuel > 0) {
      emit(fields.fuel, formatAmount(emp.benefitFuel))
    }

    // Housing benefit FLAGS (KRYSS, no amount on this element). The
    // krona-amount belongs in benefitOther (FK012/FK126/FK132; kontroll
    // S_156/S_157 require it next to the ej-UlagSA and UlagEA flags).
    //   FK041 BostadsformanSmahusUlagAG    | FK123 ...UlagEA | FK137 BostadsformanSmahusEjUlagSA
    //   FK043 BostadsformanEjSmahusUlagAG  | FK124 ...UlagEA | FK138 BostadsformanEjSmahusEjUlagSA
    if (emp.housingBenefit === 'smahus') {
      emit(fields.housingSmahus, '1')
    } else if (emp.housingBenefit === 'ej_smahus') {
      emit(fields.housingEjSmahus, '1')
    }

    // Övriga skattepliktiga förmåner AMOUNT: FK012 (UlagAG), FK126 (UlagEA)
    // or FK132 (ej UlagSA). Includes meals, bike, wellness, "other", and the
    // full housing krona-amount. Declared at 0 too, like the car benefit.
    const hasOther = typeof emp.benefitOther === 'number' && emp.benefitOther >= 0
    if (hasOther) {
      emit(fields.other, formatAmount(emp.benefitOther as number))
    }

    // FK048 FormanHarJusterats: kontroll S_017 (Bilaga Kontroller 1.1.18.1)
    // rejects it unless FK012, FK013, FK132, FK133, FK126 or FK127 is on the
    // IU, i.e. an övriga-förmåner or bilförmån amount in any family. A flag
    // with no such benefit this month has nothing to qualify and is dropped
    // rather than failing the whole file (#82).
    if (emp.benefitsAdjusted && (hasOther || hasCar)) {
      lines.push('        <gem:FormanHarJusterats faltkod="048">1</gem:FormanHarJusterats>')
    }

    // FK050 Bilersattning / FK051 Traktamente (KRYSS, "1 eller true om
    // ikryssad, annars utelämnas fältet"): the only trace a tax-free
    // milersättning or traktamente leaves in the AGI. Both are in kontroll
    // S_167's list, so either flag alone makes a valid IU.
    if (emp.mileageAllowancePaid) {
      lines.push('        <gem:Bilersattning faltkod="050">1</gem:Bilersattning>')
    }
    if (emp.traktamentePaid) {
      lines.push('        <gem:Traktamente faltkod="051">1</gem:Traktamente>')
    }

    // Sjuk/VAB/föräldra-dagar flows elsewhere:
    //   - Sick days are reported to Försäkringskassan, not AGI. FK499
    //     TotalSjuklonekostnad is retired since period 202407 (header comment).
    //   - VAB and parental leave are reported via the top-level
    //     <Franvarouppgift> section (FK820-827) as per-event date records,
    //     not as per-IU day counts. Not implemented in this generator yet.
    lines.push('      </gem:IU>')
    lines.push('    </gem:Blankettinnehall>')
    lines.push('  </gem:Blankett>')
  }

  // ── Frånvarouppgift (per-event VAB/parental records, FK820-827) ───────
  // Skatteverket only accepts Frånvarouppgift from period 202501 onward
  // (ba_820), and only with the period's first declaration (ba_824).
  const periodAsNumber = company.periodYear * 100 + company.periodMonth
  if (periodAsNumber >= 202501 && !firstDeclarationFiled) {
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
        // Franvarouppgift is an xs:all in the komponent schema 1.1, so every
        // field is a direct child (no wrapper element). The order follows
        // Skatteverket's example files 17 and 18 (Bilaga Exempelfiler).
        lines.push(`    <gem:AgRegistreradId faltkod="201">${orgIdentitet}</gem:AgRegistreradId>`)
        lines.push(`    <gem:RedovisningsPeriod faltkod="006">${period}</gem:RedovisningsPeriod>`)
        lines.push(`    <gem:FranvaroDatum faltkod="821">${event.date}</gem:FranvaroDatum>`)
        lines.push(`    <gem:BetalningsmottagarId faltkod="215">${pnr}</gem:BetalningsmottagarId>`)
        lines.push(`    <gem:FranvaroSpecifikationsnummer faltkod="822">${specNumber}</gem:FranvaroSpecifikationsnummer>`)
        lines.push(`    <gem:FranvaroTyp faltkod="823">${franvaroTyp}</gem:FranvaroTyp>`)
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

/** One IU in agi_declarations.individuppgifter: no personnummer, in clear or sealed. */
export interface AGIIndividuppgiftSnapshot {
  specificationNumber: number
  grossSalary: number
  taxWithheld: number
  avgifterBasis: number
  removed: boolean
}

/**
 * Build individuppgifter snapshot for storage in agi_declarations.individuppgifter
 * (jsonb): per IU, its FK570 specifikationsnummer, the headline amounts and
 * the FK205 borttag flag. FK570 stays stable across corrections through
 * employees.specification_number.
 *
 * GDPR Art.25 (data minimisation): xml_content is the authoritative record
 * of what was filed, so the snapshot holds no personnummer and no
 * per-benefit breakdown (car/fuel/housing/meals/other and their underlag
 * family). Reconstruct them from xml_content when needed.
 */
export function buildIndividuppgifterSnapshot(
  employees: AGIEmployeeData[]
): AGIIndividuppgiftSnapshot[] {
  // Typed on the callback, so a key added back (a personnummer) fails to compile.
  return employees.map((emp): AGIIndividuppgiftSnapshot => ({
    specificationNumber: emp.specificationNumber,
    grossSalary: emp.grossSalary,
    taxWithheld: emp.taxWithheld,
    avgifterBasis: emp.avgifterBasis,
    removed: emp.removed ?? false,
  }))
}

// ============================================================
// Helpers
// ============================================================

// AGI amounts are stated in whole kronor with the öre dropped (öretal
// bortfaller, SFF 2011:1261 22 kap. 1 §): truncation, never rounding.
// Math.round here would declare 16 074 kr for an underlag-computed
// 16 073,84 kr while Skatteverket draws 16 073 kr from the skattekonto.
function formatAmount(amount: number): string {
  return truncateToWholeKronor(amount).toString()
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

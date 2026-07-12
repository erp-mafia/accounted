/**
 * Pre-flight validation of an iXBRL årsredovisning: local mirror of the
 * Bolagsverket `kontrollera` service (GUIDE.md Appendix E codes).
 *
 * Runs on the assembled IxbrlArsredovisningInput BEFORE generation/upload so
 * the wizard can surface actionable issues without an API round-trip, and so
 * self-hosted installs without Bolagsverket credentials still get the checks.
 *
 * Severity:
 *   - 'error'  → Bolagsverket would reject or föreläggande is near-certain;
 *                the wizard blocks Skicka in.
 *   - 'warn'   → kontrollera warn-level utfall; filing is allowed
 *                (GUIDE §4.2.2) but the user should review.
 */

import type { IxbrlArsredovisningInput } from '../types'

export interface PreflightIssue {
  /** Bolagsverket kontrollera code where one exists, else our own ACC-xxx. */
  code: string
  severity: 'error' | 'warn'
  message: string
}

export interface PreflightResult {
  issues: PreflightIssue[]
  errors: PreflightIssue[]
  warnings: PreflightIssue[]
  ok: boolean
}

type Rule = (input: IxbrlArsredovisningInput, today: string) => PreflightIssue | null

const issue = (code: string, severity: 'error' | 'warn', message: string): PreflightIssue => ({
  code,
  severity,
  message,
})

function monthsBetween(startIso: string, endIso: string): number {
  const start = new Date(`${startIso}T00:00:00Z`)
  const end = new Date(`${endIso}T00:00:00Z`)
  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth()) +
    (end.getUTCDate() >= start.getUTCDate() ? 0 : -1)
  )
}

const RULES: Rule[] = [
  // ---- completeness -------------------------------------------------------
  (input) =>
    input.company.name.trim().length === 0
      ? issue('1020', 'error', 'Företagsnamnet saknas i årsredovisningen.')
      : null,
  (input) =>
    /^\d{6}-?\d{4}$/.test(input.company.orgNumber.trim())
      ? null
      : issue('1035', 'error', `Organisationsnumret "${input.company.orgNumber}" är inte giltigt (förväntat format NNNNNN-NNNN).`),
  (input) =>
    input.forvaltningsberattelse.allmantOmVerksamheten.trim().length === 0
      ? issue('1051', 'error', 'Förvaltningsberättelsen saknas (Allmänt om verksamheten är tom).')
      : null,
  (input) => {
    const hasRr =
      Object.values(input.rr).some((a) => a.current !== 0) ||
      input.totals.aretsResultat.current !== 0
    return hasRr
      ? null
      : issue('1060', 'warn', 'Resultaträkningen verkar sakna belopp: kontrollera att räkenskapsåret innehåller bokförda transaktioner.')
  },
  (input) => {
    const hasBr = input.totals.tillgangar.current !== 0
    return hasBr
      ? null
      : issue('1064', 'warn', 'Balansräkningen verkar sakna belopp (Summa tillgångar är 0).')
  },
  (input) =>
    input.underskrifter.signers.length === 0
      ? issue('1107', 'error', 'Underskrifter saknas: årsredovisningen måste skrivas under av styrelsen (och ev. VD).')
      : null,
  (input) =>
    input.underskrifter.signers.some(
      (signer) => !signer.firstName.trim() || !signer.lastName.trim(),
    )
      ? issue('1201', 'error', 'Det saknas för- eller efternamn på den eller de som skrivit under årsredovisningen.')
      : null,
  (input) =>
    input.underskrifter.signers.some((signer) => !signer.signedDate)
      ? issue('1214', 'error', 'Datum för underskrifter saknas: alla underskrifter måste ha ett datum.')
      : null,
  (input) =>
    !input.faststallelseintyg.signerFirstName.trim() ||
    !input.faststallelseintyg.signerLastName.trim()
      ? issue('1169', 'error', 'Namnförtydligandet saknas i fastställelseintyget (välj undertecknare).')
      : null,
  (input) =>
    input.faststallelseintyg.arsstammaDatum
      ? null
      : issue('1103', 'error', 'Datum för årsstämman saknas i fastställelseintyget.'),

  // ---- date ordering ------------------------------------------------------
  (input, today) =>
    input.period.end >= today
      ? issue('1015', 'error', `Räkenskapsårets sista dag (${input.period.end}) har inte passerats ännu.`)
      : null,
  (input) =>
    monthsBetween(input.period.start, input.period.end) >= 18
      ? issue('1046', 'error', `Räkenskapsåret ${input.period.start}: ${input.period.end} är längre än 18 månader.`)
      : null,
  (input) =>
    input.faststallelseintyg.arsstammaDatum &&
    input.faststallelseintyg.arsstammaDatum <= input.period.end
      ? issue('1101', 'error', `Datum för årsstämman (${input.faststallelseintyg.arsstammaDatum}) får inte vara tidigare än eller samma som räkenskapsårets sista dag (${input.period.end}).`)
      : null,
  (input, today) =>
    input.faststallelseintyg.arsstammaDatum !== null &&
    input.faststallelseintyg.arsstammaDatum > today
      ? issue('1178', 'error', `Datum för årsstämman (${input.faststallelseintyg.arsstammaDatum}) får inte vara senare än dagens datum: håll årsstämman innan inlämning.`)
      : null,
  (input) => {
    const bad = input.underskrifter.signers.find(
      (signer) => signer.signedDate && signer.signedDate <= input.period.end,
    )
    return bad
      ? issue('1114', 'error', `Datum för underskrift (${bad.signedDate}) får inte vara tidigare än eller samma som räkenskapsårets sista dag (${input.period.end}).`)
      : null
  },
  (input) => {
    const agm = input.faststallelseintyg.arsstammaDatum
    if (!agm) return null
    const late = input.underskrifter.signers.find(
      (signer) => signer.signedDate && signer.signedDate > agm,
    )
    return late
      ? issue('1183', 'error', `Datum för årsstämman (${agm}) är tidigare än styrelsens underskrift (${late.signedDate}).`)
      : null
  },
  (input) => {
    const datering = input.underskrifter.dateringsdatum
    if (!datering) return null
    const earliest = input.underskrifter.signers.reduce<string | null>(
      (min, signer) =>
        signer.signedDate !== null && (min === null || signer.signedDate < min)
          ? signer.signedDate
          : min,
      null,
    )
    return earliest && datering > earliest
      ? issue('1232', 'warn', `Datum för årsredovisningen (${datering}) är senare än styrelsens tidigaste underskrift (${earliest}).`)
      : null
  },
  (input) =>
    input.faststallelseintyg.arsstammaDatum &&
    input.faststallelseintyg.genereratDatum < input.faststallelseintyg.arsstammaDatum
      ? issue('1165', 'warn', 'Datum för underskrift av fastställelseintyget sätts till genereringsdagen, som ligger före årsstämman: Bolagsverket skriver över datumet vid signering.')
      : null,

  // ---- balance checks -----------------------------------------------------
  // Exact comparisons: Bolagsverket compares the tagged totals exactly, and
  // the mapper already absorbs legitimate ±1 kr rounding residuals.
  (input) => {
    const assets = input.totals.tillgangar.current
    const eqLiab = input.totals.egetKapitalSkulder.current
    return assets !== eqLiab
      ? issue('3005', 'error', `"Summa tillgångar" (${assets} kr) och "Summa eget kapital och skulder" (${eqLiab} kr) stämmer inte överens.`)
      : null
  },
  (input) => {
    if (input.isFirstFiscalYear) return null
    const prev = input.totals.tillgangar.previous
    return prev === null
      ? issue('3006', 'error', 'Jämförelsesiffror saknas i balansräkningen. De behövs om det inte är företagets första räkenskapsår.')
      : null
  },
  (input) => {
    if (input.isFirstFiscalYear) return null
    const prev = input.totals.aretsResultat.previous
    return prev === null
      ? issue('3007', 'error', 'Jämförelsesiffror saknas i resultaträkningen. De behövs om det inte är företagets första räkenskapsår.')
      : null
  },
  (input) => {
    const rrResult = input.totals.aretsResultat.current
    const brResult = input.br['AretsResultatEgetKapital']?.current ?? 0
    return rrResult !== brResult
      ? issue('ACC-2099', 'error', `Årets resultat enligt resultaträkningen (${rrResult} kr) stämmer inte med eget kapital-posten Årets resultat (${brResult} kr): kör bokslutet (resultatdisposition) innan inlämning.`)
      : null
  },

  // ---- resultatdisposition ------------------------------------------------
  (input) => {
    const rd = input.forvaltningsberattelse.resultatdisposition
    return Math.abs(rd.utdelning + rd.balanserasINyRakning - rd.summa) > 1
      ? issue('ACC-DISP', 'error', `Resultatdispositionen går inte ihop: utdelning (${rd.utdelning}) + balanseras (${rd.balanserasINyRakning}) ≠ summa (${rd.summa}).`)
      : null
  },
  (input) => {
    const rd = input.forvaltningsberattelse.resultatdisposition
    return rd.summa < 0 && rd.utdelning > 0
      ? issue('ACC-UTD', 'error', 'Utdelning kan inte föreslås när fritt eget kapital är negativt.')
      : null
  },
]

export function runPreflightChecks(
  input: IxbrlArsredovisningInput,
  todayIso?: string,
): PreflightResult {
  const today = todayIso ?? new Date().toISOString().slice(0, 10)
  const issues: PreflightIssue[] = []
  for (const rule of RULES) {
    const result = rule(input, today)
    if (result) issues.push(result)
  }
  // Mapper warnings (unmapped accounts, reclassifications) ride along as warn.
  for (const warning of input.warnings) {
    issues.push(issue('ACC-WARN', 'warn', warning))
  }
  const errors = issues.filter((item) => item.severity === 'error')
  const warnings = issues.filter((item) => item.severity === 'warn')
  return { issues, errors, warnings, ok: errors.length === 0 }
}

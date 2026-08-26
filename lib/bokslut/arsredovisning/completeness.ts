import type { ArsredovisningData } from './types'
import type { IxbrlArsredovisningInput } from '@/lib/bokslut/ixbrl/types'
import { buildBrRows, buildRrRows } from './statement-rows'
import type {
  AnnualReportComplianceIssue,
  AnnualReportDisclosureState,
  AnnualReportEligibilityResult,
  AnnualReportProfile,
  AnnualReportValidationResult,
  AnnualReportValidationStage,
} from './compliance-types'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const datePart = value.slice(0, 10)
  if (!ISO_DATE.test(datePart)) return null
  const parsed = new Date(`${datePart}T00:00:00.000Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== datePart
    ? null
    : parsed
}

function addCalendarMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + months
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)))
}

function push(
  issues: AnnualReportComplianceIssue[],
  code: string,
  severity: AnnualReportComplianceIssue['severity'],
  section: AnnualReportComplianceIssue['section'],
  message: string,
  remediation?: string,
): void {
  issues.push({ code, severity, section, message, remediation })
}

function statementRowsEqual(
  left: ArsredovisningData['resultatrakning'],
  right: ArsredovisningData['resultatrakning'],
): boolean {
  return left.length === right.length && left.every((row, index) => {
    const other = right[index]
    return (
      row.label === other.label &&
      row.semantic_key === other.semantic_key &&
      row.current === other.current &&
      row.previous === other.previous &&
      Boolean(row.is_total) === Boolean(other.is_total) &&
      Boolean(row.is_heading) === Boolean(other.is_heading) &&
      (row.indent ?? 0) === (other.indent ?? 0)
    )
  })
}

export function validateStatementIntegrity(
  report: ArsredovisningData,
  ixbrl: IxbrlArsredovisningInput | null = null,
): AnnualReportComplianceIssue[] {
  const issues: AnnualReportComplianceIssue[] = []
  if (
    Math.round(report.balansrakning.total_assets * 100) !==
    Math.round(report.balansrakning.total_equity_liabilities * 100)
  ) {
    push(
      issues,
      'AR-BALANCE-MISMATCH',
      'error',
      'statements',
      'Balansräkningen balanserar inte i årsredovisningen.',
    )
  }

  const incomeStatementResult = (
    report.resultatrakning.find(
      (row) => row.semantic_key === 'income_statement_result' && row.current !== null,
    )
    ?? report.resultatrakning.find(
      (row) => row.label === 'Årets resultat' && row.current !== null,
    )
  )?.current ?? undefined
  const visibleBalanceSheetResult = (
    report.balansrakning.equity_liabilities.find(
      (row) => row.semantic_key === 'balance_sheet_current_year_result' && row.current !== null,
    )
    ?? report.balansrakning.equity_liabilities.find(
      (row) => row.label === 'Årets resultat' && row.current !== null,
    )
  )?.current ?? undefined
  const dispositionResult =
    report.forvaltningsberattelse.resultatdisposition_amounts.current_year_result
  if (incomeStatementResult === undefined || visibleBalanceSheetResult === undefined) {
    push(
      issues,
      'AR-RESULT-MISSING',
      'error',
      'statements',
      'Resultat- eller balansräkningen saknar raden Årets resultat.',
    )
  } else if (
    Math.round(incomeStatementResult * 100) !== Math.round(visibleBalanceSheetResult * 100) ||
    Math.round(incomeStatementResult * 100) !== Math.round(dispositionResult * 100)
  ) {
    push(
      issues,
      'AR-RESULT-MISMATCH',
      'error',
      'statements',
      'Årets resultat i resultaträkningen stämmer inte med årets resultat i balansräkningen.',
      'Kontrollera att årsredovisningen innehåller bokslutsdispositioner och skatt före resultatstängningen.',
    )
  }

  if (
    report.resultatrakning.length === 0 ||
    report.balansrakning.assets.length === 0 ||
    report.balansrakning.equity_liabilities.length === 0
  ) {
    push(
      issues,
      'AR-STATEMENTS-EMPTY',
      'error',
      'statements',
      'Resultat- eller balansräkningen saknar rader.',
    )
  }

  if (ixbrl) {
    const ixbrlMapping = { rr: ixbrl.rr, br: ixbrl.br, totals: ixbrl.totals }
    const ixbrlIncomeRows = buildRrRows(ixbrlMapping)
    const ixbrlBalanceRows = buildBrRows(ixbrlMapping)
    if (
      !statementRowsEqual(report.resultatrakning, ixbrlIncomeRows) ||
      !statementRowsEqual(report.balansrakning.assets, ixbrlBalanceRows.assets) ||
      !statementRowsEqual(
        report.balansrakning.equity_liabilities,
        ixbrlBalanceRows.equityLiabilities,
      )
    ) {
      push(
        issues,
        'AR-IXBRL-STATEMENT-MISMATCH',
        'error',
        'statements',
        'Beloppen i PDF-underlaget och iXBRL-underlaget stämmer inte överens.',
        'Skapa om årsredovisningen från ett oförändrat bokslut.',
      )
    }
  }
  return issues
}

export interface ValidateAnnualReportInput {
  report: ArsredovisningData
  profile: AnnualReportProfile
  disclosures: AnnualReportDisclosureState
  eligibility: AnnualReportEligibilityResult
  stage: AnnualReportValidationStage
  todayIso?: string
}

export function validateAnnualReportCompleteness(
  input: ValidateAnnualReportInput,
): AnnualReportValidationResult {
  const { report, profile, disclosures, eligibility, stage } = input
  const issues: AnnualReportComplianceIssue[] = [...eligibility.issues]
  const today = parseIsoDate(input.todayIso ?? new Date().toISOString())
  const periodStart = parseIsoDate(report.fiscal_period.period_start)
  const periodEnd = parseIsoDate(report.fiscal_period.period_end)

  if (!periodStart || !periodEnd || periodStart > periodEnd) {
    push(
      issues,
      'AR-FISCAL-PERIOD-INVALID',
      'error',
      'company',
      'Räkenskapsårets start- och slutdatum är ogiltiga.',
      'Korrigera räkenskapsåret i företagsinställningarna.',
    )
  } else if (periodEnd >= addCalendarMonths(periodStart, 18)) {
    push(
      issues,
      'AR-FISCAL-PERIOD-TOO-LONG',
      'error',
      'company',
      'Räkenskapsåret är längre än 18 månader.',
      'Korrigera räkenskapsåret innan årsredovisningen upprättas.',
    )
  }

  if (report.accounting_framework === 'k2' && !profile.k2_assessment_confirmed_at) {
    push(
      issues,
      'AR-K2-ASSESSMENT-UNCONFIRMED',
      'error',
      'scope',
      'Bedömningen att bolaget får använda K2 är inte uttryckligen bekräftad.',
      'Besvara frågorna om omfattning och regelverk och spara bedömningen.',
    )
  }

  if (!report.company.name.trim()) {
    push(issues, 'AR-COMPANY-NAME', 'error', 'company', 'Företagsnamn saknas.')
  }
  if (!normalizeOrgNumber(report.company.org_number)) {
    push(
      issues,
      'AR-COMPANY-ORGNR',
      'error',
      'company',
      'Ett giltigt organisationsnummer saknas.',
      'Komplettera företagsinställningarna.',
    )
  }
  if (!report.company.city?.trim()) {
    push(
      issues,
      'AR-COMPANY-CITY',
      'error',
      'company',
      'Bolagets registrerade säte saknas.',
      'Komplettera företagsinställningarna eller hämta grunduppgifter från Bolagsverket.',
    )
  }
  if (!report.forvaltningsberattelse.description.trim()) {
    push(issues, 'AR-MANAGEMENT-DESCRIPTION', 'error', 'management_report', 'Verksamhetsbeskrivning saknas.')
  }
  if (!report.forvaltningsberattelse.important_events.trim()) {
    push(issues, 'AR-MANAGEMENT-EVENTS', 'error', 'management_report', 'Uppgift om väsentliga händelser saknas.')
  }
  if (!report.forvaltningsberattelse.resultatdisposition.trim()) {
    push(issues, 'AR-MANAGEMENT-DISPOSITION', 'error', 'management_report', 'Styrelsens förslag till resultatdisposition saknas.')
  }
  const disposition = report.forvaltningsberattelse.resultatdisposition_amounts
  const proposedDividendCents = Math.round(disposition.proposed_dividend * 100)
  const distributableEquityCents = Math.round(disposition.total * 100)
  if (proposedDividendCents > 0 && proposedDividendCents > distributableEquityCents) {
    push(
      issues,
      'AR-DIVIDEND-EXCEEDS-EQUITY',
      'error',
      'management_report',
      'Föreslagen utdelning överstiger det fria egna kapitalet.',
      'Sänk utdelningen och kontrollera resultatdispositionen.',
    )
  }
  if (disposition.proposed_dividend > 0 && profile.dividend_prudence_confirmed !== true) {
    push(
      issues,
      'AR-DIVIDEND-PRUDENCE-UNCONFIRMED',
      'error',
      'management_report',
      'Försiktighetsregeln för föreslagen utdelning är inte bekräftad.',
      'Bedöm bolagets kapitalbehov, likviditet, ställning och risker enligt ABL 17 kap. 3 §.',
    )
  }
  if (!profile.narrative_confirmed_at) {
    push(
      issues,
      'AR-MANAGEMENT-UNCONFIRMED',
      'error',
      'management_report',
      'Förvaltningsberättelsens texter är inte uttryckligen granskade.',
      'Granska texterna och markera dem som bekräftade.',
    )
  }

  issues.push(...validateStatementIntegrity(report))
  if (
    report.previous_period &&
    (report.balansrakning.total_assets_previous === null ||
      report.balansrakning.total_equity_liabilities_previous === null)
  ) {
    push(
      issues,
      'AR-COMPARATIVE-MISSING',
      'error',
      'statements',
      'Jämförelsetal saknas trots att ett föregående räkenskapsår finns.',
    )
  }
  if (report.noter.length === 0) {
    push(issues, 'AR-NOTES-EMPTY', 'error', 'notes', 'Årsredovisningen saknar noter.')
  }

  // Each confirmation is a checkbox under "Lagstadgade upplysningar" on the
  // årsredovisning page, persisted by "Spara texten". Say so: a bare "är
  // inte bekräftad" left a real user hunting for the switch (2026-08-20).
  const disclosureChecks: Array<[boolean, string, string, string]> = [
    [
      disclosures.long_term_debt_over_five_years_confirmed,
      'AR-NOTE-LONG-DEBT-UNCONFIRMED',
      'Uppgiften om långfristiga skulder som förfaller efter mer än fem år är inte bekräftad.',
      'Kryssa i "Jag har kontrollerat uppgiften" under Lagstadgade upplysningar längre ner och klicka på Spara texten.',
    ],
    [
      disclosures.securities_pledged_confirmed,
      'AR-NOTE-SECURITIES-UNCONFIRMED',
      'Uppgiften om ställda säkerheter är inte bekräftad.',
      'Kryssa i "Jag har kontrollerat ställda säkerheter" under Lagstadgade upplysningar längre ner och klicka på Spara texten.',
    ],
    [
      disclosures.contingent_liabilities_confirmed,
      'AR-NOTE-CONTINGENT-UNCONFIRMED',
      'Uppgiften om eventualförpliktelser är inte bekräftad.',
      'Kryssa i "Jag har kontrollerat eventualförpliktelser" under Lagstadgade upplysningar längre ner och klicka på Spara texten.',
    ],
    [
      disclosures.parent_company_confirmed,
      'AR-NOTE-PARENT-UNCONFIRMED',
      'Uppgiften om koncern- och moderföretagsförhållanden är inte bekräftad.',
      'Kryssa i "Jag har kontrollerat koncernförhållandet" under Lagstadgade upplysningar längre ner och klicka på Spara texten.',
    ],
  ]
  for (const [confirmed, code, message, remediation] of disclosureChecks) {
    if (!confirmed) push(issues, code, 'error', 'notes', message, remediation)
  }

  if (report.accounting_framework === 'k3') {
    push(
      issues,
      'AR-K3-DRAFT-ONLY',
      'error',
      'scope',
      'Accounteds K3-dokument är ännu ett granskningsutkast och kan inte låsas som en komplett K3-årsredovisning.',
      'Slutför K3:s upplysningsmatris och oberoende regelverksgranskning innan versionen låses.',
    )
  }

  if (stage !== 'draft') {
    if (report.signatures.length === 0) {
      push(
        issues,
        'AR-SIGNERS-MISSING',
        'error',
        'signatures',
        'Styrelsens och eventuell VD:s undertecknare är inte registrerade.',
      )
    }
    if (!profile.signer_roster_confirmed_at) {
      push(
        issues,
        'AR-SIGNER-ROSTER-UNCONFIRMED',
        'error',
        'signatures',
        'Det är inte bekräftat att samtliga aktuella styrelseledamöter och eventuell VD finns med.',
        'Kontrollera namn och roller mot Bolagsverket och bekräfta undertecknarlistan.',
      )
    }
  }
  if (stage === 'filing') {
    if (report.signatures.some((signature) => !signature.signed_at)) {
      push(
        issues,
        'AR-SIGNATURES-INCOMPLETE',
        'error',
        'signatures',
        'Alla registrerade undertecknare har inte ett verifierat underskriftsdatum.',
      )
    }
    if (!report.forvaltningsberattelse.agm_date) {
      push(issues, 'AR-AGM-DATE', 'error', 'agm', 'Datum för årsstämman saknas.')
    }
    const signedDates = report.signatures
      .map((signature) => parseIsoDate(signature.signed_at))
      .filter((date): date is Date => date !== null)
    if (report.signatures.some((signature) => signature.signed_at && !parseIsoDate(signature.signed_at))) {
      push(issues, 'AR-SIGNATURE-DATE-INVALID', 'error', 'signatures', 'Ett underskriftsdatum är ogiltigt.')
    }
    if (periodEnd && signedDates.some((date) => date <= periodEnd)) {
      push(
        issues,
        'AR-SIGNATURE-BEFORE-PERIOD-END',
        'error',
        'signatures',
        'Årsredovisningen har undertecknats innan räkenskapsåret avslutades.',
      )
    }
    if (today && signedDates.some((date) => date > today)) {
      push(issues, 'AR-SIGNATURE-IN-FUTURE', 'error', 'signatures', 'Ett underskriftsdatum ligger i framtiden.')
    }
    const agmDate = parseIsoDate(report.forvaltningsberattelse.agm_date)
    if (report.forvaltningsberattelse.agm_date && !agmDate) {
      push(issues, 'AR-AGM-DATE-INVALID', 'error', 'agm', 'Datumet för årsstämman är ogiltigt.')
    }
    if (agmDate && periodEnd && agmDate <= periodEnd) {
      push(issues, 'AR-AGM-BEFORE-PERIOD-END', 'error', 'agm', 'Årsstämman ligger före räkenskapsårets slut.')
    }
    if (agmDate && today && agmDate > today) {
      push(issues, 'AR-AGM-IN-FUTURE', 'error', 'agm', 'Datumet för årsstämman ligger i framtiden.')
    }
    if (agmDate && signedDates.some((date) => date > agmDate)) {
      push(
        issues,
        'AR-AGM-BEFORE-SIGNATURES',
        'error',
        'agm',
        'Årsstämman har registrerats före den senaste underskriften av årsredovisningen.',
      )
    }
    if (agmDate && periodEnd && agmDate > addCalendarMonths(periodEnd, 6)) {
      push(
        issues,
        'AR-AGM-DEADLINE-PASSED',
        'warning',
        'agm',
        'Årsstämman hölls senare än sex månader efter räkenskapsårets slut.',
        'Dokumentera förseningen. En sen årsredovisning ska ändå lämnas in så snart som möjligt.',
      )
    }
    if (!disclosures.agm_disposition_outcome) {
      push(
        issues,
        'AR-AGM-DISPOSITION-OUTCOME',
        'error',
        'agm',
        'Årsstämmans beslut om resultatdisposition är inte registrerat.',
      )
    }
    if (
      disclosures.agm_disposition_outcome === 'alternative_decision' &&
      !disclosures.agm_disposition_decision?.trim()
    ) {
      push(
        issues,
        'AR-AGM-ALTERNATIVE-MISSING',
        'error',
        'agm',
        'Årsstämmans alternativa beslut om resultatdisposition saknar text.',
      )
    }
    if (profile.auditor_report_required && !profile.auditor_report_included) {
      push(
        issues,
        'AR-AUDITOR-REPORT-MISSING',
        'error',
        'filing',
        'Revisionsberättelse krävs men är inte markerad som inkluderad i inlämningspaketet.',
      )
    }
  }

  for (const warning of report.warnings) {
    push(issues, 'AR-SOURCE-WARNING', 'warning', 'statements', warning)
  }

  const errorCount = issues.filter((item) => item.severity === 'error').length
  const warningCount = issues.filter((item) => item.severity === 'warning').length
  return {
    stage,
    ok: errorCount === 0,
    error_count: errorCount,
    warning_count: warningCount,
    issues,
  }
}

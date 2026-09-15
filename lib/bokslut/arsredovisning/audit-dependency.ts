import type {
  AnnualReportComplianceIssue,
  AnnualReportProfile,
  AnnualReportSizeMetrics,
  AssociationAuditorSummary,
} from './compliance-types'

/**
 * The audit dependency of an ekonomisk förening (EFL 2018:672 8 kap.).
 *
 * Accounted never writes the revisor's opinion. What it can do is refuse to
 * call the annual-report package complete while the statutory dependency is
 * unmet: no revisor on the roster (8 kap. 1 §), a revisor without the
 * qualification the association's size demands (8 kap. 14 §), or a
 * revisionsberättelse that is claimed but not archived with its signed date
 * and opinion (8 kap. 33 §).
 *
 * 8 kap. 14 § first paragraph (verified against the statute text on
 * 2026-09-15): at least one revisor must be an auktoriserad revisor when the
 * association meets at least two of these conditions in each of the two
 * latest financial years: more than 50 employees on average, a reported
 * balance sheet total above 40 MSEK, a reported net turnover above 80 MSEK.
 * The second paragraph lets Bolagsverket accept a named godkänd revisor
 * instead for at most five years; that decision is not a fact the ledger
 * holds, so a godkänd revisor does not clear the rule here and the
 * remediation says where the decision goes. 8 kap. 16 § (a tenth of the
 * voting members can demand a qualified revisor) and 17 § (Bolagsverket may
 * order one) are likewise outside the ledger and are not evaluated.
 */
export const QUALIFIED_AUDITOR_THRESHOLDS = {
  employees: 50,
  balanceSheetTotal: 40_000_000,
  netRevenue: 80_000_000,
} as const

export const QUALIFIED_AUDITOR_KINDS: ReadonlySet<AssociationAuditorSummary['kind']> = new Set([
  'auktoriserad_revisor',
  'revisionsbolag',
])

function metConditions(year: AnnualReportSizeMetrics['current']): number | null {
  if (year.employees === null || year.balance_sheet_total === null || year.net_revenue === null) {
    return null
  }
  return [
    year.employees > QUALIFIED_AUDITOR_THRESHOLDS.employees,
    year.balance_sheet_total > QUALIFIED_AUDITOR_THRESHOLDS.balanceSheetTotal,
    year.net_revenue > QUALIFIED_AUDITOR_THRESHOLDS.netRevenue,
  ].filter(Boolean).length
}

/**
 * EFL 8 kap. 14 §: true when at least two conditions are met in each of the
 * two latest financial years. Without a previous year the rule cannot bite
 * (a first year is one year, not two); a year with an unknown figure gives
 * `null`, which the evaluator reports as an unresolved question rather than
 * as "not required".
 */
export function requiresQualifiedAuditor(
  current: AnnualReportSizeMetrics['current'],
  previous: AnnualReportSizeMetrics['previous'],
): boolean | null {
  if (!previous) return false
  const currentMet = metConditions(current)
  const previousMet = metConditions(previous)
  if (currentMet === null || previousMet === null) return null
  return currentMet >= 2 && previousMet >= 2
}

/** A revisor whose assignment covers the balance-sheet date. */
export function activeAuditorsOn(
  auditors: readonly AssociationAuditorSummary[],
  dateIso: string,
): AssociationAuditorSummary[] {
  return auditors.filter(
    (auditor) =>
      auditor.appointed_on <= dateIso && (auditor.ended_on === null || auditor.ended_on >= dateIso),
  )
}

export interface EvaluateAuditDependencyInput {
  profile: AnnualReportProfile
  auditors: readonly AssociationAuditorSummary[]
  metrics: AnnualReportSizeMetrics | null
  /** Balance-sheet date the roster is checked against. */
  periodEndIso: string
  /** Only the filing stage blocks on the archived report; earlier stages warn. */
  stage: 'draft' | 'signing' | 'filing'
}

function issue(
  code: string,
  severity: AnnualReportComplianceIssue['severity'],
  message: string,
  remediation?: string,
): AnnualReportComplianceIssue {
  return { code, severity, section: 'filing', message, remediation }
}

export function evaluateAuditDependency(
  input: EvaluateAuditDependencyInput,
): AnnualReportComplianceIssue[] {
  const issues: AnnualReportComplianceIssue[] = []
  const { profile, metrics, stage } = input
  const active = activeAuditorsOn(input.auditors, input.periodEndIso)

  if (active.length === 0) {
    issues.push(
      issue(
        'AR-EF-AUDITOR-NONE',
        'error',
        'Föreningen saknar registrerad revisor för räkenskapsåret (EFL 8 kap. 1 §).',
        'Registrera den revisor föreningsstämman har valt under Revisorer.',
      ),
    )
  }

  const qualified = metrics ? requiresQualifiedAuditor(metrics.current, metrics.previous) : null
  const hasQualified = active.some((auditor) => QUALIFIED_AUDITOR_KINDS.has(auditor.kind))
  if (qualified === true && active.length > 0 && !hasQualified) {
    issues.push(
      issue(
        'AR-EF-AUDITOR-QUALIFICATION',
        'error',
        'Föreningen uppfyller minst två av storlekskraven under de två senaste räkenskapsåren och ska då ha minst en auktoriserad revisor (EFL 8 kap. 14 §).',
        'Registrera en auktoriserad revisor eller ett registrerat revisionsbolag, eller ange Bolagsverkets beslut om godkänd revisor i uppdragsreferensen och kontakta support.',
      ),
    )
  } else if (qualified === null && active.length > 0 && !hasQualified && metrics?.previous) {
    issues.push(
      issue(
        'AR-EF-AUDITOR-QUALIFICATION-UNKNOWN',
        'warning',
        'Det går inte att avgöra om föreningen måste ha auktoriserad revisor (EFL 8 kap. 14 §): medelantal anställda, balansomslutning eller nettoomsättning saknas för något av de två senaste räkenskapsåren.',
        'Ange medelantalet anställda för båda åren.',
      ),
    )
  }

  // The archived report: 8 kap. 33 § requires a signed report that states
  // the day the audit was completed and, 34 §, an opinion. Claiming the
  // report is included without archiving it is the gap the filing package
  // must not cross.
  const reportSeverity = stage === 'filing' ? 'error' : 'warning'
  if (profile.auditor_report_included) {
    if (!profile.auditor_report_signed_on) {
      issues.push(
        issue(
          'AR-EF-AUDITOR-REPORT-UNSIGNED',
          reportSeverity,
          'Revisionsberättelsen är markerad som inkluderad men saknar datum för undertecknande (EFL 8 kap. 33 §).',
          'Ange det datum revisorn undertecknade revisionsberättelsen.',
        ),
      )
    }
    if (!profile.auditor_report_opinion) {
      issues.push(
        issue(
          'AR-EF-AUDITOR-REPORT-OPINION',
          reportSeverity,
          'Revisionsberättelsen är markerad som inkluderad men uttalandet är inte registrerat (EFL 8 kap. 34 §).',
          'Ange om revisionsberättelsen är utan modifiering, med reservation, avvikande eller om revisorn avstår från att uttala sig.',
        ),
      )
    }
    if (!profile.auditor_report_document_id) {
      issues.push(
        issue(
          'AR-EF-AUDITOR-REPORT-DOCUMENT',
          reportSeverity,
          'Den undertecknade revisionsberättelsen är inte arkiverad som dokument.',
          'Ladda upp den undertecknade revisionsberättelsen och koppla den till årsredovisningen.',
        ),
      )
    }
    if (profile.auditor_report_opinion && profile.auditor_report_opinion !== 'unmodified') {
      issues.push(
        issue(
          'AR-EF-AUDITOR-REPORT-MODIFIED',
          'warning',
          'Revisionsberättelsen är modifierad: föreningsstämman ska ta ställning till revisorns uttalande innan resultatdispositionen beslutas.',
          profile.auditor_report_deviations?.trim()
            ? undefined
            : 'Beskriv avvikelsen i fältet för avvikelser så att den följer med i handlingarna till stämman.',
        ),
      )
    }
  }

  return issues
}

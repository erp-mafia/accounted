import type {
  AnnualReportComplianceIssue,
  AnnualReportEligibilityResult,
  AnnualReportFramework,
  AnnualReportSizeMetrics,
} from './compliance-types'
import type { CashFlowOmissionRule, CashFlowOmissionState } from './types'

export type { CashFlowOmissionRule, CashFlowOmissionState }

/**
 * When a K3 årsredovisning may leave out the kassaflödesanalys.
 *
 * Law (verified via .claude/skills/swedish-financial-reporting,
 * references/arsredovisning-structure.md section 7, and SKILL.md "Större
 * företag"; swedish-year-end-closing references/legal-framework.md):
 *   - ÅRL 2 kap. 1 § andra stycket: a större företag always includes a
 *     kassaflödesanalys in its årsredovisning.
 *   - BFNAR 2012:1 (K3) kap. 7: mandatory for större företag, voluntary for
 *     mindre företag.
 *   - ÅRL 1 kap. 3 § första stycket 4: större företag is a company whose
 *     securities are admitted to trading on a regulated market, or one that
 *     exceeded more than one of >50 average employees, >40 MSEK
 *     balansomslutning, >80 MSEK nettoomsättning in EACH of the two most
 *     recent fiscal years.
 *
 * The product determines the size classification itself (eligibility.ts),
 * but only from figures it holds. When either year's figures are missing or
 * the listed-securities question is unanswered, the omission needs the
 * user's explicit confirmation that the company is not a större företag; a
 * determined större företag can never omit the statement.
 */
export function cashFlowOmissionRule(input: {
  framework: AnnualReportFramework
  sizeClassification: AnnualReportEligibilityResult['size_classification']
  metrics: AnnualReportSizeMetrics
  securitiesTradedOnRegulatedMarket: boolean | null
}): CashFlowOmissionRule {
  // K2 never carries a kassaflödesanalys in this product; nothing to omit.
  if (input.framework !== 'k3') return 'forbidden'
  if (input.securitiesTradedOnRegulatedMarket === true) return 'forbidden'
  if (input.sizeClassification === 'larger') return 'forbidden'
  // eligibility.ts classifies a missing jämförelseår as 'smaller'. That is
  // right for a company's first year but not for a company whose earlier
  // years were kept in another system, which the product cannot tell apart,
  // so a missing previous year needs the user's word.
  if (
    input.sizeClassification === 'smaller' &&
    input.metrics.previous !== null &&
    input.securitiesTradedOnRegulatedMarket === false
  ) {
    return 'allowed'
  }
  return 'requires_confirmation'
}

export function resolveCashFlowOmission(input: {
  rule: CashFlowOmissionRule
  requested: boolean
  confirmed: boolean
}): CashFlowOmissionState {
  const omitted =
    input.requested &&
    (input.rule === 'allowed' ||
      (input.rule === 'requires_confirmation' && input.confirmed))
  return {
    rule: input.rule,
    requested: input.requested,
    confirmed: input.confirmed,
    omitted,
  }
}

/**
 * Completeness issues for the omission choice. A request the law or the
 * missing confirmation does not allow is not honoured (the statement stays
 * in the document), and the user is told why.
 */
export function cashFlowOmissionIssues(
  state: CashFlowOmissionState | undefined,
): AnnualReportComplianceIssue[] {
  if (!state || !state.requested || state.omitted) return []
  if (state.rule === 'forbidden') {
    return [
      {
        code: 'AR-K3-CASHFLOW-REQUIRED',
        severity: 'warning',
        section: 'statements',
        message:
          'Bolaget är ett större företag enligt ÅRL 1 kap. 3 §, så kassaflödesanalysen måste ingå (ÅRL 2 kap. 1 §). Valet att utelämna den tillämpas inte.',
        remediation: 'Avmarkera "Utelämna kassaflödesanalys" och spara texten.',
      },
    ]
  }
  return [
    {
      code: 'AR-K3-CASHFLOW-CONFIRMATION-MISSING',
      severity: 'warning',
      section: 'statements',
      message:
        'Kassaflödesanalysen ingår fortfarande: storleken enligt ÅRL 1 kap. 3 § kan inte avgöras från bokföringen och är inte bekräftad.',
      remediation:
        'Bekräfta att bolaget inte är ett större företag under Kassaflödesanalys och spara texten.',
    },
  ]
}

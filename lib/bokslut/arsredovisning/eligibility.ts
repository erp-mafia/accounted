import type {
  AnnualReportComplianceIssue,
  AnnualReportEligibilityResult,
  AnnualReportProfile,
  AnnualReportSizeMetrics,
} from './compliance-types'

const LARGE_COMPANY_THRESHOLDS = {
  employees: 50,
  balanceSheetTotal: 40_000_000,
  netRevenue: 80_000_000,
} as const

const K2_RELIEF_THRESHOLDS = {
  employees: 3,
  balanceSheetTotal: 1_500_000,
  netRevenue: 3_000_000,
} as const

function issue(
  code: string,
  message: string,
  remediation?: string,
): AnnualReportComplianceIssue {
  return { code, severity: 'error', section: 'scope', message, remediation }
}

function exceededCount(
  metrics: AnnualReportSizeMetrics['current'],
  thresholds: {
    employees: number
    balanceSheetTotal: number
    netRevenue: number
  },
): number | null {
  if (
    metrics.employees === null ||
    metrics.balance_sheet_total === null ||
    metrics.net_revenue === null
  ) {
    return null
  }
  return [
    metrics.employees > thresholds.employees,
    metrics.balance_sheet_total > thresholds.balanceSheetTotal,
    metrics.net_revenue > thresholds.netRevenue,
  ].filter(Boolean).length
}

function sizeClassification(
  metrics: AnnualReportSizeMetrics,
): AnnualReportEligibilityResult['size_classification'] {
  if (!metrics.previous) return 'smaller'
  const current = exceededCount(metrics.current, LARGE_COMPANY_THRESHOLDS)
  const previous = exceededCount(metrics.previous, LARGE_COMPANY_THRESHOLDS)
  if (current === null || previous === null) return 'unknown'
  return current > 1 && previous > 1 ? 'larger' : 'smaller'
}

function reliefClassification(
  metrics: AnnualReportSizeMetrics,
): AnnualReportEligibilityResult['k2_relief_rule'] {
  if (!metrics.previous) return 'eligible'
  const current = exceededCount(metrics.current, K2_RELIEF_THRESHOLDS)
  const previous = exceededCount(metrics.previous, K2_RELIEF_THRESHOLDS)
  if (current === null || previous === null) return 'unknown'
  return current <= 1 || previous <= 1 ? 'eligible' : 'not_eligible'
}

function requireAnswer(
  issues: AnnualReportComplianceIssue[],
  value: boolean | null,
  code: string,
  label: string,
): void {
  if (value === null) {
    issues.push(
      issue(
        code,
        `${label} är inte besvarad.`,
        'Besvara frågan i avsnittet Omfattning och regelverk.',
      ),
    )
  }
}

function usesNewK2Restrictions(periodStart: string, periodEnd: string): boolean {
  if (periodStart > '2025-12-31') return true
  return periodStart > '2025-06-30' && periodEnd >= '2026-12-31'
}

export interface EvaluateAnnualReportEligibilityInput {
  entityType: string
  framework: 'k2' | 'k3'
  periodStart: string
  periodEnd: string
  profile: AnnualReportProfile
  metrics: AnnualReportSizeMetrics
}

/**
 * Evaluate framework and current Accounted filing support. The function is
 * deliberately conservative: missing legal facts produce blockers instead
 * of being treated as false.
 */
export function evaluateAnnualReportEligibility(
  input: EvaluateAnnualReportEligibilityInput,
): AnnualReportEligibilityResult {
  const issues: AnnualReportComplianceIssue[] = []
  const profile = input.profile
  const size = sizeClassification(input.metrics)
  const relief = reliefClassification(input.metrics)

  if (input.entityType !== 'aktiebolag') {
    issues.push(
      issue(
        'AR-SCOPE-ENTITY',
        'Accounteds årsredovisningsflöde stöder för närvarande aktiebolag.',
        'Använd rätt årsboksluts- eller deklarationsflöde för företagsformen.',
      ),
    )
  }

  requireAnswer(
    issues,
    profile.is_in_liquidation,
    'AR-SCOPE-LIQUIDATION-UNKNOWN',
    'Om bolaget är i likvidation',
  )
  if (profile.is_in_liquidation) {
    issues.push(
      issue(
        'AR-SCOPE-LIQUIDATION',
        'Årsredovisningar under likvidation kräver särskilda värderings- och uppställningsregler som Accounted ännu inte stöder.',
        'Upprätta årsredovisningen med hjälp av redovisningskonsult eller revisor.',
      ),
    )
  }

  if (input.framework === 'k2') {
    requireAnswer(
      issues,
      profile.is_public_limited_company,
      'AR-K2-PUBLIC-UNKNOWN',
      'Om bolaget är publikt',
    )
    requireAnswer(
      issues,
      profile.securities_traded_on_regulated_market,
      'AR-K2-LISTED-UNKNOWN',
      'Om värdepapper är upptagna till handel på en reglerad marknad',
    )
    requireAnswer(
      issues,
      profile.is_parent_company,
      'AR-K2-PARENT-UNKNOWN',
      'Om bolaget är moderföretag',
    )

    if (profile.is_public_limited_company) {
      issues.push(issue('AR-K2-PUBLIC', 'Publika aktiebolag får inte tillämpa K2.', 'Välj K3.'))
    }
    if (profile.securities_traded_on_regulated_market) {
      issues.push(
        issue('AR-K2-LISTED', 'Noterade företag är större företag och får inte tillämpa K2.', 'Välj K3.'),
      )
    }
    if (size === 'larger') {
      issues.push(issue('AR-K2-LARGE', 'Bolaget klassificeras som ett större företag enligt ÅRL.', 'Välj K3.'))
    }
    if (size === 'unknown') {
      issues.push(
        issue(
          'AR-K2-SIZE-UNKNOWN',
          'Storleksklassificeringen kan inte avgöras eftersom ett eller flera jämförelsetal saknas.',
          'Kontrollera jämförelseårets balansomslutning, nettoomsättning och medelantal anställda.',
        ),
      )
    }
    if (profile.is_parent_company) {
      if (profile.parent_group_size === null) {
        issues.push(issue('AR-K2-GROUP-SIZE-UNKNOWN', 'Koncernens storlek är inte angiven.'))
      }
      if (profile.prepares_consolidated_accounts === null) {
        issues.push(issue('AR-K2-CONSOLIDATION-UNKNOWN', 'Det är inte angivet om koncernredovisning upprättas.'))
      }
      if (profile.parent_group_size === 'large') {
        issues.push(issue('AR-K2-LARGE-GROUP', 'Moderföretag i en större koncern får inte tillämpa K2.', 'Välj K3.'))
      }
      if (profile.prepares_consolidated_accounts) {
        issues.push(
          issue(
            'AR-K2-CONSOLIDATED',
            'Ett moderföretag som upprättar koncernredovisning får inte upprätta årsredovisningen enligt K2.',
            'Välj K3.',
          ),
        )
      }
    }

    if (usesNewK2Restrictions(input.periodStart, input.periodEnd)) {
      const restrictedFacts: Array<{
        value: boolean | null
        unknownCode: string
        blockedCode: string
        label: string
      }> = [
        {
          value: profile.has_foreign_branch,
          unknownCode: 'AR-K2-FOREIGN-BRANCH-UNKNOWN',
          blockedCode: 'AR-K2-FOREIGN-BRANCH',
          label: 'filial i utlandet',
        },
        {
          value: profile.has_crypto_assets,
          unknownCode: 'AR-K2-CRYPTO-UNKNOWN',
          blockedCode: 'AR-K2-CRYPTO',
          label: 'kryptotillgångar som omfattas av K2-begränsningen',
        },
        {
          value: profile.has_share_based_payments,
          unknownCode: 'AR-K2-SHARE-PAYMENT-UNKNOWN',
          blockedCode: 'AR-K2-SHARE-PAYMENT',
          label: 'aktierelaterade ersättningar',
        },
        {
          value: profile.has_convertible_debt,
          unknownCode: 'AR-K2-CONVERTIBLE-UNKNOWN',
          blockedCode: 'AR-K2-CONVERTIBLE',
          label: 'emitterade sammansatta finansiella instrument',
        },
      ]
      for (const fact of restrictedFacts) {
        requireAnswer(issues, fact.value, fact.unknownCode, `Om bolaget har ${fact.label}`)
        if (fact.value) {
          issues.push(
            issue(
              fact.blockedCode,
              `Bolaget har ${fact.label} och får därför inte tillämpa K2 för det här räkenskapsåret.`,
              'Välj K3.',
            ),
          )
        }
      }

      if (relief !== 'eligible') {
        if (profile.building_revenue_share_pct === null) {
          issues.push(
            issue(
              'AR-K2-PROPERTY-UNKNOWN',
              'Andelen nettoomsättning från byggnader är inte angiven.',
            ),
          )
        } else if (profile.building_revenue_share_pct >= 75) {
          issues.push(
            issue(
              'AR-K2-PROPERTY',
              'Minst 75 procent av nettoomsättningen kommer normalt från byggnader och bolaget omfattas inte av lättnadsregeln.',
              'Välj K3.',
            ),
          )
        }
        requireAnswer(
          issues,
          profile.has_material_deferred_tax,
          'AR-K2-DEFERRED-TAX-UNKNOWN',
          'Om bolaget normalt har en väsentlig uppskjuten skatteskuld',
        )
        if (profile.has_material_deferred_tax) {
          issues.push(
            issue(
              'AR-K2-DEFERRED-TAX',
              'Bolaget har normalt en väsentlig uppskjuten skatteskuld och omfattas inte av lättnadsregeln.',
              'Välj K3.',
            ),
          )
        }
      }
    }
  }

  if (profile.reporting_currency !== 'SEK') {
    issues.push(
      issue(
        'AR-SCOPE-CURRENCY',
        'Accounteds årsredovisningsflöde stöder ännu endast SEK som redovisningsvaluta.',
        'Upprätta årsredovisningen i ett system som stöder euro som redovisningsvaluta.',
      ),
    )
  }

  const k2Eligible = input.framework === 'k2' && issues.every((item) => item.severity !== 'error')
  const digitalIssues = [...issues]
  if (input.framework !== 'k2') {
    digitalIssues.push(
      issue(
        'AR-DIGITAL-FRAMEWORK',
        'Accounteds digitala Bolagsverket-flöde stöder ännu endast K2 för aktiebolag.',
        'Använd pappersflödet tills K3-taxonomin är implementerad och godkänd.',
      ),
    )
  }
  if (profile.auditor_report_required === null) {
    digitalIssues.push(
      issue(
        'AR-DIGITAL-AUDIT-UNKNOWN',
        'Det är inte bekräftat om en revisionsberättelse krävs.',
        'Hämta grunduppgifter från Bolagsverket eller bekräfta uppgiften manuellt.',
      ),
    )
  } else if (profile.auditor_report_required) {
    digitalIssues.push(
      issue(
        'AR-DIGITAL-AUDIT',
        'Det här bolaget kräver revisionsberättelse, vilket Accounteds digitala paket ännu inte skickar.',
        'Använd pappersflödet eller vänta tills separat revisionsberättelse stöds.',
      ),
    )
  }

  return {
    k2_eligible: k2Eligible,
    digital_filing_eligible: digitalIssues.every((item) => item.severity !== 'error'),
    size_classification: size,
    k2_relief_rule: relief,
    issues,
    digital_issues: digitalIssues,
  }
}

export { K2_RELIEF_THRESHOLDS, LARGE_COMPANY_THRESHOLDS, usesNewK2Restrictions }

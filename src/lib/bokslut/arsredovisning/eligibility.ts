import {
  isEntityType,
  preparesArsredovisning,
  requiresAuditorRegardlessOfSize,
  supportsAccountingFramework,
  supportsIxbrl,
} from '@/lib/company/entity-type'
import { k3IxbrlEnabled } from '@/lib/bokslut/ixbrl/k3-release'
import type {
  AnnualReportComplianceIssue,
  AnnualReportEligibilityResult,
  AnnualReportProfile,
  AnnualReportSizeMetrics,
} from './compliance-types'
import type { K3FirstYearStatus } from './disclosures/types'

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

/** What the K3 scope checks read from the books and the framework records (model.ts). */
export interface K3ScopeInput {
  firstYear: K3FirstYearStatus
  /** Deferred tax recorded in the books (facts.ts temporaryDifferenceSignals().booked). */
  deferredTaxBooked: readonly string[]
  /** Assets that often carry temporary differences (temporaryDifferenceSignals().hints). */
  temporaryDifferenceHints: readonly string[]
}

export interface EvaluateAnnualReportEligibilityInput {
  entityType: string
  framework: 'k2' | 'k3'
  periodStart: string
  periodEnd: string
  profile: AnnualReportProfile
  metrics: AnnualReportSizeMetrics
  /** K3 only; absent means nothing is known, so the K3 checks fail closed. */
  k3?: K3ScopeInput
}

/**
 * The scope Accounted's K3 document covers: a mindre aktiebolag (K3 for
 * större företag is not built), a year that is not the first K3 year after
 * K2 (K3 kapitel 35: the transition is not built), and no temporary
 * differences beyond obeskattade reserver (K3 kapitel 29: deferred tax is
 * not built). Everything outside it fails closed with a stable code; an
 * unanswered question is a blocker, never a no.
 */
function k3ScopeIssues(
  issues: AnnualReportComplianceIssue[],
  profile: AnnualReportProfile,
  size: AnnualReportEligibilityResult['size_classification'],
  k3: K3ScopeInput | undefined,
): void {
  requireAnswer(
    issues,
    profile.securities_traded_on_regulated_market,
    'AR-K3-LISTED-UNKNOWN',
    'Om värdepapper som bolaget självt har gett ut är upptagna till handel på en reglerad marknad',
  )
  requireAnswer(issues, profile.is_public_limited_company, 'AR-K3-PUBLIC-UNKNOWN', 'Om bolaget är publikt')

  if (profile.securities_traded_on_regulated_market === true || size === 'larger') {
    issues.push(
      issue(
        'AR-K3-STORRE-UNSUPPORTED',
        'Bolaget är ett större företag enligt ÅRL 1 kap. 3 §. Accounteds K3-dokument omfattar ännu bara mindre företag: ett större företag ska bland annat ha kassaflödesanalys och fler noter (ÅRL 5 kap. 25-48 §§).',
        'Upprätta årsredovisningen med redovisningskonsult eller revisor.',
      ),
    )
  } else if (size === 'unknown') {
    issues.push(
      issue(
        'AR-K3-SIZE-UNKNOWN',
        'Storleksklassificeringen kan inte avgöras eftersom ett eller flera jämförelsetal saknas, och Accounteds K3-dokument omfattar bara mindre företag.',
        'Kontrollera jämförelseårets balansomslutning, nettoomsättning och medelantal anställda.',
      ),
    )
  }

  const firstYear = k3?.firstYear ?? 'unknown'
  if (firstYear === 'after_k2') {
    issues.push(
      issue(
        'AR-K3-FIRST-YEAR-UNSUPPORTED',
        'Föregående räkenskapsår upprättades enligt K2, så det här är första året bolaget tillämpar K3. Övergången kräver omräkning av ingångsbalansen och jämförelsetalen och särskilda noter (K3 kapitel 35), som Accounted ännu inte stöder.',
        'Upprätta årsredovisningen för övergångsåret med redovisningskonsult eller revisor.',
      ),
    )
  } else if (firstYear === 'unknown') {
    issues.push(
      issue(
        'AR-K3-FIRST-YEAR-UNKNOWN',
        'Det går inte att avgöra om det här är första året bolaget tillämpar K3.',
        'Ange i avsnittet Omfattning och regelverk vilket regelverk föregående årsredovisning upprättades enligt, eller att bolaget inte har upprättat någon tidigare.',
      ),
    )
  }

  const booked = k3?.deferredTaxBooked ?? []
  if (booked.length > 0 || profile.has_other_temporary_differences === true) {
    issues.push(
      issue(
        'AR-K3-TEMPORARY-DIFFERENCES-UNSUPPORTED',
        booked.length > 0
          ? `Bokföringen visar uppskjuten skatt (${booked.join('; ')}). Accounteds K3-dokument redovisar ännu inte uppskjuten skatt på andra temporära skillnader än obeskattade reserver (K3 kapitel 29).`
          : 'Bolaget har temporära skillnader utöver obeskattade reserver. Accounteds K3-dokument redovisar ännu inte uppskjuten skatt på dem (K3 kapitel 29).',
        'Upprätta årsredovisningen med redovisningskonsult eller revisor.',
      ),
    )
  } else if (profile.has_other_temporary_differences === null) {
    const hints = k3?.temporaryDifferenceHints ?? []
    issues.push(
      issue(
        'AR-K3-TEMPORARY-DIFFERENCES-UNKNOWN',
        'Det är inte besvarat om bolaget har temporära skillnader utöver obeskattade reserver, till exempel skillnader mellan bokförda och skattemässiga värden på byggnader (K3 kapitel 29).'
          + (hints.length > 0 ? ` Att kontrollera: ${hints.join('; ')}.` : ''),
        'Besvara frågan i avsnittet Omfattning och regelverk.',
      ),
    )
  }
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

  // The form's profile says whether the product prepares an årsredovisning
  // for it; an unknown form is a blocker, never an aktiebolag by default.
  if (!isEntityType(input.entityType) || !preparesArsredovisning(input.entityType)) {
    issues.push(
      issue(
        'AR-SCOPE-ENTITY',
        'Accounteds årsredovisningsflöde stöder inte den här företagsformen ännu.',
        'Använd rätt årsboksluts- eller deklarationsflöde för företagsformen.',
      ),
    )
  } else {
    // An ekonomisk förening prepares an årsredovisning every year (BFL 6 kap.
    // 1 §) with medlemsinsatser and förlagsinsatser as separate posts under
    // bundet eget kapital (ÅRL 3 kap. 10 b §), the ÅRL 6 kap. 3 § member
    // disclosures, a föreningsstämma instead of an årsstämma (EFL 6 kap.) and
    // a mandatory revisionsberättelse (EFL 8 kap. 1 §). The K2 document
    // carries all of that; the K3 equity statement is still shaped for the
    // aktiebolag, so K3 fails closed for the form.
    if (input.framework === 'k3' && !supportsAccountingFramework(input.entityType, 'K3')) {
      issues.push(
        issue(
          'AR-SCOPE-ENTITY-FRAMEWORK',
          'Accounteds K3-dokument för ekonomisk förening är inte färdigt: förändringen i eget kapital följer aktiebolagets uppställning.',
          'Välj K2 (BFNAR 2016:10) om föreningen är ett mindre företag, annars upprätta K3-årsredovisningen med hjälp av redovisningskonsult eller revisor.',
        ),
      )
    }
    // An unanswered profile (null) is not an answer: the form always needs
    // the revisionsberättelse, so only an explicit true clears the check.
    if (requiresAuditorRegardlessOfSize(input.entityType) && profile.auditor_report_required !== true) {
      issues.push(
        issue(
          'AR-AUDITOR-REQUIRED-FORENING',
          'En ekonomisk förening ska alltid ha minst en revisor och revisionsberättelsen är en del av årsredovisningspaketet (EFL 8 kap. 1 §, ÅRL 8 kap. 3 §).',
          'Markera att revisionsberättelse krävs i grunduppgifterna.',
        ),
      )
    }
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
      'Om värdepapper som bolaget självt har gett ut är upptagna till handel på en reglerad marknad',
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

  if (input.framework === 'k3') k3ScopeIssues(issues, profile, size, input.k3)

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
  if (isEntityType(input.entityType) && preparesArsredovisning(input.entityType) && !supportsIxbrl(input.entityType)) {
    digitalIssues.push(
      issue(
        'AR-DIGITAL-ENTITY',
        'Accounteds digitala Bolagsverket-flöde och iXBRL-taxonomi (K2 aktiebolag) täcker inte ekonomiska föreningar.',
        'Skriv ut PDF-paketet och lämna in årsredovisning och revisionsberättelse till Bolagsverket enligt deras anvisningar för ekonomiska föreningar.',
      ),
    )
  }
  // K3 files digitally only once its iXBRL document is switched on
  // (NEXT_PUBLIC_K3_IXBRL_ENABLED). Until then the copy says what is and is
  // not possible, and points at no paper flow: paper for K3 opens with the
  // reviewed K3 document, not before.
  if (input.framework === 'k3' && !k3IxbrlEnabled()) {
    digitalIssues.push(
      issue(
        'AR-DIGITAL-FRAMEWORK',
        'Accounted kan ännu inte lämna in en K3-årsredovisning digitalt: K3-dokumentet finns som PDF för granskning, men inget iXBRL-dokument skapas för det än.',
        'Inlämningen av K3-årsredovisningar öppnas när K3-dokumentet har granskats och godkänts. Den som behöver lämna in innan dess gör det med ett annat program eller med hjälp av redovisningskonsult eller revisor.',
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
    // Supported since the revisor package: the årsredovisning goes up as
    // arsredovisning_kompletteras with the revisorspåteckning, and the
    // revisionsberättelse follows as its own handling (Bolagsverket API 2.1).
    // What the påteckning needs (a revisor in the roster, its date, the
    // opinion) is known only after the board signed, so the iXBRL preflight
    // checks it at filing, not this lock-time gate.
    digitalIssues.push({
      code: 'AR-DIGITAL-AUDIT',
      severity: 'info',
      section: 'filing',
      message:
        'Revisionsberättelsen lämnas in separat: årsredovisningen laddas upp med revisorspåteckningen och revisorn meddelas att revisionsberättelsen ska kompletteras.',
      remediation:
        'Lägg till revisorn bland undertecknarna och registrera påteckningen när revisionsberättelsen har lämnats.',
    })
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

'use client'

import { useTranslations } from 'next-intl'
import { LightBulbIcon } from '@/components/icons'
import {
  SettingsGroup,
  SettingsRow,
  SettingsSectionHeader,
} from '@/components/settings/SettingsRows'
import { EmptyState } from '@/components/ui/empty-state'
import { formatDateLong } from '@/lib/utils'
import type { LedgerContext } from '@/lib/agent-context/ledger-context'
import type { DeepLedgerContext } from '@/lib/agent-context/ledger-deep'
import type { AgentCompetence } from '@/lib/agent-context/agent-competence'
import { vatLabel } from '@/lib/agent-context/vat-labels'
import { CompetenceCard, FactsCard } from './AgentCompetenceSections'
import { ExplicitRuleRows } from './ExplicitRuleRows'

export function AgentKnowledgeView({
  context,
  deep,
  competence,
  companyName,
  heading = true,
}: {
  context: LedgerContext
  deep: DeepLedgerContext
  competence: AgentCompetence
  companyName: string
  /** False where the page's top bar already names the view (the wiki). */
  heading?: boolean
}) {
  const t = useTranslations('agentKnowledge')

  const { meta, explicit_rules, vat_profile, conventions } = context

  const entities = [...deep.counterparty_entities, ...deep.supplier_entities]

  const isEmpty = meta.coverage.posted_entries_window === 0 && entities.length === 0 && explicit_rules.length === 0

  if (isEmpty) {
    // No bookings yet, but the agent still ships with competence and may
    // already remember facts: show those rather than a dead end.
    return (
      <div className="space-y-8">
        <EmptyState
          icon={LightBulbIcon}
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={t('empty_action')}
          actionHref="/transactions"
        />
        <div>
          <CompetenceCard competence={competence} />
          <FactsCard competence={competence} />
        </div>
      </div>
    )
  }

  const methodLabel =
    conventions.accounting_method === 'accrual'
      ? t('method_accrual')
      : conventions.accounting_method === 'cash'
        ? t('method_cash')
        : t('method_unknown')

  const periodLabel =
    vat_profile.moms_period === 'monthly'
      ? t('period_monthly')
      : vat_profile.moms_period === 'quarterly'
        ? t('period_quarterly')
        : vat_profile.moms_period === 'yearly'
          ? t('period_yearly')
          : (vat_profile.moms_period ?? t('unknown'))

  return (
    <div className="space-y-8">
      {/* "Bokföringsprofil": user-authored rules + observed VAT + conventions,
          in the flat settings language (groups under eyebrow labels, static
          descriptions behind the group "?"). Minne and Kompetens have their
          own top-level views, so no second tab row here. */}
      <section>
        {heading && <SettingsSectionHeader title={t('tab_config')} />}

        {explicit_rules.length > 0 && (
          <SettingsGroup label={t('rules_title')} help={t('rules_description')}>
            <ExplicitRuleRows rules={explicit_rules} />
          </SettingsGroup>
        )}

        <SettingsGroup label={t('vat_title')} help={t('vat_description')}>
          <SettingsRow label={t('vat_registered_label')}>
            <span>{vat_profile.registered ? t('yes') : t('no')}</span>
          </SettingsRow>
          <SettingsRow label={t('vat_period_label')}>
            <span>{periodLabel}</span>
          </SettingsRow>
          <SettingsRow label={t('vat_treatments_label')}>
            {vat_profile.treatments_used_12m.length === 0 ? (
              <span className="text-muted-foreground">{t('vat_no_treatments')}</span>
            ) : (
              <span>{vat_profile.treatments_used_12m.map((code) => vatLabel(code)).join(' · ')}</span>
            )}
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup label={t('conv_title')} help={t('conv_description')}>
          <SettingsRow label={t('conv_method_label')}>
            <span>{methodLabel}</span>
          </SettingsRow>
          <SettingsRow label={t('conv_series_label')}>
            {conventions.voucher_series_in_use.length === 0 ? (
              <span className="text-muted-foreground">-</span>
            ) : (
              <span className="font-mono text-xs">{conventions.voucher_series_in_use.join(', ')}</span>
            )}
          </SettingsRow>
          <SettingsRow label={t('conv_salary_label')}>
            <span>{conventions.salary_run_active ? t('yes') : t('no')}</span>
          </SettingsRow>
          {conventions.typical_booking_lag_days !== null && (
            <SettingsRow label={t('conv_lag_label')}>
              <span className="tabular-nums">
                {t('meta_lag_value', { days: conventions.typical_booking_lag_days })}
              </span>
            </SettingsRow>
          )}
        </SettingsGroup>
      </section>

      <p className="text-right text-xs text-muted-foreground">
        {t('footer_basis', { entries: meta.coverage.posted_entries_window, date: formatDateLong(meta.computed_at) })}
      </p>
    </div>
  )
}

'use client'

import { useTranslations } from 'next-intl'
import { Brain } from 'lucide-react'
import {
  SettingsGroup,
  SettingsRow,
  SettingsSectionHeader,
} from '@/components/settings/SettingsRows'
import { AccountNumber } from '@/components/ui/account-number'
import { EmptyState } from '@/components/ui/empty-state'
import { formatDateLong } from '@/lib/utils'
import type { LedgerContext } from '@/lib/agent-context/ledger-context'
import type { DeepLedgerContext } from '@/lib/agent-context/ledger-deep'
import type { AgentCompetence } from '@/lib/agent-context/agent-competence'
import { LedgerGraph } from './LedgerGraph'
import { CompetenceCard, FactsCard } from './AgentCompetenceSections'

// Swedish VAT (moms) treatment codes stay Swedish in both locales, like BAS
// account names and momsdeklaration labels (.claude/rules/i18n.md).
const VAT_LABELS: Record<string, string> = {
  standard_25: 'Moms 25%',
  standard_12: 'Moms 12%',
  standard_6: 'Moms 6%',
  reduced_12: 'Moms 12%',
  reduced_6: 'Moms 6%',
  reverse_charge: 'Omvänd moms',
  reverse_charge_eu: 'Omvänd moms (EU)',
  reverse_charge_services: 'Omvänd moms (tjänster)',
  eu_reverse_charge_services: 'Omvänd moms (EU-tjänster)',
  eu_goods: 'EU-varor',
  export: 'Export',
  exempt: 'Momsfri',
  no_vat: 'Ingen moms',
}

function vatLabel(code: string | null): string | null {
  if (!code) return null
  return VAT_LABELS[code] ?? code
}

export function AgentKnowledgeView({
  context,
  deep,
  competence,
  companyName,
}: {
  context: LedgerContext
  deep: DeepLedgerContext
  competence: AgentCompetence
  companyName: string
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
          icon={Brain}
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
      {/* The cinematic hero: a self-contained dark panel with its own header */}
      <LedgerGraph deep={deep} companyName={companyName} />

      {/* "Regler & profil": user-authored rules + observed VAT + conventions,
          in the flat settings language (groups under eyebrow labels, static
          descriptions behind the group "?"). Minne and Kompetens have their
          own top-level views, so no second tab row here. */}
      <section>
        <SettingsSectionHeader title={t('tab_config')} />

        {explicit_rules.length > 0 && (
          <SettingsGroup label={t('rules_title')} help={t('rules_description')}>
            {explicit_rules.map((r, i) => {
              const vat = vatLabel(r.vat_treatment)
              return (
                <div
                  key={r.rule_name + r.match + i}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-1 py-3"
                >
                  <span className="text-sm">{r.rule_name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                    {r.match}
                  </span>
                  <span className="flex shrink-0 flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                    {r.account_number ? (
                      <AccountNumber number={r.account_number} showName size="sm" />
                    ) : (
                      <span>-</span>
                    )}
                    {vat && <span>· {vat}</span>}
                    <span>· {t('src_rule')}</span>
                  </span>
                </div>
              )
            })}
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

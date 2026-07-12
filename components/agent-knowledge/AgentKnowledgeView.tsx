'use client'

import { useTranslations } from 'next-intl'
import { Brain } from 'lucide-react'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { AccountNumber } from '@/components/ui/account-number'
import { EmptyState } from '@/components/ui/empty-state'
import { formatDateLong } from '@/lib/utils'
import type { LedgerContext } from '@/lib/agent-context/ledger-context'
import type { DeepLedgerContext } from '@/lib/agent-context/ledger-deep'
import type { AgentCompetence } from '@/lib/agent-context/agent-competence'
import { LedgerGraph } from './LedgerGraph'
import { CompetenceCard, FactsCard } from './AgentCompetenceSections'
import { KnowledgeTabs } from './KnowledgeTabs'

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
      <>
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Brain}
              title={t('empty_title')}
              description={t('empty_description')}
              actionLabel={t('empty_action')}
              actionHref="/transactions"
            />
          </CardContent>
        </Card>
        <div className="grid gap-4 lg:grid-cols-2">
          <CompetenceCard competence={competence} />
          <FactsCard competence={competence} />
        </div>
      </>
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

  // "Regler & profil" tab: user-authored rules + observed VAT + conventions.
  const configContent = (
    <>
      {explicit_rules.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('rules_title')}</CardTitle>
            <CardDescription>{t('rules_description')}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('col_rule')}</TableHead>
                  <TableHead>{t('col_match')}</TableHead>
                  <TableHead>{t('col_account')}</TableHead>
                  <TableHead>{t('col_vat')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {explicit_rules.map((r, i) => (
                  <TableRow key={r.rule_name + r.match + i}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{r.rule_name}</span>
                        <Badge variant="default">{t('src_rule')}</Badge>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{r.match}</TableCell>
                    <TableCell>
                      {r.account_number
                        ? <AccountNumber number={r.account_number} showName size="sm" />
                        : <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{vatLabel(r.vat_treatment) ?? '-'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('vat_title')}</CardTitle>
            <CardDescription>{t('vat_description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-0">
            <Row label={t('vat_registered_label')}>
              <Badge variant={vat_profile.registered ? 'success' : 'outline'}>
                {vat_profile.registered ? t('yes') : t('no')}
              </Badge>
            </Row>
            <Row label={t('vat_period_label')}>
              <span className="text-sm">{periodLabel}</span>
            </Row>
            <Row label={t('vat_treatments_label')}>
              {vat_profile.treatments_used_12m.length === 0 ? (
                <span className="text-sm text-muted-foreground">{t('vat_no_treatments')}</span>
              ) : (
                <div className="flex flex-wrap justify-end gap-2">
                  {vat_profile.treatments_used_12m.map((code) => (
                    <Badge key={code} variant="outline">{vatLabel(code)}</Badge>
                  ))}
                </div>
              )}
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('conv_title')}</CardTitle>
            <CardDescription>{t('conv_description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-0">
            <Row label={t('conv_method_label')}>
              <span className="text-sm">{methodLabel}</span>
            </Row>
            <Row label={t('conv_series_label')}>
              {conventions.voucher_series_in_use.length === 0 ? (
                <span className="text-sm text-muted-foreground">-</span>
              ) : (
                <div className="flex flex-wrap justify-end gap-2">
                  {conventions.voucher_series_in_use.map((s) => (
                    <Badge key={s} variant="secondary" className="font-mono">{s}</Badge>
                  ))}
                </div>
              )}
            </Row>
            <Row label={t('conv_salary_label')}>
              <Badge variant={conventions.salary_run_active ? 'success' : 'outline'}>
                {conventions.salary_run_active ? t('yes') : t('no')}
              </Badge>
            </Row>
            {conventions.typical_booking_lag_days !== null && (
              <Row label={t('conv_lag_label')}>
                <span className="text-sm tabular-nums">{t('meta_lag_value', { days: conventions.typical_booking_lag_days })}</span>
              </Row>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )

  const tabs = [
    { value: 'competence', label: t('tab_competence'), content: <CompetenceCard competence={competence} /> },
    { value: 'memory', label: t('tab_memory'), content: <FactsCard competence={competence} /> },
    { value: 'config', label: t('tab_config'), content: configContent },
  ]

  return (
    <>
      {/* The cinematic hero: a self-contained dark panel with its own header */}
      <LedgerGraph deep={deep} companyName={companyName} />

      {/* Supporting detail, tabbed so it doesn't stack into a long scroll */}
      <KnowledgeTabs tabs={tabs} />

      <p className="text-right text-xs text-muted-foreground">
        {t('footer_basis', { entries: meta.coverage.posted_entries_window, date: formatDateLong(meta.computed_at) })}
      </p>
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div>{children}</div>
    </div>
  )
}

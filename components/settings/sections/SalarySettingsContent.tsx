'use client'

import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { TaxTableStatus } from '@/components/salary/TaxTableStatus'

export function SalarySettingsContent() {
  const t = useTranslations('settings_salary')
  return (
    <div className="space-y-8">
      <PageHeader title={t('title')} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('accounting_heading')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('voucher_series_label')}</label>
            <select className="flex h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 py-1 text-sm" defaultValue="A">
              <option value="A">{t('voucher_series_a')}</option>
              <option value="L">{t('voucher_series_l')}</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {t('voucher_series_help')}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('tax_tables_heading')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <TaxTableStatus />
          <p className="text-xs text-muted-foreground">
            {t('tax_tables_help')}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('vacation_heading')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('vacation_rule_label')}</label>
            <select className="flex h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 py-1 text-sm" defaultValue="procentregeln">
              <option value="procentregeln">{t('vacation_rule_percentage')}</option>
              <option value="sammaloneregeln">{t('vacation_rule_same_pay')}</option>
              <option value="none">{t('vacation_rule_none')}</option>
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('vacation_supplement_label')}</label>
            <select className="flex h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 py-1 text-sm" defaultValue="0.0043">
              <option value="0.0043">{t('vacation_supplement_min')}</option>
              <option value="0.008">{t('vacation_supplement_cba')}</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {t('vacation_supplement_help')}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('info_heading')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground space-y-2">
            <p>{t('info_payroll_scope')}</p>
            <p>
              {t.rich('info_current_year', {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

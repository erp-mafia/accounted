'use client'

import { useTranslations } from 'next-intl'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  vatTreatmentsForAccountClass,
  type AccountVatTreatment,
} from '@/lib/vat/account-vat-treatment'

interface AccountVatTreatmentSelectProps {
  value: AccountVatTreatment | 'none'
  onValueChange: (value: AccountVatTreatment | 'none') => void
  accountClass: number | null
}

export function AccountVatTreatmentSelect({
  value,
  onValueChange,
  accountClass,
}: AccountVatTreatmentSelectProps) {
  const t = useTranslations('chart_of_accounts')
  const isRelevant = accountClass === 3 ||
    (accountClass !== null && accountClass >= 4 && accountClass <= 6)
  const treatments = vatTreatmentsForAccountClass(accountClass)

  return (
    <div className="space-y-2">
      <Label>{t('vat_treatment_label')}</Label>
      <Select
        value={value}
        onValueChange={(next) => onValueChange(next as AccountVatTreatment | 'none')}
        disabled={!isRelevant}
      >
        <SelectTrigger aria-label={t('vat_treatment_label')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{t('vat_treatment_none')}</SelectItem>
          {treatments.map((treatment) => (
            <SelectItem key={treatment} value={treatment}>
              {t(`vat_treatment_${treatment}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {isRelevant ? t('vat_treatment_help') : t('vat_treatment_not_applicable')}
      </p>
    </div>
  )
}

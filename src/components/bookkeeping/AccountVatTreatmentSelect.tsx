'use client'

import { useTranslations } from 'next-intl'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  vatTreatmentsForAccountClass,
  type AccountVatTreatment,
} from '@/lib/vat/account-vat-treatment'
import { accountVatReviewFinding } from '@/lib/vat/account-vat-review'

interface AccountVatTreatmentSelectProps {
  value: AccountVatTreatment | 'none'
  onValueChange: (value: AccountVatTreatment | 'none') => void
  accountClass: number | null
  /**
   * The account being edited. When given, a momskod the name contradicts
   * (the Kontoplan "Att granska" predicate) is named under the select, live,
   * so it clears as soon as the choice agrees.
   */
  account?: { accountNumber: string; accountName: string; vatRate: number | null }
}

export function AccountVatTreatmentSelect({
  value,
  onValueChange,
  accountClass,
  account,
}: AccountVatTreatmentSelectProps) {
  const t = useTranslations('chart_of_accounts')
  const isRelevant = accountClass === 3 ||
    (accountClass !== null && accountClass >= 4 && accountClass <= 6)
  const treatments = vatTreatmentsForAccountClass(accountClass)
  const finding = account && accountClass !== null
    ? accountVatReviewFinding({
        account_number: account.accountNumber,
        account_name: account.accountName,
        account_class: accountClass,
        default_vat_rate: account.vatRate,
        default_vat_treatment: value === 'none' ? null : value,
      })
    : null

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
      {finding ? (
        <p className="text-xs text-attn">
          {t('vat_review_hint', { suggested: t(`vat_treatment_${finding.suggestedTreatment}`) })}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {isRelevant ? t('vat_treatment_help') : t('vat_treatment_not_applicable')}
        </p>
      )}
    </div>
  )
}

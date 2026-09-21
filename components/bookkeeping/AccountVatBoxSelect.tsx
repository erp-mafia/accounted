'use client'

import { useTranslations } from 'next-intl'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  ACCOUNT_VAT_BOX_CODES,
  basVatBox,
  vatBoxDeviationFromName,
  vatBoxLabel,
  type AccountVatBox,
} from '@/lib/vat/account-vat-box'

interface AccountVatBoxSelectProps {
  value: AccountVatBox | 'bas'
  onValueChange: (value: AccountVatBox | 'bas') => void
  accountNumber: string
  accountName: string
}

/**
 * Momsruta for a 26xx VAT account. 'bas' (stored as null) keeps the mapping
 * by account number; a box code routes the balance there. Renders only for
 * accounts that may carry an override (isVatBoxAccount), so the caller gates
 * on that.
 */
export function AccountVatBoxSelect({
  value,
  onValueChange,
  accountNumber,
  accountName,
}: AccountVatBoxSelectProps) {
  const t = useTranslations('chart_of_accounts')
  const basBox = basVatBox(accountNumber)
  const deviation = value === 'bas' ? vatBoxDeviationFromName(accountNumber, accountName) : null

  return (
    <div className="space-y-2">
      <Label>{t('vat_box_label')}</Label>
      <Select value={value} onValueChange={(next) => onValueChange(next as AccountVatBox | 'bas')}>
        <SelectTrigger aria-label={t('vat_box_label')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="bas">
            {basBox
              ? t('vat_box_bas', { box: basBox, label: vatBoxLabel(basBox) })
              : t('vat_box_bas_unknown')}
          </SelectItem>
          {ACCOUNT_VAT_BOX_CODES.map((box) => (
            <SelectItem key={box} value={box}>
              {t('vat_box_option', { box, label: vatBoxLabel(box) })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {deviation
          ? t('vat_box_deviation', { box: deviation, label: vatBoxLabel(deviation) })
          : t('vat_box_help')}
      </p>
    </div>
  )
}

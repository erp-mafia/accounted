'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { BankNameCombobox } from '@/components/settings/BankNameCombobox'
import { validateBankgiroNumber, formatBankgiroNumber, validatePlusgiroNumber, formatPlusgiroNumber } from '@/lib/bankgiro/luhn'
import { normaliseSwish, isValidSwish } from '@/lib/payments/swish'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import type { CompanySettings } from '@/types'

interface BankDetailsFormProps {
  settings: CompanySettings
}

export function BankDetailsForm({ settings }: BankDetailsFormProps) {
  const t = useTranslations('settings_bank_details_form')
  const [bankgiroError, setBankgiroError] = useState<string | null>(null)
  const [plusgiroError, setPlusgiroError] = useState<string | null>(null)
  const [clearingError, setClearingError] = useState<string | null>(null)
  const [accountNumberError, setAccountNumberError] = useState<string | null>(null)
  const [swishError, setSwishError] = useState<string | null>(null)
  const [ibanError, setIbanError] = useState<string | null>(null)
  const [bicError, setBicError] = useState<string | null>(null)
  const hasBankingExtension = ENABLED_EXTENSION_IDS.has('enable-banking')

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        {t('heading')}
      </h2>
      <p className="text-xs text-muted-foreground -mt-2">
        {t('subheading')}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label>{t('bank_label')}</Label>
          <BankNameCombobox
            defaultValue={settings.bank_name || ''}
            enableBankingEnabled={hasBankingExtension}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="clearing_number">{t('clearing_label')}</Label>
          <Input
            id="clearing_number"
            name="clearing_number"
            inputMode="numeric"
            placeholder="XXXX"
            maxLength={5}
            defaultValue={settings.clearing_number || ''}
            onChange={(e) => {
              e.target.value = e.target.value.replace(/\D/g, '')
            }}
            onBlur={(e) => {
              const val = e.target.value.trim()
              if (!val) { setClearingError(null); return }
              setClearingError(!/^\d{4,5}$/.test(val) ? t('clearing_error') : null)
            }}
          />
          {clearingError && <p className="text-xs text-destructive">{clearingError}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="account_number">{t('account_number_label')}</Label>
          <Input
            id="account_number"
            name="account_number"
            inputMode="numeric"
            placeholder="XXXXXXX"
            maxLength={12}
            defaultValue={settings.account_number || ''}
            onChange={(e) => {
              e.target.value = e.target.value.replace(/\D/g, '')
            }}
            onBlur={(e) => {
              const val = e.target.value.trim()
              if (!val) { setAccountNumberError(null); return }
              setAccountNumberError(!/^\d{6,12}$/.test(val) ? t('account_number_error') : null)
            }}
          />
          {accountNumberError && <p className="text-xs text-destructive">{accountNumberError}</p>}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label htmlFor="bankgiro">{t('bankgiro_label')}</Label>
          <Input
            id="bankgiro"
            name="bankgiro"
            placeholder="XXX-XXXX"
            defaultValue={settings.bankgiro || ''}
            onBlur={(e) => {
              const val = e.target.value.trim()
              if (!val) { setBankgiroError(null); return }
              if (validateBankgiroNumber(val)) {
                e.target.value = formatBankgiroNumber(val)
                setBankgiroError(null)
              } else {
                setBankgiroError(t('bankgiro_error'))
              }
            }}
          />
          {bankgiroError && <p className="text-xs text-destructive">{bankgiroError}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="plusgiro">{t('plusgiro_label')}</Label>
          <Input
            id="plusgiro"
            name="plusgiro"
            placeholder="XXXXXX-X"
            defaultValue={settings.plusgiro || ''}
            onBlur={(e) => {
              const val = e.target.value.trim()
              if (!val) { setPlusgiroError(null); return }
              if (validatePlusgiroNumber(val)) {
                e.target.value = formatPlusgiroNumber(val)
                setPlusgiroError(null)
              } else {
                setPlusgiroError(t('plusgiro_error'))
              }
            }}
          />
          {plusgiroError && <p className="text-xs text-destructive">{plusgiroError}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="swish">{t('swish_label')}</Label>
          <Input
            id="swish"
            name="swish"
            placeholder={t('swish_placeholder')}
            defaultValue={settings.swish || ''}
            onBlur={(e) => {
              const val = normaliseSwish(e.target.value)
              if (!val) { setSwishError(null); e.target.value = ''; return }
              if (isValidSwish(val)) {
                e.target.value = val
                setSwishError(null)
              } else {
                setSwishError(t('swish_error'))
              }
            }}
          />
          {swishError && <p className="text-xs text-destructive">{swishError}</p>}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="iban">{t('iban_label')}</Label>
          <Input
            id="iban"
            name="iban"
            placeholder="SE00 0000 0000 0000 0000 0000"
            defaultValue={settings.iban || ''}
            onBlur={(e) => {
              const val = e.target.value.replace(/\s/g, '').toUpperCase()
              if (!val) { setIbanError(null); e.target.value = ''; return }
              e.target.value = val
              setIbanError(/^SE\d{22}$/.test(val) ? null : t('iban_error'))
            }}
          />
          {ibanError
            ? <p className="text-xs text-destructive">{ibanError}</p>
            : <p className="text-xs text-muted-foreground">{t('iban_hint')}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="bic">{t('bic_label')}</Label>
          <Input
            id="bic"
            name="bic"
            placeholder={t('bic_placeholder')}
            maxLength={11}
            defaultValue={settings.bic || ''}
            onBlur={(e) => {
              const val = e.target.value.replace(/\s/g, '').toUpperCase()
              if (!val) { setBicError(null); e.target.value = ''; return }
              e.target.value = val
              setBicError(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(val) ? null : t('bic_error'))
            }}
          />
          {bicError && <p className="text-xs text-destructive">{bicError}</p>}
        </div>
      </div>
    </section>
  )
}

/** Validate bank fields from FormData. Returns error messages or null. */
export function validateBankFields(formData: FormData): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = []
  const clearing = (formData.get('clearing_number') as string || '').trim()
  const account = (formData.get('account_number') as string || '').trim()
  const bankgiro = (formData.get('bankgiro') as string || '').trim()
  const plusgiro = (formData.get('plusgiro') as string || '').trim()
  const swish = normaliseSwish(formData.get('swish') as string)
  const iban = (formData.get('iban') as string || '').replace(/\s/g, '').toUpperCase()
  const bic = (formData.get('bic') as string || '').replace(/\s/g, '').toUpperCase()

  if (clearing && !/^\d{4,5}$/.test(clearing)) {
    errors.push({ field: 'clearing_number', message: 'Clearingnummer måste vara 4-5 siffror' })
  }
  if (account && !/^\d{6,12}$/.test(account)) {
    errors.push({ field: 'account_number', message: 'Kontonummer måste vara 6-12 siffror' })
  }
  if (bankgiro && !validateBankgiroNumber(bankgiro)) {
    errors.push({ field: 'bankgiro', message: 'Ogiltigt bankgironummer' })
  }
  if (plusgiro && !validatePlusgiroNumber(plusgiro)) {
    errors.push({ field: 'plusgiro', message: 'Ogiltigt plusgironummer' })
  }
  if (swish && !isValidSwish(swish)) {
    errors.push({ field: 'swish', message: 'Ogiltigt Swish-nummer (företagsnummer 123XXXXXXX eller mobilnummer 07XXXXXXXX)' })
  }
  if (iban && !/^SE\d{22}$/.test(iban)) {
    errors.push({ field: 'iban', message: 'Ogiltigt IBAN (SE följt av 22 siffror)' })
  }
  if (bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) {
    errors.push({ field: 'bic', message: 'Ogiltig BIC/SWIFT (8 eller 11 tecken)' })
  }
  return errors
}

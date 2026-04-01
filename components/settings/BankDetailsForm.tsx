'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { BankNameCombobox } from '@/components/settings/BankNameCombobox'
import { validateBankgiroNumber, formatBankgiroNumber } from '@/lib/bankgiro/luhn'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import type { CompanySettings } from '@/types'

interface BankDetailsFormProps {
  settings: CompanySettings
}

export function BankDetailsForm({ settings }: BankDetailsFormProps) {
  const [bankgiroError, setBankgiroError] = useState<string | null>(null)
  const [clearingError, setClearingError] = useState<string | null>(null)
  const [accountNumberError, setAccountNumberError] = useState<string | null>(null)
  const hasBankingExtension = ENABLED_EXTENSION_IDS.has('enable-banking')

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        Bankuppgifter
      </h2>
      <p className="text-xs text-muted-foreground -mt-2">
        Visas på dina fakturor
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label>Bank</Label>
          <BankNameCombobox
            defaultValue={settings.bank_name || ''}
            enableBankingEnabled={hasBankingExtension}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="clearing_number">Clearing</Label>
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
              setClearingError(!/^\d{4,5}$/.test(val) ? 'Måste vara 4-5 siffror' : null)
            }}
          />
          {clearingError && <p className="text-xs text-destructive">{clearingError}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="account_number">Kontonummer</Label>
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
              setAccountNumberError(!/^\d{6,12}$/.test(val) ? 'Måste vara 6-12 siffror' : null)
            }}
          />
          {accountNumberError && <p className="text-xs text-destructive">{accountNumberError}</p>}
        </div>
      </div>

      <div className="max-w-xs space-y-2">
        <Label htmlFor="bankgiro">Bankgiro</Label>
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
              setBankgiroError('Ogiltigt bankgironummer')
            }
          }}
        />
        {bankgiroError && <p className="text-xs text-destructive">{bankgiroError}</p>}
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

  if (clearing && !/^\d{4,5}$/.test(clearing)) {
    errors.push({ field: 'clearing_number', message: 'Clearingnummer måste vara 4-5 siffror' })
  }
  if (account && !/^\d{6,12}$/.test(account)) {
    errors.push({ field: 'account_number', message: 'Kontonummer måste vara 6-12 siffror' })
  }
  if (bankgiro && !validateBankgiroNumber(bankgiro)) {
    errors.push({ field: 'bankgiro', message: 'Ogiltigt bankgironummer' })
  }
  return errors
}

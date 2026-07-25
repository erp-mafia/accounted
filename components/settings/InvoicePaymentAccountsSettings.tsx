'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { BankNameCombobox } from '@/components/settings/BankNameCombobox'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSeg,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { validateBankgiroNumber, validatePlusgiroNumber } from '@/lib/bankgiro/luhn'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import {
  INVOICE_PAYMENT_ACCOUNT_CURRENCIES,
  legacySekInvoicePaymentAccount,
  normalizeInvoicePaymentAccount,
} from '@/lib/invoices/payment-accounts'
import { isValidSwish, normaliseSwish } from '@/lib/payments/swish'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import type {
  CompanySettings,
  Currency,
  InvoicePaymentAccount,
} from '@/types'

interface InvoicePaymentAccountsSettingsProps {
  settings: CompanySettings
  onUpdate: (updates: Partial<CompanySettings>) => void
}

const EMPTY_ACCOUNT: InvoicePaymentAccount = {
  bank_name: null,
  clearing_number: null,
  account_number: null,
  bankgiro: null,
  plusgiro: null,
  swish: null,
  iban: null,
  bic: null,
}

function initialAccounts(
  paymentAccounts: CompanySettings['invoice_payment_accounts'],
  legacySekAccount: InvoicePaymentAccount,
): Partial<Record<Currency, InvoicePaymentAccount>> {
  const configured = Object.fromEntries(
    Object.entries(paymentAccounts ?? {}).map(([currency, account]) => [
      currency,
      normalizeInvoicePaymentAccount(account),
    ]),
  ) as Partial<Record<Currency, InvoicePaymentAccount>>

  if (!configured.SEK) configured.SEK = legacySekAccount
  return configured
}

function value(account: InvoicePaymentAccount, field: keyof InvoicePaymentAccount): string {
  return account[field] ?? ''
}

function accountsKey(accounts: Partial<Record<Currency, InvoicePaymentAccount>>): string {
  return JSON.stringify(INVOICE_PAYMENT_ACCOUNT_CURRENCIES.map((currency) => [
    currency,
    accounts[currency] ? normalizeInvoicePaymentAccount(accounts[currency]) : null,
  ]))
}

export function InvoicePaymentAccountsSettings({
  settings,
  onUpdate,
}: InvoicePaymentAccountsSettingsProps) {
  const t = useTranslations('settings_invoice_payment_accounts')
  const { toast } = useToast()
  const { role } = useCompany()
  const legacySekAccount = useMemo(
    () => legacySekInvoicePaymentAccount({
      bank_name: settings.bank_name,
      clearing_number: settings.clearing_number,
      account_number: settings.account_number,
      bankgiro: settings.bankgiro,
      plusgiro: settings.plusgiro,
      swish: settings.swish,
      iban: settings.iban,
      bic: settings.bic,
    }),
    [
      settings.bank_name,
      settings.clearing_number,
      settings.account_number,
      settings.bankgiro,
      settings.plusgiro,
      settings.swish,
      settings.iban,
      settings.bic,
    ],
  )
  const serverAccounts = useMemo(
    () => initialAccounts(settings.invoice_payment_accounts, legacySekAccount),
    [settings.invoice_payment_accounts, legacySekAccount],
  )
  const serverAccountsKey = accountsKey(serverAccounts)
  const [accounts, setAccounts] = useState(serverAccounts)
  const [activeCurrency, setActiveCurrency] = useState<Currency>('SEK')
  const [currencyToAdd, setCurrencyToAdd] = useState<Currency | ''>('')
  const [isSaving, setIsSaving] = useState(false)
  const [hasExternalUpdate, setHasExternalUpdate] = useState(false)
  const accountsRef = useRef(accounts)
  const previousServerAccountsKey = useRef(serverAccountsKey)
  accountsRef.current = accounts
  const hasBankingExtension = ENABLED_EXTENSION_IDS.has('enable-banking')

  useEffect(() => {
    const previousKey = previousServerAccountsKey.current
    if (serverAccountsKey === previousKey) return

    const currentKey = accountsKey(accountsRef.current)
    if (currentKey === serverAccountsKey) {
      setHasExternalUpdate(false)
    } else if (currentKey === previousKey) {
      accountsRef.current = serverAccounts
      setAccounts(serverAccounts)
      setHasExternalUpdate(false)
    } else {
      setHasExternalUpdate(true)
    }
    previousServerAccountsKey.current = serverAccountsKey
  }, [serverAccounts, serverAccountsKey])

  const configuredCurrencies = useMemo(
    () => INVOICE_PAYMENT_ACCOUNT_CURRENCIES.filter((currency) => !!accounts[currency]),
    [accounts],
  )
  const availableCurrencies = INVOICE_PAYMENT_ACCOUNT_CURRENCIES.filter(
    (currency) => !accounts[currency],
  )
  const activeAccount = accounts[activeCurrency] ?? EMPTY_ACCOUNT

  if (role !== 'owner' && role !== 'admin') return null

  function updateField(field: keyof InvoicePaymentAccount, nextValue: string) {
    setAccounts((current) => ({
      ...current,
      [activeCurrency]: {
        ...(current[activeCurrency] ?? EMPTY_ACCOUNT),
        [field]: nextValue || null,
      },
    }))
  }

  function addCurrency() {
    if (!currencyToAdd) return
    setAccounts((current) => ({
      ...current,
      [currencyToAdd]: { ...EMPTY_ACCOUNT },
    }))
    setActiveCurrency(currencyToAdd)
    setCurrencyToAdd('')
  }

  function removeActiveCurrency() {
    if (activeCurrency === 'SEK') return
    setAccounts((current) => {
      const next = { ...current }
      delete next[activeCurrency]
      return next
    })
    setActiveCurrency('SEK')
  }

  function reloadServerAccounts() {
    accountsRef.current = serverAccounts
    setAccounts(serverAccounts)
    if (!serverAccounts[activeCurrency]) setActiveCurrency('SEK')
    setHasExternalUpdate(false)
  }

  function validationError(): string | null {
    // An added foreign-currency tab is a real configuration immediately. It
    // must have an IBAN before save; the Remove action discards placeholders.
    for (const currency of configuredCurrencies) {
      const account = normalizeInvoicePaymentAccount(accounts[currency] ?? EMPTY_ACCOUNT)
      if (account.clearing_number && !/^\d{4,5}$/.test(account.clearing_number)) {
        return t('validation_clearing', { currency })
      }
      if (account.account_number && !/^\d{6,12}$/.test(account.account_number)) {
        return t('validation_account_number', { currency })
      }
      if (account.bankgiro && !validateBankgiroNumber(account.bankgiro)) {
        return t('validation_bankgiro', { currency })
      }
      if (account.plusgiro && !validatePlusgiroNumber(account.plusgiro)) {
        return t('validation_plusgiro', { currency })
      }
      if (account.swish && !isValidSwish(normaliseSwish(account.swish))) {
        return t('validation_swish', { currency })
      }
      if (account.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(account.iban)) {
        return t('validation_iban', { currency })
      }
      if (account.bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(account.bic)) {
        return t('validation_bic', { currency })
      }
      if (currency !== 'SEK' && !account.iban) {
        return t('validation_foreign_iban', { currency })
      }
    }
    return null
  }

  async function save() {
    if (hasExternalUpdate) {
      toast({
        title: t('conflict_title'),
        description: t('conflict_description'),
        variant: 'destructive',
      })
      return
    }

    const error = validationError()
    if (error) {
      toast({ title: t('validation_title'), description: error, variant: 'destructive' })
      return
    }

    const normalized = Object.fromEntries([
      [
        'SEK',
        normalizeInvoicePaymentAccount(accounts.SEK ?? EMPTY_ACCOUNT),
      ],
      ...configuredCurrencies.filter((currency) => currency !== 'SEK').map((currency) => [
        currency,
        normalizeInvoicePaymentAccount(accounts[currency] ?? EMPTY_ACCOUNT),
      ]),
    ]) as Partial<Record<Currency, InvoicePaymentAccount>>
    const sek = normalized.SEK!
    const updates: Partial<CompanySettings> = {
      invoice_payment_accounts: normalized,
      // The legacy fields are an exact nullable SEK mirror. Clearing SEK is
      // intentional and must not leave stale payment instructions behind.
      bank_name: sek.bank_name,
      clearing_number: sek.clearing_number,
      account_number: sek.account_number,
      bankgiro: sek.bankgiro,
      plusgiro: sek.plusgiro,
      swish: sek.swish,
      iban: sek.iban,
      bic: sek.bic,
    }

    setIsSaving(true)
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!response.ok) {
        const result = await response.json()
        throw new Error(typeof result.error === 'string' ? result.error : t('save_failed'))
      }
      accountsRef.current = normalized
      setAccounts(normalized)
      onUpdate(updates)
      toast({ title: t('saved_title'), description: t('saved_description') })
    } catch (error) {
      toast({
        title: t('save_failed_title'),
        description: error instanceof Error ? getUserErrorMessage(error) : t('save_failed'),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <SettingsGroup label={t('heading')} help={t('description')}>
      {hasExternalUpdate && (
        <div
          role="alert"
          className="mt-3 flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('conflict_title')}</p>
            <p className="text-sm text-muted-foreground">{t('conflict_description')}</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={reloadServerAccounts}>
            {t('reload_server_values')}
          </Button>
        </div>
      )}

      <SettingsRow label={t('currency_tabs_label')}>
        <SettingsSeg
          value={activeCurrency}
          onChange={(currency) => setActiveCurrency(currency)}
          options={configuredCurrencies.map((currency) => ({ value: currency, label: currency }))}
          aria-label={t('currency_tabs_label')}
        />
        {activeCurrency !== 'SEK' && (
          <SettingsRowNote>
            {t('foreign_account_hint', { currency: activeCurrency })}
          </SettingsRowNote>
        )}
        {activeCurrency !== 'SEK' && (
          <SettingsRowEnd>
            <button
              type="button"
              onClick={removeActiveCurrency}
              className="text-xs text-muted-foreground transition-colors duration-150 hover:text-destructive"
            >
              {t('remove_currency')}
            </button>
          </SettingsRowEnd>
        )}
      </SettingsRow>

      {availableCurrencies.length > 0 && (
        <SettingsRow label={t('add_currency_label')}>
          <SettingsSelect
            value={currencyToAdd}
            onChange={(event) => setCurrencyToAdd(event.target.value as Currency | '')}
            aria-label={t('add_currency_label')}
          >
            <option value="">{t('add_currency_placeholder')}</option>
            {availableCurrencies.map((currency) => (
              <option key={currency} value={currency}>{currency}</option>
            ))}
          </SettingsSelect>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addCurrency}
            disabled={!currencyToAdd}
          >
            {t('add_currency')}
          </Button>
        </SettingsRow>
      )}

      <SettingsRow label={t('bank_label')}>
        {/* Typeahead combobox stays boxed on purpose: it is a picker, not a field. */}
        <div className="min-w-0 flex-1 sm:max-w-64">
          <BankNameCombobox
            aria-label={t('bank_label')}
            value={value(activeAccount, 'bank_name')}
            onChange={(next) => updateField('bank_name', next)}
            enableBankingEnabled={hasBankingExtension}
          />
        </div>
      </SettingsRow>
      <SettingsRow
        label={t('clearing_label')}
        htmlFor={`payment-clearing-${activeCurrency}`}
        align="baseline"
      >
        <SettingsInput
          id={`payment-clearing-${activeCurrency}`}
          inputMode="numeric"
          maxLength={5}
          value={value(activeAccount, 'clearing_number')}
          onChange={(event) => updateField('clearing_number', event.target.value.replace(/\D/g, ''))}
          className="max-w-24 flex-none tabular-nums"
        />
      </SettingsRow>
      <SettingsRow
        label={t('account_number_label')}
        htmlFor={`payment-account-${activeCurrency}`}
        align="baseline"
      >
        <SettingsInput
          id={`payment-account-${activeCurrency}`}
          inputMode="numeric"
          maxLength={12}
          value={value(activeAccount, 'account_number')}
          onChange={(event) => updateField('account_number', event.target.value.replace(/\D/g, ''))}
          className="max-w-40 flex-none tabular-nums"
        />
      </SettingsRow>
      <SettingsRow
        label={t('bankgiro_label')}
        htmlFor={`payment-bankgiro-${activeCurrency}`}
        align="baseline"
      >
        <SettingsInput
          id={`payment-bankgiro-${activeCurrency}`}
          value={value(activeAccount, 'bankgiro')}
          onChange={(event) => updateField('bankgiro', event.target.value)}
          className="max-w-40 flex-none tabular-nums"
        />
      </SettingsRow>
      <SettingsRow
        label={t('plusgiro_label')}
        htmlFor={`payment-plusgiro-${activeCurrency}`}
        align="baseline"
      >
        <SettingsInput
          id={`payment-plusgiro-${activeCurrency}`}
          value={value(activeAccount, 'plusgiro')}
          onChange={(event) => updateField('plusgiro', event.target.value)}
          className="max-w-40 flex-none tabular-nums"
        />
      </SettingsRow>
      <SettingsRow
        label={t('swish_label')}
        htmlFor={`payment-swish-${activeCurrency}`}
        align="baseline"
      >
        <SettingsInput
          id={`payment-swish-${activeCurrency}`}
          value={value(activeAccount, 'swish')}
          onChange={(event) => updateField('swish', event.target.value)}
          className="max-w-40 flex-none tabular-nums"
        />
      </SettingsRow>
      <SettingsRow
        label={
          activeCurrency !== 'SEK'
            ? `${t('iban_label')} ${t('required_suffix')}`
            : t('iban_label')
        }
        htmlFor={`payment-iban-${activeCurrency}`}
        align="baseline"
      >
        <SettingsInput
          id={`payment-iban-${activeCurrency}`}
          value={value(activeAccount, 'iban')}
          onChange={(event) => updateField('iban', event.target.value.toUpperCase())}
          placeholder="SE00 0000 0000 0000 0000 0000"
          className="tabular-nums"
        />
      </SettingsRow>
      <SettingsRow
        label={t('bic_label')}
        htmlFor={`payment-bic-${activeCurrency}`}
        align="baseline"
      >
        <SettingsInput
          id={`payment-bic-${activeCurrency}`}
          maxLength={11}
          value={value(activeAccount, 'bic')}
          onChange={(event) => updateField('bic', event.target.value.toUpperCase())}
          className="max-w-32 flex-none tabular-nums"
        />
      </SettingsRow>

      <div className="flex justify-end px-1 pt-4">
        <Button type="button" size="sm" onClick={save} disabled={isSaving || hasExternalUpdate}>
          {isSaving ? t('saving') : t('save')}
        </Button>
      </div>
    </SettingsGroup>
  )
}

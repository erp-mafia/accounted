'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { BankNameCombobox } from '@/components/settings/BankNameCombobox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
    <section className="space-y-5">
      <div className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('heading')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {hasExternalUpdate && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between"
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

      <div className="flex flex-wrap gap-2" aria-label={t('currency_tabs_label')}>
        {configuredCurrencies.map((currency) => (
          <Button
            key={currency}
            type="button"
            size="sm"
            variant={activeCurrency === currency ? 'default' : 'outline'}
            onClick={() => setActiveCurrency(currency)}
          >
            {currency}
          </Button>
        ))}
      </div>

      {availableCurrencies.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="w-full space-y-2 sm:max-w-52">
            <Label>{t('add_currency_label')}</Label>
            <Select
              value={currencyToAdd}
              onValueChange={(next) => setCurrencyToAdd(next as Currency)}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('add_currency_placeholder')} />
              </SelectTrigger>
              <SelectContent>
                {availableCurrencies.map((currency) => (
                  <SelectItem key={currency} value={currency}>{currency}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="button" variant="outline" onClick={addCurrency} disabled={!currencyToAdd}>
            {t('add_currency')}
          </Button>
        </div>
      )}

      <div className="space-y-4 rounded-lg border border-border p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-medium">{t('account_heading', { currency: activeCurrency })}</h3>
            {activeCurrency !== 'SEK' && (
              <p className="text-xs text-muted-foreground">{t('foreign_account_hint')}</p>
            )}
          </div>
          {activeCurrency !== 'SEK' && (
            <Button type="button" variant="ghost" size="sm" onClick={removeActiveCurrency}>
              {t('remove_currency')}
            </Button>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>{t('bank_label')}</Label>
            <BankNameCombobox
              value={value(activeAccount, 'bank_name')}
              onChange={(next) => updateField('bank_name', next)}
              enableBankingEnabled={hasBankingExtension}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`payment-clearing-${activeCurrency}`}>{t('clearing_label')}</Label>
            <Input
              id={`payment-clearing-${activeCurrency}`}
              inputMode="numeric"
              maxLength={5}
              value={value(activeAccount, 'clearing_number')}
              onChange={(event) => updateField('clearing_number', event.target.value.replace(/\D/g, ''))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`payment-account-${activeCurrency}`}>{t('account_number_label')}</Label>
            <Input
              id={`payment-account-${activeCurrency}`}
              inputMode="numeric"
              maxLength={12}
              value={value(activeAccount, 'account_number')}
              onChange={(event) => updateField('account_number', event.target.value.replace(/\D/g, ''))}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor={`payment-bankgiro-${activeCurrency}`}>{t('bankgiro_label')}</Label>
            <Input
              id={`payment-bankgiro-${activeCurrency}`}
              value={value(activeAccount, 'bankgiro')}
              onChange={(event) => updateField('bankgiro', event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`payment-plusgiro-${activeCurrency}`}>{t('plusgiro_label')}</Label>
            <Input
              id={`payment-plusgiro-${activeCurrency}`}
              value={value(activeAccount, 'plusgiro')}
              onChange={(event) => updateField('plusgiro', event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`payment-swish-${activeCurrency}`}>{t('swish_label')}</Label>
            <Input
              id={`payment-swish-${activeCurrency}`}
              value={value(activeAccount, 'swish')}
              onChange={(event) => updateField('swish', event.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor={`payment-iban-${activeCurrency}`}>
              {t('iban_label')}{activeCurrency !== 'SEK' ? ` ${t('required_suffix')}` : ''}
            </Label>
            <Input
              id={`payment-iban-${activeCurrency}`}
              value={value(activeAccount, 'iban')}
              onChange={(event) => updateField('iban', event.target.value.toUpperCase())}
              placeholder="SE00 0000 0000 0000 0000 0000"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`payment-bic-${activeCurrency}`}>{t('bic_label')}</Label>
            <Input
              id={`payment-bic-${activeCurrency}`}
              maxLength={11}
              value={value(activeAccount, 'bic')}
              onChange={(event) => updateField('bic', event.target.value.toUpperCase())}
            />
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="button" onClick={save} disabled={isSaving || hasExternalUpdate}>
          {isSaving ? t('saving') : t('save')}
        </Button>
      </div>
    </section>
  )
}

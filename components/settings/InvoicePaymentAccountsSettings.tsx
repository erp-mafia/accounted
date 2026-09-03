'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BankNameCombobox } from '@/components/settings/BankNameCombobox'
import {
  SettingsGroup,
  SettingsInput,
  SettingsReveal,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { createClient } from '@/lib/supabase/client'
import { formatIbanGroups } from '@/lib/company/connection-iban'
import { bankgiroFromTicSnapshot } from '@/lib/company/snapshot-bank'
import { formatBankgiroNumber, validateBankgiroNumber, validatePlusgiroNumber } from '@/lib/bankgiro/luhn'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import {
  INVOICE_PAYMENT_ACCOUNT_CURRENCIES,
  bankCodeLabelKey,
  hasNonIbanForeignRouting,
  isNonIbanCurrency,
  normalizeInvoicePaymentAccount,
} from '@/lib/invoices/payment-accounts'
import { cashAccountPayee, isUsableInvoicePayee } from '@/lib/cash-accounts/invoice-payee'
import { isValidSwish, normaliseSwish } from '@/lib/payments/swish'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import type {
  CashAccount,
  CashAccountPayeeFields,
  CompanySettings,
  Currency,
  InvoicePayeeDefault,
  InvoicePaymentAccount,
} from '@/types'

interface InvoicePaymentAccountsSettingsProps {
  settings: CompanySettings
  onUpdate: (updates: Partial<CompanySettings>) => void
}

type PayeeForm = Record<keyof CashAccountPayeeFields, string> & { name: string }

const NONE = '__none__'

function formFromAccount(account: CashAccount): PayeeForm {
  return {
    name: account.name ?? '',
    bank_name: account.bank_name ?? '',
    clearing_number: account.clearing_number ?? '',
    account_number: account.account_number ?? '',
    bankgiro: account.bankgiro ?? '',
    plusgiro: account.plusgiro ?? '',
    swish: account.swish ?? '',
    iban: account.iban ?? '',
    bic: account.bic ?? '',
    bank_code: account.bank_code ?? '',
    foreign_account_number: account.foreign_account_number ?? '',
  }
}

const EMPTY_FORM: PayeeForm = {
  name: '',
  bank_name: '',
  clearing_number: '',
  account_number: '',
  bankgiro: '',
  plusgiro: '',
  swish: '',
  iban: '',
  bic: '',
  bank_code: '',
  foreign_account_number: '',
}

/** "Företagskonto (1930)" or the bare ledger account when the row has no name. */
function accountLabel(account: CashAccount): string {
  const name = account.name?.trim()
  return name ? `${name} (${account.ledger_account})` : account.ledger_account
}

/** One-line summary of what the account prints: "BG 5050-1234 · IBAN SE12 ...". */
function payeeSummary(account: CashAccount): string {
  const payee = cashAccountPayee(account)
  const parts: string[] = []
  if (payee.bankgiro) parts.push(`BG ${payee.bankgiro}`)
  if (payee.plusgiro) parts.push(`PG ${payee.plusgiro}`)
  if (payee.clearing_number && payee.account_number) parts.push(`${payee.clearing_number}-${payee.account_number}`)
  if (payee.swish) parts.push(`Swish ${payee.swish}`)
  if (payee.iban) parts.push(`IBAN ${formatIbanGroups(payee.iban)}`)
  if (!payee.iban && payee.bank_code && payee.foreign_account_number) {
    parts.push(`${payee.bank_code} ${payee.foreign_account_number}`)
  }
  return parts.join(' · ')
}

/**
 * Same field rules as InvoicePaymentAccountSchema, so the form rejects what
 * the route would reject. `currency` is the account's own currency: a SEK
 * account may carry an IBAN and serve as the EUR default, and the
 * currency-specific "IBAN required" rule is enforced where the default is
 * picked (only usable accounts are offered), not here.
 */
function validateForm(form: PayeeForm, currency: string, t: (key: string, values?: Record<string, string>) => string): string | null {
  const account = normalizeInvoicePaymentAccount(form)
  if (account.clearing_number && !/^\d{4,5}$/.test(account.clearing_number)) return t('validation_clearing', { currency })
  if (account.account_number && !/^\d{6,12}$/.test(account.account_number)) return t('validation_account_number', { currency })
  if (account.bankgiro && !validateBankgiroNumber(account.bankgiro)) return t('validation_bankgiro', { currency })
  if (account.plusgiro && !validatePlusgiroNumber(account.plusgiro)) return t('validation_plusgiro', { currency })
  if (account.swish && !isValidSwish(normaliseSwish(account.swish))) return t('validation_swish', { currency })
  if (account.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(account.iban)) return t('validation_iban', { currency })
  if (account.bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(account.bic)) return t('validation_bic', { currency })
  if (account.bank_code && !/^\d{2,3}(-?\d{2,3}){1,2}$|^\d{6,9}$/.test(account.bank_code)) return t('validation_bank_code', { currency })
  if (account.foreign_account_number && !/^[A-Za-z0-9-]{4,34}$/.test(account.foreign_account_number)) {
    return t('validation_foreign_account_number', { currency })
  }
  if (currency !== 'SEK' && !account.iban) {
    if (isNonIbanCurrency(currency as Currency)) {
      if (!hasNonIbanForeignRouting(account)) return t('validation_foreign_non_iban', { currency })
    } else {
      return t('validation_foreign_iban', { currency })
    }
  }
  return null
}

function payeeBody(form: PayeeForm): Record<string, string | null> {
  const body: Record<string, string | null> = {}
  for (const key of Object.keys(form) as (keyof PayeeForm)[]) {
    const value = form[key].trim()
    body[key] = value ? value : null
  }
  return body
}

/**
 * Bank accounts customers pay to. Each of the company's bank accounts can
 * carry its own bankgiro, plusgiro, clearing + account number, IBAN and
 * Swish; per currency one of them is the default an invoice prints, and the
 * invoice editor lets the user pick another. Backed by cash_accounts and
 * invoice_payee_defaults (migration 20260903150000); the legacy per-currency
 * map on company_settings is mirrored from here by a trigger.
 */
export function InvoicePaymentAccountsSettings({
  settings,
  onUpdate,
}: InvoicePaymentAccountsSettingsProps) {
  const t = useTranslations('settings_invoice_payment_accounts')
  const { toast } = useToast()
  const { role, company } = useCompany()
  const hasBankingExtension = ENABLED_EXTENSION_IDS.has('enable-banking')

  const [accounts, setAccounts] = useState<CashAccount[]>([])
  const [defaults, setDefaults] = useState<InvoicePayeeDefault[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<PayeeForm>(EMPTY_FORM)
  const [isSaving, setIsSaving] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const [newCurrency, setNewCurrency] = useState<Currency>('SEK')
  const [currencyToAdd, setCurrencyToAdd] = useState<Currency | ''>('')
  const [extraCurrencies, setExtraCurrencies] = useState<Currency[]>([])
  const [snapshotBankgiro, setSnapshotBankgiro] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/cash-accounts/payee-defaults')
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(getUserErrorMessage(json, { context: 'settings', statusCode: res.status }))
    const data = json.data as { accounts: CashAccount[]; defaults: InvoicePayeeDefault[] }
    setAccounts(data.accounts)
    setDefaults(data.defaults)
    return data
  }, [])

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    load()
      .catch((err) => {
        if (!cancelled) toast({ title: t('load_failed'), description: getUserErrorMessage(err), variant: 'destructive' })
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [load, t, toast])

  // Bolagsverket knows most companies' bankgiro (companies.tic_snapshot).
  // Offer it as a one-click prefill on a SEK account with no bankgiro; the
  // user still saves. Only when the snapshot's orgNumber matches this company.
  useEffect(() => {
    if (!company?.id) return
    const supabase = createClient()
    let cancelled = false
    supabase
      .from('companies')
      .select('tic_snapshot, org_number')
      .eq('id', company.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        setSnapshotBankgiro(bankgiroFromTicSnapshot(data?.tic_snapshot, data?.org_number))
      })
    return () => {
      cancelled = true
    }
  }, [company?.id])

  const defaultByCurrency = useMemo(
    () => new Map(defaults.map((d) => [d.currency, d.cash_account_id] as const)),
    [defaults],
  )
  const editingAccount = useMemo(
    () => accounts.find((a) => a.id === editingId) ?? null,
    [accounts, editingId],
  )
  // Legacy entries: payment instructions saved per currency before accounts
  // existed, with no account to land on. They still print (the resolver
  // falls back to them) until the user attaches them to an account.
  const unlinkedCurrencies = useMemo(
    () =>
      INVOICE_PAYMENT_ACCOUNT_CURRENCIES.filter(
        (currency) => settings.invoice_payment_accounts?.[currency] && !defaultByCurrency.has(currency),
      ),
    [settings.invoice_payment_accounts, defaultByCurrency],
  )
  const shownCurrencies = useMemo(() => {
    const set = new Set<Currency>(['SEK', ...defaultByCurrency.keys() as Iterable<Currency>, ...unlinkedCurrencies, ...extraCurrencies])
    return INVOICE_PAYMENT_ACCOUNT_CURRENCIES.filter((c) => set.has(c))
  }, [defaultByCurrency, unlinkedCurrencies, extraCurrencies])
  const addableCurrencies = INVOICE_PAYMENT_ACCOUNT_CURRENCIES.filter((c) => !shownCurrencies.includes(c))

  if (role !== 'owner' && role !== 'admin') return null

  function startEdit(account: CashAccount) {
    setIsAdding(false)
    setEditingId(account.id)
    setForm(formFromAccount(account))
  }

  function startAdd() {
    setEditingId(null)
    setIsAdding(true)
    setNewCurrency('SEK')
    setForm(EMPTY_FORM)
  }

  function cancelEdit() {
    setEditingId(null)
    setIsAdding(false)
    setForm(EMPTY_FORM)
  }

  function updateField(field: keyof PayeeForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function afterWrite(description: string) {
    const fresh = await load()
    await invalidateReferenceData(['ref:cash-accounts', 'company_settings'])
    // The mirror trigger rewrote the legacy map from the default accounts;
    // derive the same values here so sibling forms (the invoice editor's
    // bank-details check) see the payee without another settings round trip.
    const map: Partial<Record<Currency, InvoicePaymentAccount>> = { ...(settings.invoice_payment_accounts ?? {}) }
    for (const row of fresh.defaults) {
      const account = fresh.accounts.find((a) => a.id === row.cash_account_id)
      if (account) map[row.currency] = cashAccountPayee(account)
    }
    const sek = map.SEK
    onUpdate({
      invoice_payment_accounts: map,
      bank_name: sek?.bank_name ?? null,
      clearing_number: sek?.clearing_number ?? null,
      account_number: sek?.account_number ?? null,
      bankgiro: sek?.bankgiro ?? null,
      plusgiro: sek?.plusgiro ?? null,
      swish: sek?.swish ?? null,
      iban: sek?.iban ?? null,
      bic: sek?.bic ?? null,
    })
    toast({ title: t('saved_title'), description })
  }

  async function saveEdit() {
    if (!editingAccount) return
    const error = validateForm(form, editingAccount.currency, t)
    if (error) {
      toast({ title: t('validation_title'), description: error, variant: 'destructive' })
      return
    }
    setIsSaving(true)
    try {
      const res = await fetch(`/api/cash-accounts/${editingAccount.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payeeBody(form), invoice_payee: true }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(getUserErrorMessage(json, { context: 'settings', statusCode: res.status }))
      cancelEdit()
      await afterWrite(t('saved_account', { account: accountLabel(editingAccount) }))
    } catch (err) {
      toast({ title: t('save_failed_title'), description: getUserErrorMessage(err), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  async function saveNew() {
    if (!form.name.trim()) {
      toast({ title: t('validation_title'), description: t('validation_name'), variant: 'destructive' })
      return
    }
    const error = validateForm(form, newCurrency, t)
    if (error) {
      toast({ title: t('validation_title'), description: error, variant: 'destructive' })
      return
    }
    setIsSaving(true)
    try {
      const { name, ...payee } = payeeBody(form)
      const res = await fetch('/api/cash-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, currency: newCurrency, invoice_payee: true, payee }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(getUserErrorMessage(json, { context: 'settings', statusCode: res.status }))
      const created = json.data as CashAccount
      // First usable account for its currency becomes the default so the
      // user does not have to find the selector below.
      if (!defaultByCurrency.has(newCurrency) && isUsableInvoicePayee(created, newCurrency)) {
        await setDefault(newCurrency, created.id, { silent: true })
      }
      cancelEdit()
      await afterWrite(t('saved_account', { account: accountLabel(created) }))
    } catch (err) {
      toast({ title: t('save_failed_title'), description: getUserErrorMessage(err), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  async function setDefault(currency: Currency, cashAccountId: string | null, opts: { silent?: boolean } = {}) {
    const res = await fetch('/api/cash-accounts/payee-defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency, cash_account_id: cashAccountId }),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(getUserErrorMessage(json, { context: 'settings', statusCode: res.status }))
    if (!opts.silent) {
      const account = accounts.find((a) => a.id === cashAccountId)
      await afterWrite(
        account
          ? t('saved_default', { currency, account: accountLabel(account) })
          : t('cleared_default', { currency }),
      )
    }
  }

  async function handleDefaultChange(currency: Currency, value: string) {
    setIsSaving(true)
    try {
      await setDefault(currency, value === NONE ? null : value)
    } catch (err) {
      toast({ title: t('save_failed_title'), description: getUserErrorMessage(err), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  /** Attach a legacy per-currency entry to an account: copy its fields, then make it the default. */
  async function attachUnlinked(currency: Currency, cashAccountId: string) {
    const entry = settings.invoice_payment_accounts?.[currency]
    if (!entry) return
    setIsSaving(true)
    try {
      const account = accounts.find((a) => a.id === cashAccountId)
      const payee: Partial<InvoicePaymentAccount> = normalizeInvoicePaymentAccount(entry)
      const body: Record<string, unknown> = { invoice_payee: true }
      for (const [key, value] of Object.entries(payee)) {
        // Keep what the account already has (a connected IBAN is the bank's word).
        if (value && !(account as unknown as Record<string, unknown> | undefined)?.[key]) body[key] = value
      }
      const res = await fetch(`/api/cash-accounts/${cashAccountId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(getUserErrorMessage(json, { context: 'settings', statusCode: res.status }))
      await setDefault(currency, cashAccountId)
    } catch (err) {
      toast({ title: t('save_failed_title'), description: getUserErrorMessage(err), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  function renderPayeeFields(currency: string, idPrefix: string) {
    const showBankgiroPrefill = currency === 'SEK' && !form.bankgiro && !!snapshotBankgiro
    return (
      <>
        <SettingsRow label={t('bank_label')}>
          <div className="min-w-0 flex-1 sm:max-w-64">
            <BankNameCombobox
              aria-label={t('bank_label')}
              value={form.bank_name}
              onChange={(next) => updateField('bank_name', next)}
              enableBankingEnabled={hasBankingExtension}
            />
          </div>
        </SettingsRow>
        <SettingsRow label={t('clearing_label')} htmlFor={`${idPrefix}-clearing`} align="baseline">
          <SettingsInput
            id={`${idPrefix}-clearing`}
            inputMode="numeric"
            maxLength={5}
            value={form.clearing_number}
            onChange={(event) => updateField('clearing_number', event.target.value.replace(/\D/g, ''))}
            className="max-w-24 flex-none tabular-nums"
          />
        </SettingsRow>
        <SettingsRow label={t('account_number_label')} htmlFor={`${idPrefix}-account`} align="baseline">
          <SettingsInput
            id={`${idPrefix}-account`}
            inputMode="numeric"
            maxLength={12}
            value={form.account_number}
            onChange={(event) => updateField('account_number', event.target.value.replace(/\D/g, ''))}
            className="max-w-40 flex-none tabular-nums"
          />
        </SettingsRow>
        <SettingsRow label={t('bankgiro_label')} htmlFor={`${idPrefix}-bankgiro`} align="baseline">
          <SettingsInput
            id={`${idPrefix}-bankgiro`}
            value={form.bankgiro}
            onChange={(event) => updateField('bankgiro', event.target.value)}
            className="max-w-40 flex-none tabular-nums"
          />
          {showBankgiroPrefill && snapshotBankgiro && (
            <button
              type="button"
              onClick={() => updateField('bankgiro', formatBankgiroNumber(snapshotBankgiro))}
              className="text-xs text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-foreground"
            >
              {t('bankgiro_prefill', { value: formatBankgiroNumber(snapshotBankgiro) })}
            </button>
          )}
        </SettingsRow>
        <SettingsRow label={t('plusgiro_label')} htmlFor={`${idPrefix}-plusgiro`} align="baseline">
          <SettingsInput
            id={`${idPrefix}-plusgiro`}
            value={form.plusgiro}
            onChange={(event) => updateField('plusgiro', event.target.value)}
            className="max-w-40 flex-none tabular-nums"
          />
        </SettingsRow>
        <SettingsRow label={t('swish_label')} htmlFor={`${idPrefix}-swish`} align="baseline">
          <SettingsInput
            id={`${idPrefix}-swish`}
            value={form.swish}
            onChange={(event) => updateField('swish', event.target.value)}
            className="max-w-40 flex-none tabular-nums"
          />
        </SettingsRow>
        {isNonIbanCurrency(currency as Currency) && (
          <>
            <SettingsRow label={t(bankCodeLabelKey(currency as Currency))} htmlFor={`${idPrefix}-bank-code`} align="baseline">
              <SettingsInput
                id={`${idPrefix}-bank-code`}
                inputMode="numeric"
                maxLength={11}
                value={form.bank_code}
                onChange={(event) => updateField('bank_code', event.target.value.replace(/[^\d-]/g, ''))}
                placeholder={currency === 'USD' ? '021000021' : '12-34-56'}
                className="max-w-40 flex-none tabular-nums"
              />
            </SettingsRow>
            <SettingsRow label={t('foreign_account_number_label')} htmlFor={`${idPrefix}-foreign-account`} align="baseline">
              <SettingsInput
                id={`${idPrefix}-foreign-account`}
                maxLength={34}
                value={form.foreign_account_number}
                onChange={(event) => updateField('foreign_account_number', event.target.value.replace(/\s/g, ''))}
                className="max-w-56 flex-none tabular-nums"
              />
            </SettingsRow>
            <SettingsRowNote>{t('non_iban_hint', { currency })}</SettingsRowNote>
          </>
        )}
        <SettingsRow label={t('iban_label')} htmlFor={`${idPrefix}-iban`} align="baseline">
          <SettingsInput
            id={`${idPrefix}-iban`}
            value={form.iban}
            onChange={(event) => updateField('iban', event.target.value.toUpperCase())}
            placeholder="SE00 0000 0000 0000 0000 0000"
            className="tabular-nums"
          />
        </SettingsRow>
        <SettingsRow label={t('bic_label')} htmlFor={`${idPrefix}-bic`} align="baseline" borderless>
          <SettingsInput
            id={`${idPrefix}-bic`}
            maxLength={11}
            value={form.bic}
            onChange={(event) => updateField('bic', event.target.value.toUpperCase())}
            className="max-w-32 flex-none tabular-nums"
          />
        </SettingsRow>
      </>
    )
  }

  return (
    <SettingsGroup label={t('heading')} help={t('description')}>
      {isLoading ? (
        <div className="flex items-center gap-2 px-1 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('loading')}
        </div>
      ) : (
        <>
          {accounts.length === 0 && !isAdding && (
            <p className="px-1 py-3 text-sm text-muted-foreground">{t('empty')}</p>
          )}
          {accounts.map((account) => {
            const defaultFor = shownCurrencies.filter((c) => defaultByCurrency.get(c) === account.id)
            const summary = payeeSummary(account)
            const isEditing = editingId === account.id
            return (
              <div key={account.id}>
                <SettingsRow label={accountLabel(account)} borderless={isEditing}>
                  <span className="min-w-0 truncate tabular-nums" data-ph-mask="">
                    {summary || <span className="text-muted-foreground">{t('no_payee_details')}</span>}
                  </span>
                  {defaultFor.length > 0 && (
                    <SettingsRowNote>{t('default_for', { currencies: defaultFor.join(', ') })}</SettingsRowNote>
                  )}
                  {!account.invoice_payee && summary && (
                    <SettingsRowNote>{t('hidden_on_invoices')}</SettingsRowNote>
                  )}
                  <SettingsRowEnd>
                    <button
                      type="button"
                      onClick={() => (isEditing ? cancelEdit() : startEdit(account))}
                      className="text-xs text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-foreground"
                    >
                      {isEditing ? t('cancel') : t('edit')}
                    </button>
                  </SettingsRowEnd>
                </SettingsRow>
                <SettingsReveal open={isEditing}>
                  {isEditing && (
                    <>
                      <SettingsRow label={t('name_label')} htmlFor={`payee-${account.id}-name`} align="baseline">
                        <SettingsInput
                          id={`payee-${account.id}-name`}
                          value={form.name}
                          onChange={(event) => updateField('name', event.target.value)}
                          className="max-w-64"
                        />
                        <SettingsRowNote>{account.currency} · {account.ledger_account}</SettingsRowNote>
                      </SettingsRow>
                      {renderPayeeFields(account.currency, `payee-${account.id}`)}
                      <div className="flex justify-end gap-2 px-1 py-3">
                        <Button type="button" variant="outline" size="sm" onClick={cancelEdit} disabled={isSaving}>
                          {t('cancel')}
                        </Button>
                        <Button type="button" size="sm" onClick={saveEdit} disabled={isSaving}>
                          {isSaving ? t('saving') : t('save_account')}
                        </Button>
                      </div>
                    </>
                  )}
                </SettingsReveal>
              </div>
            )
          })}

          {!isAdding ? (
            <div className="flex justify-end px-1 py-3">
              <Button type="button" variant="outline" size="sm" onClick={startAdd} disabled={isSaving}>
                {t('add_account')}
              </Button>
            </div>
          ) : (
            <div className="mt-2 border-t border-border">
              <SettingsRow label={t('name_label')} htmlFor="payee-new-name" align="baseline">
                <SettingsInput
                  id="payee-new-name"
                  value={form.name}
                  onChange={(event) => updateField('name', event.target.value)}
                  placeholder={t('name_placeholder')}
                  className="max-w-64"
                />
              </SettingsRow>
              <SettingsRow label={t('currency_label')} htmlFor="payee-new-currency">
                <SettingsSelect
                  id="payee-new-currency"
                  value={newCurrency}
                  onChange={(event) => setNewCurrency(event.target.value as Currency)}
                  aria-label={t('currency_label')}
                >
                  {INVOICE_PAYMENT_ACCOUNT_CURRENCIES.map((currency) => (
                    <option key={currency} value={currency}>{currency}</option>
                  ))}
                </SettingsSelect>
              </SettingsRow>
              {renderPayeeFields(newCurrency, 'payee-new')}
              <div className="flex justify-end gap-2 px-1 py-3">
                <Button type="button" variant="outline" size="sm" onClick={cancelEdit} disabled={isSaving}>
                  {t('cancel')}
                </Button>
                <Button type="button" size="sm" onClick={saveNew} disabled={isSaving}>
                  {isSaving ? t('saving') : t('create_account')}
                </Button>
              </div>
            </div>
          )}

          <p className="mt-6 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('defaults_heading')}
          </p>
          {shownCurrencies.map((currency, i) => {
            const usable = accounts.filter((a) => isUsableInvoicePayee(a, currency))
            const current = defaultByCurrency.get(currency) ?? NONE
            const unlinked = unlinkedCurrencies.includes(currency)
            return (
              <SettingsRow
                key={currency}
                label={t('default_label', { currency })}
                htmlFor={`payee-default-${currency}`}
                borderless={i === shownCurrencies.length - 1 && addableCurrencies.length === 0}
              >
                <SettingsSelect
                  id={`payee-default-${currency}`}
                  value={current}
                  onChange={(event) => {
                    const value = event.target.value
                    if (unlinked && value !== NONE) void attachUnlinked(currency, value)
                    else void handleDefaultChange(currency, value)
                  }}
                  disabled={isSaving}
                  aria-label={t('default_label', { currency })}
                >
                  <option value={NONE}>{unlinked ? t('default_unlinked_option') : t('default_none')}</option>
                  {usable.map((account) => (
                    <option key={account.id} value={account.id}>{accountLabel(account)}</option>
                  ))}
                </SettingsSelect>
                {unlinked && <SettingsRowNote>{t('unlinked_hint', { currency })}</SettingsRowNote>}
                {!unlinked && usable.length === 0 && (
                  <SettingsRowNote>{t(currency === 'SEK' ? 'no_usable_sek' : 'no_usable_foreign', { currency })}</SettingsRowNote>
                )}
              </SettingsRow>
            )
          })}
          {addableCurrencies.length > 0 && (
            <SettingsRow label={t('add_currency_label')} borderless>
              <SettingsSelect
                value={currencyToAdd}
                onChange={(event) => setCurrencyToAdd(event.target.value as Currency | '')}
                aria-label={t('add_currency_label')}
              >
                <option value="">{t('add_currency_placeholder')}</option>
                {addableCurrencies.map((currency) => (
                  <option key={currency} value={currency}>{currency}</option>
                ))}
              </SettingsSelect>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!currencyToAdd}
                onClick={() => {
                  if (!currencyToAdd) return
                  setExtraCurrencies((current) => [...current, currencyToAdd])
                  setCurrencyToAdd('')
                }}
              >
                {t('add_currency')}
              </Button>
            </SettingsRow>
          )}
        </>
      )}
    </SettingsGroup>
  )
}

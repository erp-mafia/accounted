'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsBackLink,
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSectionHeader,
} from '@/components/settings/SettingsRows'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useFormat } from '@/lib/hooks/use-format'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import {
  fetchCompanyVerification,
  fetchPaymentsAvailability,
  PaymentsClientError,
  startCompanyVerification,
  type CompanyVerification,
  type PaymentsAvailability,
} from '@/components/payments/payments-client'

/**
 * Kopplingar → Betalningar via banken: whether the payment provider has
 * verified the company (know your customer, done once with BankID by a
 * signatory) and which of the company's accounts a payment can leave from.
 * Shown only for companies where bank payments are switched on.
 */
export function BankPaymentsSettingsContent() {
  const t = useTranslations('settings_bank_payments')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { formatDateLong } = useFormat()

  const [availability, setAvailability] = useState<PaymentsAvailability | null>(null)
  const [verification, setVerification] = useState<CompanyVerification | null | 'failed'>(null)
  const [busy, setBusy] = useState(false)

  const loadVerification = useCallback(async () => {
    try {
      setVerification(await fetchCompanyVerification())
    } catch {
      setVerification('failed')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchPaymentsAvailability()
      .then((data) => {
        if (cancelled) return
        setAvailability(data)
        if (data.available) void loadVerification()
      })
      .catch(() => {
        if (!cancelled) setAvailability({ available: false, reason: null, provider: null, accounts: [], signer_known: false })
      })
    return () => {
      cancelled = true
    }
  }, [loadVerification])

  async function startVerification() {
    setBusy(true)
    try {
      const { url } = await startCompanyVerification()
      window.open(url, '_blank', 'noopener,noreferrer')
      toast({ title: t('verification_started_title'), description: t('verification_started') })
    } catch (error) {
      const body = error instanceof PaymentsClientError ? error.body : null
      toast({ title: t('verification_failed_title'), description: getErrorMessage(body, { locale }), variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const verificationText = (() => {
    if (verification === null) return null
    if (verification === 'failed') return t('verification_unknown')
    if (verification.status === 'valid') {
      return verification.valid_until ? t('verification_valid_until', { date: formatDateLong(verification.valid_until) }) : t('verification_valid')
    }
    return verification.status === 'invalid' ? t('verification_invalid') : t('verification_unknown')
  })()
  const verified = verification !== null && verification !== 'failed' && verification.status === 'valid'

  return (
    <div>
      <SettingsBackLink href="/settings/connections" label={tNav('connections')} />
      <SettingsSectionHeader title={tNav('bank_payments')} intro={tIntro('bank_payments')} />

      {availability === null ? (
        <div className="space-y-3 pt-8">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : !availability.available ? (
        availability.reason === 'subscription' ? (
          <UpgradeNote className="mt-8">{t('requires_subscription')}</UpgradeNote>
        ) : (
          <p className="pt-8 text-[13px] text-muted-foreground">{t('not_available')}</p>
        )
      ) : (
        <>
          <SettingsGroup label={t('group_verification')} help={t('verification_help')}>
            <SettingsRow label={t('verification_label')}>
              {verificationText ? (
                <SettingsRowNote className={verified ? 'text-foreground' : 'text-attn'}>{verificationText}</SettingsRowNote>
              ) : (
                <Skeleton className="h-4 w-40" />
              )}
              <SettingsRowEnd>
                <Button variant="outline" size="sm" onClick={() => void loadVerification()} disabled={busy}>
                  {t('refresh')}
                </Button>
                {canWrite && !verified && (
                  <Button size="sm" onClick={startVerification} loading={busy}>
                    {t('start_verification')}
                  </Button>
                )}
              </SettingsRowEnd>
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup label={t('group_accounts')} help={t('accounts_help')}>
            {availability.accounts.length === 0 ? (
              <SettingsRow label={t('no_accounts')} borderless>
                <SettingsRowNote>{t('no_accounts_hint')}</SettingsRowNote>
              </SettingsRow>
            ) : (
              availability.accounts.map((account) => (
                <SettingsRow
                  key={account.id}
                  label={
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 tabular-nums text-muted-foreground">{account.ledger_account}</span>
                      <span className="truncate">{account.name ?? account.iban ?? account.ledger_account}</span>
                    </span>
                  }
                >
                  <SettingsRowNote className={account.payable ? 'text-foreground' : 'text-attn'}>
                    {account.payable ? t('account_payable') : t(`account_reason_${account.reason ?? 'bank_unknown'}`)}
                  </SettingsRowNote>
                  {account.iban && <SettingsRowEnd><span className="text-[12.5px] tabular-nums text-muted-foreground">{account.iban}</span></SettingsRowEnd>}
                </SettingsRow>
              ))
            )}
          </SettingsGroup>
        </>
      )}
    </div>
  )
}

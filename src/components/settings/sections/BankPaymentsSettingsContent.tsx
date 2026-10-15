'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { BankMark } from '@/components/banks/BankMark'
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
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import {
  fetchBankPaymentsUsage,
  fetchCompanyVerification,
  fetchPaymentsAvailability,
  type BankPaymentsUsage,
  PaymentsClientError,
  startCompanyVerification,
  type CompanyVerification,
  type PaymentsAvailability,
} from '@/components/payments/payments-client'
import { VerificationStateText } from '@/components/payments/VerificationStateText'
import { RequestMorePaymentsDialog } from '@/components/payments/BankPaymentsAllowance'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { NEEDS_LINK_STATES } from '@/lib/payments/orders/verification-state'

/**
 * Kopplingar → Betalningar via banken: whether the payment provider has
 * verified the company (know your customer, done once with BankID by a
 * signatory), this month's bank payments against the monthly cap (with
 * Begär fler betalningar), and which of the company's accounts a payment can
 * leave from. Shown only for companies where bank payments are switched on.
 */
export function BankPaymentsSettingsContent() {
  const t = useTranslations('settings_bank_payments')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [availability, setAvailability] = useState<PaymentsAvailability | null>(null)
  const [verification, setVerification] = useState<CompanyVerification | null | 'failed'>(null)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [usage, setUsage] = useState<BankPaymentsUsage | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [requesting, setRequesting] = useState(false)

  // The stored answer serves the page (fresh within six hours); Uppdatera
  // asks the provider. checked_at is when the provider was last asked.
  const loadVerification = useCallback(async (refresh = false) => {
    try {
      const next = await fetchCompanyVerification({ refresh })
      setVerification(next)
      setCheckedAt(next.checked_at ? new Date(next.checked_at) : null)
    } catch {
      setVerification('failed')
    }
  }, [])

  // The provider's answer rarely changes (a verification is valid about a
  // year), so a refresh needs visible feedback or it looks like nothing happened.
  async function refreshVerification() {
    setRefreshing(true)
    try {
      await loadVerification(true)
      toast({ title: t('refreshed_title'), description: t('refreshed') })
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    fetchPaymentsAvailability()
      .then((data) => {
        if (cancelled) return
        setAvailability(data)
        if (data.available) {
          // The verification rides on the availability (lib/payments/orders/readiness).
          const known = data.verification ?? null
          setVerification(known ?? 'failed')
          setCheckedAt(known?.checked_at ? new Date(known.checked_at) : null)
          fetchBankPaymentsUsage()
            .then((u) => {
              if (!cancelled) setUsage(u)
            })
            .catch(() => {
              // The counter is informational: the page stands without it.
            })
        }
      })
      .catch(() => {
        if (!cancelled) setAvailability({ available: false, reason: null, provider: null, accounts: [], signer_known: false })
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function startVerification() {
    setBusy(true)
    try {
      const started = await startCompanyVerification()
      window.open(started.url, '_blank', 'noopener,noreferrer')
      setVerification((current) =>
        current && current !== 'failed' ? { ...current, state: started.state, link_expires_at: started.expires_at } : current,
      )
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
    return <VerificationStateText verification={verification} />
  })()
  const verified = verification !== null && verification !== 'failed' && verification.state === 'valid'
  // A new form is offered when none is out: first time, a dead link, or a renewal.
  const canStart = verification !== null && verification !== 'failed' && NEEDS_LINK_STATES.has(verification.state)
  const usageMonth = usage ? new Date(`${usage.period}-15T12:00:00Z`).toLocaleDateString(locale, { month: 'long' }) : ''
  // The cap is hard: at it, no bank payment goes out this month until it is raised.
  const capReached = usage !== null && usage.payments_sent >= usage.included_payments
  const checkedAtText = checkedAt
    ? t('checked_at', { time: checkedAt.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) })
    : null

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
                <SettingsRowNote className={verified ? 'text-foreground' : 'text-attn'}>
                  {verificationText}
                  {checkedAtText ? <span className="text-muted-foreground">, {checkedAtText}</span> : null}
                </SettingsRowNote>
              ) : (
                <Skeleton className="h-4 w-40" />
              )}
              <SettingsRowEnd>
                <Button variant="outline" size="sm" onClick={() => void refreshVerification()} loading={refreshing} disabled={busy}>
                  {t('refresh')}
                </Button>
                {canWrite && canStart && (
                  <Button size="sm" onClick={startVerification} loading={busy}>
                    {t('start_verification')}
                  </Button>
                )}
              </SettingsRowEnd>
            </SettingsRow>
          </SettingsGroup>

          {usage && (
            <SettingsGroup label={t('group_usage')} help={t('usage_help')}>
              <SettingsRow label={t('usage_payments_label', { month: usageMonth })}>
                <SettingsRowNote className={capReached ? 'text-attn' : 'text-foreground'}>
                  {t('usage_of', { used: usage.payments_sent, included: usage.included_payments })}
                  {capReached ? `, ${t('usage_limit_reached')}` : ''}
                </SettingsRowNote>
                {canWrite && (
                  <SettingsRowEnd>
                    {capReached ? (
                      <Button size="sm" onClick={() => setRequesting(true)}>
                        {t('request_more')}
                      </Button>
                    ) : (
                      <button type="button" className={QUIET_LINK_CLASS} onClick={() => setRequesting(true)}>
                        {t('request_more')}
                      </button>
                    )}
                  </SettingsRowEnd>
                )}
              </SettingsRow>
              <SettingsRow label={t('usage_accounts_label', { month: usageMonth })}>
                <SettingsRowNote className={usage.extra_accounts > 0 ? 'text-attn' : 'text-foreground'}>
                  {t('usage_of', { used: usage.accounts_used, included: usage.included_accounts })}
                  {usage.extra_accounts > 0 ? `, ${t('usage_over', { count: usage.extra_accounts })}` : ''}
                </SettingsRowNote>
              </SettingsRow>
            </SettingsGroup>
          )}

          {requesting && <RequestMorePaymentsDialog included={usage?.included_payments ?? null} onOpenChange={setRequesting} />}

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
                      <BankMark bankName={account.bank_name} size={18} />
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

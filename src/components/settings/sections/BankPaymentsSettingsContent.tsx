'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { SupportLink } from '@/components/ui/support-link'
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
  withIncludedPayments,
  type CompanyVerification,
  type PaymentsAvailability,
} from '@/components/payments/payments-client'
import { VerificationStateText } from '@/components/payments/VerificationStateText'
import { BuyPaymentPacksDialog, RequestMorePaymentsDialog, usePaymentPacks } from '@/components/payments/BankPaymentsAllowance'
import { useFormat } from '@/lib/hooks/use-format'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { NEEDS_LINK_STATES } from '@/lib/payments/orders/verification-state'
import { formatCurrency } from '@/lib/utils'

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
  // The availability read failed. message: the server's sentence for a 4xx
  // about the company (no retry helps); null: a failed read, with a retry.
  // Never the "not switched on" text: that is only true after a real answer.
  const [availabilityError, setAvailabilityError] = useState<{ message: string | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  // Uppdatera could not reach the provider: the server's sentence, in the row.
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [verification, setVerification] = useState<CompanyVerification | null | 'failed'>(null)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [usage, setUsage] = useState<BankPaymentsUsage | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [buying, setBuying] = useState(false)
  const { formatDateLong } = useFormat()
  // The company's packs and whether this person may buy more. Without them
  // the row keeps today's numbers and Begär fler.
  const { view: packsView, reload: reloadPacks } = usePaymentPacks(availability?.available === true)
  const packs = packsView !== null && packsView !== 'failed' ? packsView : null

  // The stored answer serves the page (fresh within six hours); Uppdatera
  // asks the provider. checked_at is when the provider was last asked. The
  // provider's answer rarely changes (a verification is valid about a year),
  // so a refresh needs visible feedback or it looks like nothing happened. A
  // refresh that fails keeps the last known answer and says why in the row.
  async function refreshVerification() {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const next = await fetchCompanyVerification({ refresh: true })
      setVerification(next)
      setCheckedAt(next.checked_at ? new Date(next.checked_at) : null)
      toast({ title: t('refreshed_title'), description: t('refreshed') })
    } catch (error) {
      const failure = error instanceof PaymentsClientError
        ? getErrorMessage(error.body, { locale, statusCode: error.status })
        : getErrorMessage(error, { locale })
      setRefreshError(failure)
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    fetchPaymentsAvailability()
      .then((data) => {
        if (cancelled) return
        setAvailabilityError(null)
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
      .catch((error: unknown) => {
        if (cancelled) return
        const status = error instanceof PaymentsClientError ? error.status : null
        const aboutCompany = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429
        setAvailabilityError({
          message: aboutCompany && error instanceof PaymentsClientError
            ? getErrorMessage(error.body, { locale, statusCode: status })
            : null,
        })
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey, locale])

  function retryAvailability() {
    setAvailabilityError(null)
    setAvailability(null)
    setReloadKey((key) => key + 1)
  }

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
  // While extra payments are billed it is the safety ceiling, not what is included.
  const capReached = usage !== null && usage.payments_sent >= (usage.cap_payments ?? usage.included_payments)
  // More than what is included on offer and not open yet: the way on is to ask for it.
  const offered = usage?.extra_offered === true && !usage.billed_above_included
  // An owner where packs are sold buys more; everyone else asks for more.
  const canBuy = !offered && packs?.can_buy === true
  const moreLabel = canBuy ? t('buy_more') : t('request_more')
  const askOrBuy = () => (canBuy ? setBuying(true) : setRequesting(true))
  const checkedAtText = checkedAt
    ? t('checked_at', { time: checkedAt.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) })
    : null

  return (
    <div>
      <SettingsBackLink href="/settings/connections" label={tNav('connections')} />
      <SettingsSectionHeader title={tNav('bank_payments')} intro={tIntro('bank_payments')} />

      {availabilityError ? (
        availabilityError.message ? (
          <EmptyState title={availabilityError.message} />
        ) : (
          <LoadError title={t('availability_load_failed')} onRetry={retryAvailability} />
        )
      ) : availability === null ? (
        <div className="space-y-3 pt-8">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : !availability.available ? (
        availability.reason === 'subscription' ? (
          <UpgradeNote className="mt-8">{t('requires_subscription')}</UpgradeNote>
        ) : (
          <div className="pt-8 text-[13px] text-muted-foreground">
            {t('not_available')}
            {/* The way on: support switches it on. The sandbox has no bank to pay from. */}
            {availability.reason !== 'sandbox' && (
              <>
                {' '}
                <SupportLink variant="inline" className="text-[13px]" subject={t('not_available_support_subject')}>
                  {t('not_available_support')}
                </SupportLink>
              </>
            )}
          </div>
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
                <Button variant="outline" onClick={() => void refreshVerification()} loading={refreshing} disabled={busy}>
                  {t('refresh')}
                </Button>
                {canWrite && canStart && (
                  <Button onClick={startVerification} loading={busy}>
                    {t('start_verification')}
                  </Button>
                )}
              </SettingsRowEnd>
              {refreshError && (
                <SettingsRowNote className="basis-full text-attn">
                  <span role="alert">{t('refresh_failed', { reason: refreshError })}</span>
                </SettingsRowNote>
              )}
            </SettingsRow>
          </SettingsGroup>

          {usage && (
            <SettingsGroup label={t('group_usage')} help={t('usage_help')}>
              <SettingsRow label={t('usage_payments_label', { month: usageMonth })}>
                <SettingsRowNote className={capReached ? 'text-attn' : 'text-foreground'}>
                  {/* With packs the cap is said with what it is made of: what is included and what was bought. */}
                  {packs && packs.packs > 0 && packs.included_payments === usage.included_payments
                    ? t('usage_of_with_packs', {
                        used: usage.payments_sent,
                        included: usage.included_payments,
                        base: packs.base_payments,
                        bought: packs.packs * packs.pack_size,
                      })
                    : usage.billed_above_included
                      ? t('usage_of_billed', {
                          used: usage.payments_sent,
                          included: usage.included_payments,
                          price: formatCurrency((usage.unit_price_ore ?? 0) / 100),
                        })
                      : t('usage_of', { used: usage.payments_sent, included: usage.included_payments })}
                  {capReached ? `, ${t('usage_limit_reached')}` : ''}
                </SettingsRowNote>
                {canWrite && (
                  <SettingsRowEnd>
                    {capReached ? (
                      <Button onClick={askOrBuy}>
                        {moreLabel}
                      </Button>
                    ) : (
                      <button type="button" className={QUIET_LINK_CLASS} onClick={askOrBuy}>
                        {moreLabel}
                      </button>
                    )}
                  </SettingsRowEnd>
                )}
                {packs?.scheduled && (
                  <SettingsRowNote className="basis-full">
                    {t('packs_scheduled', { packs: packs.scheduled.packs, date: formatDateLong(packs.scheduled.at) })}
                  </SettingsRowNote>
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
          {buying && packs?.can_buy && (
            <BuyPaymentPacksDialog
              view={packs}
              onOpenChange={setBuying}
              onChanged={(result) => {
                if (!result.scheduled) setUsage((current) => withIncludedPayments(current, result.included_payments))
                // Whatever changed (now, or at the period end), the row says it.
                reloadPacks()
              }}
            />
          )}

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
                  {account.iban && <SettingsRowEnd><span className="text-xs tabular-nums text-muted-foreground">{account.iban}</span></SettingsRowEnd>}
                </SettingsRow>
              ))
            )}
          </SettingsGroup>
        </>
      )}
    </div>
  )
}

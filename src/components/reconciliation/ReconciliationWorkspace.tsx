'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { cn, formatDate } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { AttnLine } from '@/components/ui/attn-line'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { LoadError } from '@/components/ui/empty-state'
import { useFiscalScope } from '@/components/providers/FiscalScopeProvider'
import { ReportDateRange, type DateRangeValue } from '@/components/common/ReportDateRange'
import type { ReconciliationAccount } from '@/lib/reconciliation/schemas'
import { AccountOverview, type ReconciliationWindow } from './AccountOverview'
import { ManualMatchMode } from './ManualMatchMode'

/**
 * /reconciliation?account=: one account's reconciliation flow (concept
 * P.recon + reconflow), full width, with the way back to Konton in the top
 * bar. The account list itself is Konton (founder decision 2026-10-18 merged
 * the two lists); the bare address redirects there in next.config.ts, and an
 * account the list does not know goes back there too. The open account lives
 * in the URL so a link lands on the right account and a reload keeps it.
 *
 * The period (the app-wide räkenskapsår + a range within it) scopes the bank
 * bridge and the item windows and sets the default sign-off date. The range
 * keeps its own preset memory, separate from the reports: reconciling is a
 * monthly ritual, so it opens on this month rather than on whatever range a
 * report left behind.
 */

const RANGE_STORAGE_KEY_PREFIX = 'Accounted:recon-page-range-preset:'
const ACCOUNTS_HREF = '/accounts'

export function ReconciliationWorkspace() {
  const t = useTranslations('reconciliation')
  const tCommon = useTranslations('common')
  const tNav = useTranslations('nav')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [accounts, setAccounts] = useState<ReconciliationAccount[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  // The year is app-wide context (the sidebar); reconciling needs one started year.
  const { periodId, period } = useFiscalScope({ allowAll: false, hideFuture: true })
  const periodBounds = useMemo(
    () => (period ? { start: period.period_start, end: period.period_end } : null),
    [period],
  )
  const [dateRange, setDateRange] = useState<DateRangeValue>({})
  // Another year starts on its own default range (adjusting state during render).
  const [shownPeriodId, setShownPeriodId] = useState(periodId)
  if (periodId !== shownPeriodId) {
    setShownPeriodId(periodId)
    setDateRange({})
  }
  const [signoffSlot, setSignoffSlot] = useState<HTMLSpanElement | null>(null)
  const [primarySlot, setPrimarySlot] = useState<HTMLSpanElement | null>(null)

  // The effective window: the range within the period, defaulting to the
  // period bounds. Null until the period picker has resolved.
  const window = useMemo<ReconciliationWindow | null>(() => {
    if (!periodBounds) return null
    return {
      from: dateRange.fromDate ?? periodBounds.start,
      to: dateRange.toDate ?? periodBounds.end,
    }
  }, [periodBounds, dateRange])

  const load = useCallback(async () => {
    if (!window) return
    try {
      const qs = new URLSearchParams({ date_from: window.from, date_to: window.to })
      const res = await fetch(`/api/reconciliation/accounts?${qs.toString()}`)
      setLoadError(false)
      if (!res.ok) {
        setLoadError(true)
        return
      }
      const json = await res.json()
      setAccounts((json.data?.accounts ?? []) as ReconciliationAccount[])
    } catch {
      setLoadError(true)
    }
  }, [window])

  useEffect(() => {
    void load()
  }, [load])

  const requestedKey = searchParams.get('account')
  const mode: 'overview' | 'match' = searchParams.get('mode') === 'match' ? 'match' : 'overview'
  const setMode = useCallback(
    (next: 'overview' | 'match') => {
      const params = new URLSearchParams(searchParams.toString())
      if (next === 'match') params.set('mode', 'match')
      else params.delete('mode')
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [pathname, router, searchParams],
  )
  const flowAccount = accounts?.find((a) => a.account_key === requestedKey) ?? null
  const closeFlow = useCallback(() => router.push(ACCOUNTS_HREF), [router])

  // An account the list does not hold (none named, a stale link, a balance
  // account without a balance) has no flow here: back to the list, as the
  // table that used to stand here did.
  const unknownAccount = accounts !== null && flowAccount === null
  useEffect(() => {
    if (unknownAccount) router.replace(ACCOUNTS_HREF)
  }, [unknownAccount, router])

  const header = (
    <PageHeader
      parent={flowAccount ? { label: tNav('v3_accounts_balance'), href: ACCOUNTS_HREF } : undefined}
      title={
        flowAccount ? (
          <span className="flex items-baseline gap-2">
            <span data-ph-mask>{t('v2_flow_title', { name: flowAccount.name })}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {flowAccount.signed_off_through
                ? t('v2_last_signed', { date: formatDate(flowAccount.signed_off_through) })
                : t('v2_never_signed')}
              {/* AccountOverview renders the sign-off's details and Öppna igen here. */}
              <span ref={setSignoffSlot} />
            </span>
          </span>
        ) : (
          t('title')
        )
      }
      help={
        <HelpPopover>
          <p>{t('help_text')}</p>
        </HelpPopover>
      }
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={closeFlow} className={cn(QUIET_LINK_CLASS, 'mr-1')}>
            {t('v2_close')}
          </button>
          {periodBounds && (
            <ReportDateRange
              periodStart={periodBounds.start}
              periodEnd={periodBounds.end}
              value={dateRange}
              onChange={setDateRange}
              defaultPreset="this_month"
              storageKeyPrefix={RANGE_STORAGE_KEY_PREFIX}
            />
          )}
          {/* AccountOverview renders the page's primary (Markera som avstämd) here. */}
          <span ref={setPrimarySlot} className="contents" />
        </div>
      }
    />
  )

  // Nothing on screen yet: the load failure says so in place of the account.
  if (loadError && !accounts) {
    return (
      <div className="space-y-6">
        {header}
        <LoadError title={t('load_failed_title')} onRetry={() => void load()} />
      </div>
    )
  }

  if (!flowAccount || !window) {
    return (
      <div className="space-y-6" aria-busy>
        {header}
        {/* Shaped like the account's strip of figures it resolves into. */}
        <LateReveal className="grid grid-cols-2 gap-6 border-b-hairline pb-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-6 w-28" />
            </div>
          ))}
        </LateReveal>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {header}
      {/* A failed refresh keeps the account on screen under one line. */}
      {loadError && (
        <AttnLine action={{ label: tCommon('retry'), onClick: () => void load() }}>{tCommon('refresh_failed')}</AttnLine>
      )}
      {mode === 'match' ? (
        <div className="min-w-0 space-y-4">
          <button type="button" onClick={() => setMode('overview')} className={QUIET_LINK_CLASS}>
            {t('v2_back_overview')}
          </button>
          <ManualMatchMode key={flowAccount.account_key} account={flowAccount} window={window} onChanged={() => void load()} />
        </div>
      ) : (
        <AccountOverview
          key={flowAccount.account_key}
          account={flowAccount}
          otherBankAccounts={(accounts ?? []).filter((a) => a.kind === 'bank' && a.account_key !== flowAccount.account_key && !a.superseded_by)}
          window={window}
          onChanged={() => void load()}
          onMatchManually={flowAccount.kind === 'manual' ? undefined : () => setMode('match')}
          headerSlot={signoffSlot}
          primarySlot={primarySlot}
        />
      )}
    </div>
  )
}

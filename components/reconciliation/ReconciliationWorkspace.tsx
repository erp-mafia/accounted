'use client'
import { HandoffButton } from '@/components/ai-handoff/HandoffButton'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Scale } from 'lucide-react'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { cn, formatDate } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { EmptyState } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { Skeleton } from '@/components/ui/skeleton'
import { FyPicker } from '@/components/common/FyPicker'
import { ReportDateRange, type DateRangeValue } from '@/components/common/ReportDateRange'
import type { ReconciliationAccount } from '@/lib/reconciliation/schemas'
import type { FiscalPeriod } from '@/types'
import { ReconciliationTable } from './ReconciliationTable'
import { AccountOverview, type ReconciliationWindow } from './AccountOverview'
import { ManualMatchMode } from './ManualMatchMode'

/**
 * /reconciliation: one page for every account with an outside truth
 * (concept P.recon + reconflow). The landing is a table of the accounts
 * (bank accounts, the skattekonto) with their status and a Stäm av button
 * each; an account opens its flow alone, full width, with the way back in
 * the top bar. The open account lives in the URL (?account=) so a link
 * lands on the right account and a reload keeps it.
 *
 * The period (räkenskapsår + range within it) scopes the bank bridge and the
 * item windows and sets the default sign-off date. It keeps its own preset
 * memory, separate from the reports: reconciling is a monthly ritual, so it
 * opens on this month rather than on whatever range a report left behind.
 */

const FY_STORAGE_KEY_PREFIX = 'Accounted:recon-fy:'
const RANGE_STORAGE_KEY_PREFIX = 'Accounted:recon-page-range-preset:'

interface ReconciliationWorkspaceProps {
  initialPeriods: FiscalPeriod[]
  initialCompanyId: string | null
}

export function ReconciliationWorkspace({ initialPeriods, initialCompanyId }: ReconciliationWorkspaceProps) {
  const t = useTranslations('reconciliation')
  const tParm = useTranslations('bokslutsbilagor')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [accounts, setAccounts] = useState<ReconciliationAccount[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [periodId, setPeriodId] = useState<string | null>(null)
  const [periodBounds, setPeriodBounds] = useState<{ start: string; end: string } | null>(null)
  const [dateRange, setDateRange] = useState<DateRangeValue>({})

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
  const select = useCallback(
    (accountKey: string) => {
      const params = new URLSearchParams(searchParams.toString())
      params.set('account', accountKey)
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [pathname, router, searchParams],
  )
  // The table is the landing; an account is in its flow only when the URL names it.
  const flowAccount = accounts?.find((a) => a.account_key === requestedKey) ?? null
  const closeFlow = useCallback(() => router.replace(pathname, { scroll: false }), [pathname, router])

  const header = (
    <PageHeader
      title={
        flowAccount ? (
          <span className="flex items-baseline gap-2">
            <span data-ph-mask>{t('v2_flow_title', { name: flowAccount.name })}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {flowAccount.signed_off_through
                ? t('v2_last_signed', { date: formatDate(flowAccount.signed_off_through) })
                : t('v2_never_signed')}
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
          <HandoffButton disabled={!window} task={{ kind: 'month-close', scope: {
            ...(periodId ? { fiscal_period_id: periodId } : {}),
            ...(window ? { date_from: window.from, date_to: window.to } : {}),
            ...(flowAccount ? { account_key: flowAccount.account_key } : {}),
          } }} />
          {flowAccount && (
            <button type="button" onClick={closeFlow} className={cn(QUIET_LINK_CLASS, 'mr-1')}>
              {t('v2_close')}
            </button>
          )}
          {/* On a phone the bar holds one picker: the month is the one a
              person changes while reconciling; the year waits for a wider screen. */}
          <div className={cn(flowAccount && 'hidden sm:block')}>
            <FyPicker
              value={periodId}
              onChange={(id, period) => {
                setPeriodId(id)
                setPeriodBounds(period ? { start: period.period_start, end: period.period_end } : null)
                setDateRange({})
              }}
              includeAllOption={false}
              hideFuturePeriods
              initialPeriods={initialPeriods}
              initialCompanyId={initialCompanyId}
              storageKeyPrefix={FY_STORAGE_KEY_PREFIX}
            />
          </div>
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
        </div>
      }
    />
  )

  if (loadError) {
    return (
      <div className="space-y-6">
        {header}
        <AttnLine action={{ label: t('older_show'), onClick: () => void load() }}>{t('load_failed')}</AttnLine>
      </div>
    )
  }

  if (accounts === null || !window) {
    return (
      <div className="space-y-6" aria-busy>
        {header}
        <div className="grid gap-8 lg:grid-cols-[220px_1fr]">
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    )
  }

  if (accounts.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={Scale}
          title={t('empty_title')}
          description={t('empty_body')}
          actionLabel={t('empty_connect_bank')}
          actionHref="/settings/banking"
          secondaryActionLabel={t('empty_connect_skv')}
          secondaryActionHref="/settings/tax"
        />
      </div>
    )
  }

  const railFooter = (
    <Link href="/reports/bokslutsbilagor" className={cn(QUIET_LINK_CLASS, 'block px-3 pt-4 text-[12.5px]')}>
      {tParm('open_parm')}
    </Link>
  )

  return (
    <div className="space-y-6">
      {header}
      {flowAccount ? (
        mode === 'match' ? (
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
            otherBankAccounts={accounts.filter((a) => a.kind === 'bank' && a.account_key !== flowAccount.account_key && !a.superseded_by)}
            window={window}
            onChanged={() => void load()}
            onMatchManually={flowAccount.kind === 'manual' ? undefined : () => setMode('match')}
          />
        )
      ) : (
        <ReconciliationTable accounts={accounts} onSelect={select} footer={railFooter} />
      )}
    </div>
  )
}

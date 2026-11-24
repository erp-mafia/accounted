'use client'

import { Fragment, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { DefEmpty } from '@/components/ui/detail-section'
import { Skeleton } from '@/components/ui/skeleton'
import { LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EllipsisHorizontalIcon } from '@/components/icons'
import { RemoveCashAccountDialog } from '@/components/settings/RemoveCashAccountDialog'
import { AccountLogo } from '@/components/reconciliation/ReconciliationRail'
import { cn, formatDate, formatRowAmount } from '@/lib/utils'
import { reconciliationHref } from '@/lib/reconciliation/account-links'
import { parseAccountKey, type ReconciliationAccount } from '@/lib/reconciliation/schemas'

async function fetchAccounts(url: string): Promise<ReconciliationAccount[]> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} ${res.status}`)
  const json = (await res.json()) as { data?: { accounts?: ReconciliationAccount[] } }
  return json.data?.accounts ?? []
}

const COLUMNS = 7

/**
 * Konton: the one list of every account with an outside truth (product
 * decision 2026-10-18 merged the Översikt and Avstämning lists, which read
 * the same accounts from the same route). Bank accounts and the skattekonto
 * first, the balance accounts without a feed folded under their own group so
 * the bank rows stay in view. Each row says when the account was last read,
 * through which date it is signed off, how many rows still need a look, what
 * is unexplained and the balance the outside last reported; the row opens the
 * account's reconciliation. The mark in front of the name says where the
 * money comes from, so there is no source column.
 *
 * The route is read without a window, so the counts and the unexplained
 * difference cover 1 January to today: the service default the v1 API and
 * the MCP resource share, so the list says what an agent sees.
 *
 * A bank row carries "Ta bort konto" (PH 222): the dialog asks removal's dry
 * run and, when the rows must stay, offers to archive the account instead.
 */
export default function AccountsOverview({ autorun = false }: { autorun?: boolean }) {
  const t = useTranslations('accounts_v2')
  const { canWrite } = useViewerLock()
  const tCommon = useTranslations('common')
  const tRec = useTranslations('reconciliation')
  const tParm = useTranslations('bokslutsbilagor')
  const tRemove = useTranslations('settings_voucher_series')
  const router = useRouter()
  const { data, isLoading, error, mutate } = useSWR<ReconciliationAccount[]>('/api/reconciliation/accounts', fetchAccounts)
  const [manualOpen, setManualOpen] = useState(false)
  const [removing, setRemoving] = useState<{ id: string; label: string } | null>(null)
  const accounts = data ?? []
  // A reconnect duplicate stays listed, muted with its marker: it may still
  // hold rows nobody linked.
  const fed = accounts.filter((a) => a.kind !== 'manual')
  const manual = accounts.filter((a) => a.kind === 'manual')

  // "Senast läst": when the outside last reported the balance, else when the
  // feed last delivered; the status as_of is the moment the row was computed
  // and says nothing about the feed.
  const lastReadFor = (a: ReconciliationAccount) => (a.kind === 'manual' ? null : (a.balance_at ?? a.source.synced_at))
  const toReview = (a: ReconciliationAccount) => {
    const c = a.status?.open_counts
    return c ? c.proposed + c.unmatched_external + c.unmatched_ledger : 0
  }

  const renderRow = (a: ReconciliationAccount) => {
    const review = toReview(a)
    const lastRead = lastReadFor(a)
    const unexplained = a.status?.unexplained_difference ?? null
    // Green only when the account is reconciled: a zero with open rows is
    // not settled, just not yet explained.
    const tone =
      unexplained == null
        ? ''
        : a.status?.state === 'reconciled'
          ? 'text-success'
          : Math.abs(unexplained) >= 0.005
            ? 'text-warning'
            : ''
    const href = reconciliationHref(a, { autorun })
    const key = parseAccountKey(a.account_key)
    const cashAccountId = key?.kind === 'bank' ? key.cashAccountId : null
    return (
      <tr
        key={a.account_key}
        className={cn('group cursor-pointer transition-colors duration-150 hover:bg-secondary/35', a.superseded_by && 'opacity-60')}
        onClick={() => router.push(href)}
      >
        {/* max-w-0: the name takes the width the other columns leave and
            truncates past it, instead of pushing Saldo off a phone's edge. */}
        <td className={cn(TD_CLASS, 'max-w-0 !pl-0')}>
          <Link href={href} onClick={(e) => e.stopPropagation()} className="flex items-center gap-3">
            <AccountLogo account={a} className="h-7 w-7 text-xs" />
            {/* One line (convention 4): number, currency and the superseded
                marker ride muted beside the name; the source stays in the tooltip. */}
            <span className="flex min-w-0 items-baseline gap-2" title={t(`source_${a.source.type}`)}>
              <span className="truncate font-medium" data-ph-mask>
                {a.name}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                <span data-ph-mask>{a.account_number}</span>
                {a.currency !== 'SEK' ? ` · ${a.currency}` : ''}
                {a.superseded_by ? ` · ${tRec('rail_superseded')}` : ''}
              </span>
            </span>
          </Link>
        </td>
        {/* On a phone (below sm) the row is the account and its balance:
            the dates, the open rows and Oförklarat are in the account's
            reconciliation, which the row opens. */}
        <td className={cn(TD_CLASS, 'hidden whitespace-nowrap date-figures text-muted-foreground sm:table-cell')}>
          {lastRead ? formatDate(lastRead) : <DefEmpty />}
        </td>
        {/* Normal states are muted text (convention 5): a date, or never. */}
        <td className={cn(TD_CLASS, 'hidden whitespace-nowrap date-figures text-muted-foreground sm:table-cell')}>
          {a.signed_off_through ? formatDate(a.signed_off_through) : tRec('v2_never')}
        </td>
        <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-muted-foreground sm:table-cell')} data-ph-mask>
          {review > 0 ? tRec('v2_rows_open', { count: review }) : <DefEmpty />}
        </td>
        <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums sm:table-cell', tone)} data-ph-mask>
          {unexplained == null ? <DefEmpty /> : formatRowAmount(unexplained, a.currency)}
        </td>
        <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')} data-ph-mask>
          {a.balance != null ? formatRowAmount(a.balance, a.currency) : <DefEmpty />}
        </td>
        <td className={cn(TD_CLASS, 'w-0 !pr-0')} onClick={(e) => e.stopPropagation()}>
          {cashAccountId && canWrite && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('row_more', { account: a.name })}>
                  <EllipsisHorizontalIcon className="h-[15px] w-[15px]" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setRemoving({ id: cashAccountId, label: a.name })}>
                  {tRemove('remove_confirm_action')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </td>
      </tr>
    )
  }

  return (
    <div className="stagger-enter">
      {/* A failed refresh keeps the rows under one line (Stil v3 states). */}
      {error && data && (
        <AttnLine className="mb-3" action={{ label: tCommon('retry'), onClick: () => void mutate() }}>
          {tCommon('refresh_failed')}
        </AttnLine>
      )}
      {/* Bleeds exactly the panel padding (MainContainer px-4 md:px-6) less the
          8px list bleed: a wider bleed overshot a phone's 16px gutter and
          scrolled the page sideways. */}
      <div className="-mx-4 overflow-x-auto px-2 md:-mx-6 md:px-4">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={cn(TH_CLASS, '!pl-0 w-full')}>{t('th_account')}</th>
              <th className={cn(TH_CLASS, 'hidden sm:table-cell')}>{t('th_synced')}</th>
              <th className={cn(TH_CLASS, 'hidden sm:table-cell')}>{t('th_signed_off')}</th>
              <th className={cn(TH_CLASS, 'hidden sm:table-cell')}>{t('th_review')}</th>
              <th className={cn(TH_CLASS, 'hidden text-right sm:table-cell')}>{tRec('v2_th_unexplained')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('th_balance')}</th>
              <th className={cn(TH_CLASS, '!pr-0')} aria-hidden />
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              // animate-late: LateReveal's hold-back on the row itself, so a
              // fast load never flashes the skeleton rows.
              [1, 2].map((i) => (
                <tr key={i} aria-busy className="animate-late">
                  <td colSpan={COLUMNS} className={cn(TD_CLASS, '!pl-0')}>
                    <span className="flex items-center gap-3">
                      <Skeleton className="h-7 w-7 shrink-0" />
                      <Skeleton className="h-4 w-48" />
                    </span>
                  </td>
                </tr>
              ))
            ) : error && !data ? (
              <tr>
                <td colSpan={COLUMNS} className="!pl-0">
                  <LoadError title={t('load_failed')} onRetry={() => void mutate()} />
                </td>
              </tr>
            ) : (
              <>
                {fed.length === 0 ? (
                  <tr>
                    <td colSpan={COLUMNS} className={cn(TD_CLASS, '!pl-0 py-8 text-muted-foreground')}>
                      {t('empty')}{' '}
                      <Link href="/settings/banking" className="underline underline-offset-2">
                        {t('connect_bank')}
                      </Link>
                    </td>
                  </tr>
                ) : (
                  fed.map(renderRow)
                )}
                {manual.length > 0 && (
                  <Fragment>
                    <tr className="bg-muted/30">
                      <td colSpan={COLUMNS} className="px-0 py-2 text-xs font-semibold text-muted-foreground">
                        <span className="flex items-center gap-3">
                          <span>
                            {tRec('rail_group_manual')}
                            <span className="ml-1.5 font-normal tabular-nums text-muted-foreground" data-ph-mask>
                              {manual.length}
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={() => setManualOpen((v) => !v)}
                            aria-expanded={manualOpen}
                            className="normal-case tracking-normal text-xs font-normal text-muted-foreground underline decoration-foreground/25 underline-offset-2 hover:text-foreground"
                          >
                            {manualOpen ? tRec('v2_hide_manual') : tRec('v2_show_manual', { count: manual.length })}
                          </button>
                        </span>
                      </td>
                    </tr>
                    {manualOpen && manual.map(renderRow)}
                  </Fragment>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
      <RemoveCashAccountDialog account={removing} onClose={() => setRemoving(null)} onRemoved={() => mutate()} />
      {/* The binder the reconciliations feed, the way there the Avstämning list carried. */}
      {!isLoading && !error && accounts.length > 0 && (
        <Link href="/reports/bokslutsbilagor" className={cn(QUIET_LINK_CLASS, 'mt-4 inline-block')}>
          {tParm('open_parm')}
        </Link>
      )}
    </div>
  )
}

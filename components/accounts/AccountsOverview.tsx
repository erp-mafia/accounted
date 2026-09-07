'use client'

import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { useCashAccounts } from '@/lib/reference-data/hooks'
import type { ReconciliationAccount } from '@/lib/reconciliation/schemas'

async function fetchAccounts(url: string): Promise<ReconciliationAccount[]> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} ${res.status}`)
  const json = (await res.json()) as { data?: { accounts?: ReconciliationAccount[] } }
  return json.data?.accounts ?? []
}

function Mark({ account }: { account: ReconciliationAccount }) {
  const initials = account.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
  return account.logo_url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={account.logo_url} alt="" className="h-7 w-7 shrink-0 rounded-sm object-contain" />
  ) : (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-secondary text-[11px] font-medium text-muted-foreground">
      {initials || '·'}
    </span>
  )
}

/**
 * Konton (UI v2 PR 8): every account with an outside truth on one page,
 * bank accounts and the skattekonto alike. Rows come from the reconciliation
 * service (the same list the Avstämning workspace shows), joined with the
 * cash-account balances. Each row says when it was last read, through which
 * date it is signed off, and how many rows still need a look; the links go
 * to the reconciliation for that account.
 */
export default function AccountsOverview() {
  const t = useTranslations('accounts_v2')
  const { data, isLoading, error } = useSWR<ReconciliationAccount[]>('/api/reconciliation/accounts', fetchAccounts)
  const { cashAccounts } = useCashAccounts({ enabledOnly: true })
  // Accounts with money in them: bank accounts and the skattekonto. Ledger
  // accounts reconciled by hand (2081, 2641 ...) belong to Avstämning.
  const rows = (data ?? []).filter((a) => !a.superseded_by && a.kind !== 'manual')

  const cashFor = (a: ReconciliationAccount) =>
    cashAccounts.find((c) => c.ledger_account === a.account_number && c.currency === a.currency)
  const balanceFor = (a: ReconciliationAccount) => cashFor(a)?.balance ?? null
  // "Senast läst": when the bank last reported a balance; the status as_of is
  // the moment the row was computed and says nothing about the feed.
  const lastReadFor = (a: ReconciliationAccount) => {
    if (a.kind === 'bank') return cashFor(a)?.balance_updated_at ?? null
    return a.status?.as_of ?? null
  }
  const toReview = (a: ReconciliationAccount) => {
    const c = a.status?.open_counts
    return c ? c.proposed + c.unmatched_external + c.unmatched_ledger : 0
  }
  const reconHref = (a: ReconciliationAccount) => `/reconciliation?account=${encodeURIComponent(a.account_key)}`
  // The name opens the account's own rows; Stäm av and the review count open
  // the reconciliation. account_key is 'bank:<cash_account_id>' for banks.
  const accountHref = (a: ReconciliationAccount) =>
    a.kind === 'bank'
      ? `/transactions?source=${encodeURIComponent(`acct:${a.account_key.slice('bank:'.length)}`)}`
      : a.kind === 'skattekonto'
        ? '/skattekonto'
        : reconHref(a)

  return (
    <div className="stagger-enter">
      <div className="-mx-5 overflow-x-auto px-5 md:-mx-6 md:px-6">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={cn(TH_CLASS, '!pl-0 w-full')}>{t('th_account')}</th>
              <th className={TH_CLASS}>{t('th_source')}</th>
              <th className={TH_CLASS}>{t('th_synced')}</th>
              <th className={TH_CLASS}>{t('th_signed_off')}</th>
              <th className={TH_CLASS}>{t('th_review')}</th>
              <th className={cn(TH_CLASS, 'text-right !pr-0')}>{t('th_balance')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className={cn(TD_CLASS, '!pl-0 text-muted-foreground')}>{t('loading')}</td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={6} className={cn(TD_CLASS, '!pl-0 text-muted-foreground')}>{t('load_failed')}</td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className={cn(TD_CLASS, '!pl-0 py-8 text-muted-foreground')}>
                  {t('empty')}{' '}
                  <Link href="/settings/banking" className="underline underline-offset-2">
                    {t('connect_bank')}
                  </Link>
                </td>
              </tr>
            ) : (
              rows.map((a) => {
                const review = toReview(a)
                const balance = balanceFor(a)
                return (
                  <tr key={a.account_key} className="group transition-colors duration-150 hover:bg-secondary/35">
                    <td className={cn(TD_CLASS, '!pl-0')}>
                      <Link href={accountHref(a)} className="flex items-center gap-3">
                        <Mark account={a} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium" data-ph-mask>
                            {a.name}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {a.kind === 'skattekonto' ? t('kind_skv') : a.kind === 'manual' ? t('kind_manual') : t('kind_bank')} · {a.account_number}
                            {a.currency !== 'SEK' ? ` · ${a.currency}` : ''}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground')}>{t(`source_${a.source.type}`)}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground')}>
                      {lastReadFor(a) ? formatDate(lastReadFor(a)!) : '–'}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      {a.signed_off_through ? (
                        <span className="text-muted-foreground">{formatDate(a.signed_off_through)}</span>
                      ) : (
                        <Link href={reconHref(a)} className="rounded-full border border-border px-2.5 py-0.5 text-xs hover:bg-secondary/60">
                          {t('sign_off_link')}
                        </Link>
                      )}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      {review > 0 ? (
                        <Link href={reconHref(a)} className="rounded-full border border-border px-2.5 py-0.5 text-xs hover:bg-secondary/60" data-ph-mask>
                          {t('review_rows', { count: review })}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums !pr-0')} data-ph-mask>
                      {balance != null ? formatCurrency(balance, a.currency) : '–'}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

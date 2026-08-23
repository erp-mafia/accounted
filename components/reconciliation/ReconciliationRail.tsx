'use client'

import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { cn, formatDate } from '@/lib/utils'
import type { ReconciliationAccount } from '@/lib/reconciliation/schemas'

/**
 * The account rail of the Avstämning page: one row per account with an
 * outside truth (bank accounts, the skattekonto), logo or monogram, the
 * account number, when its outside side was last fetched, and a status dot.
 * Selection is URL-owned (?account=) by the workspace; the rail only reports.
 */

const DOT_CLASS: Record<NonNullable<ReconciliationAccount['status']>['state'] | 'unknown', string> = {
  reconciled: 'bg-success',
  open: 'bg-warning',
  stale: 'bg-warning',
  not_configured: 'bg-muted-foreground/40',
  unknown: 'bg-muted-foreground/40',
}

function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export function AccountLogo({ account, className }: { account: ReconciliationAccount; className?: string }) {
  if (account.logo_url) {
    return (
      <Image
        src={account.logo_url}
        alt=""
        width={20}
        height={20}
        className={cn('h-5 w-5 shrink-0 rounded-sm object-contain', className)}
        unoptimized
      />
    )
  }
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-secondary text-[9px] font-semibold tracking-tight text-secondary-foreground',
        className,
      )}
    >
      {monogram(account.name)}
    </span>
  )
}

interface ReconciliationRailProps {
  accounts: ReconciliationAccount[]
  selectedKey: string | null
  onSelect: (accountKey: string) => void
}

export function ReconciliationRail({ accounts, selectedKey, onSelect }: ReconciliationRailProps) {
  const t = useTranslations('reconciliation')
  return (
    <nav aria-label={t('rail_heading')} className="stagger-enter">
      <ul className="flex flex-col gap-0.5">
        {accounts.map((account) => {
          const selected = account.account_key === selectedKey
          const state = account.status?.state ?? 'unknown'
          const synced = account.source.synced_at
          const open = account.status
            ? account.status.open_counts.proposed +
              account.status.open_counts.unmatched_external +
              account.status.open_counts.unmatched_ledger
            : 0
          return (
            <li key={account.account_key}>
              <button
                type="button"
                onClick={() => onSelect(account.account_key)}
                aria-current={selected ? 'page' : undefined}
                className={cn(
                  'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-150',
                  selected ? 'bg-secondary' : 'hover:bg-muted/60',
                  account.superseded_by && 'opacity-60',
                )}
              >
                <AccountLogo account={account} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-foreground" data-ph-mask>
                      {account.name}
                    </span>
                    {account.superseded_by && (
                      <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                        {t('rail_superseded')}
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[11.5px] text-muted-foreground tabular-nums">
                    <span data-ph-mask>{account.account_number}</span>
                    {' · '}
                    {account.signed_off_through
                      ? t('rail_signed_off', { date: formatDate(account.signed_off_through) })
                      : synced
                        ? t('rail_synced', { date: formatDate(synced) })
                        : t('rail_never_synced')}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {open > 0 && (
                    <span className="text-[11px] tabular-nums text-muted-foreground" data-ph-mask>
                      {open}
                    </span>
                  )}
                  <span
                    aria-label={t(`state_${state === 'unknown' ? 'not_configured' : state}`)}
                    title={t(`state_${state === 'unknown' ? 'not_configured' : state}`)}
                    className={cn('h-2 w-2 rounded-full', DOT_CLASS[state])}
                  />
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

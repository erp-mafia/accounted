'use client'

import { Fragment, useState } from 'react'
import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'
import type { ReconciliationAccount } from '@/lib/reconciliation/schemas'

/**
 * The account rail of the Avstämning page: one row per account with an
 * outside truth (bank accounts, the skattekonto), logo or monogram, the
 * account number, when its outside side was last fetched, and a status dot.
 * The rest of the balance sheet follows under its own label: those accounts
 * have no feed, so their row says whether they are signed off instead.
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
  const label = account.kind === 'manual' ? account.account_number.slice(0, 2) : monogram(account.name)
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-secondary text-[9px] font-semibold tracking-tight text-secondary-foreground tabular-nums',
        className,
      )}
    >
      {label}
    </span>
  )
}

interface ReconciliationRailProps {
  accounts: ReconciliationAccount[]
  selectedKey: string | null
  onSelect: (accountKey: string) => void
}

const MANUAL_OPEN_STORAGE_KEY = 'Accounted:recon-rail-manual-open'

export function ReconciliationRail({ accounts, selectedKey, onSelect }: ReconciliationRailProps) {
  const t = useTranslations('reconciliation')
  const fed = accounts.filter((a) => a.kind !== 'manual')
  const manual = accounts.filter((a) => a.kind === 'manual')
  const selectedIsManual = selectedKey?.startsWith('manual:') ?? false

  // The manual group folds: a migrated company has twenty-odd balance
  // accounts, and the bank rows must stay in view. It opens when a manual
  // account is selected and otherwise remembers the last choice per browser.
  const [manualOpen, setManualOpen] = useState<boolean>(() => {
    if (selectedIsManual) return true
    try {
      return window.localStorage.getItem(MANUAL_OPEN_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })
  // Derived, not synced: the selected row must stay visible.
  const showManual = manualOpen || selectedIsManual
  const toggleManual = () => {
    setManualOpen((open) => {
      try {
        window.localStorage.setItem(MANUAL_OPEN_STORAGE_KEY, open ? '0' : '1')
      } catch {
        // Per-browser convenience only.
      }
      return !open
    })
  }
  const manualUnsigned = manual.filter((a) => a.status?.state !== 'reconciled').length

  const stateLabel = (account: ReconciliationAccount): string => {
    const state = account.status?.state ?? 'unknown'
    if (account.kind === 'manual' && state === 'open') return t('state_unsigned')
    return t(`state_${state === 'unknown' ? 'not_configured' : state}`)
  }

  const subLine = (account: ReconciliationAccount): string => {
    if (account.signed_off_through) return t('rail_signed_off', { date: formatDate(account.signed_off_through) })
    if (account.kind === 'manual') return t('rail_never_signed')
    const synced = account.source.synced_at
    return synced ? t('rail_synced', { date: formatDate(synced) }) : t('rail_never_synced')
  }

  // A manual account with nothing to compare against is not a problem, just
  // not attested yet: neutral until it is signed or a specification differs.
  const dotState = (account: ReconciliationAccount): keyof typeof DOT_CLASS => {
    const state = account.status?.state ?? 'unknown'
    if (account.kind === 'manual' && state === 'open' && account.status?.unexplained_difference == null) return 'unknown'
    return state
  }

  const renderRow = (account: ReconciliationAccount) => {
    const selected = account.account_key === selectedKey
    const state = dotState(account)
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
              {subLine(account)}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {open > 0 && (
              <span className="text-[11px] tabular-nums text-muted-foreground" data-ph-mask>
                {open}
              </span>
            )}
            <span
              aria-label={stateLabel(account)}
              title={stateLabel(account)}
              className={cn('h-2 w-2 rounded-full', DOT_CLASS[state])}
            />
          </span>
        </button>
      </li>
    )
  }

  return (
    <nav aria-label={t('rail_heading')} className="stagger-enter">
      <ul className="flex flex-col gap-0.5">
        {fed.map(renderRow)}
        {manual.length > 0 && (
          <Fragment>
            <li className={cn(fed.length > 0 && 'mt-3')}>
              <button
                type="button"
                onClick={toggleManual}
                aria-expanded={showManual}
                aria-controls="recon-rail-manual"
                className="flex w-full items-center gap-1.5 rounded-lg px-3 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:bg-muted/60"
              >
                {showManual ? (
                  <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate">{t('rail_group_manual')}</span>
                <span className="shrink-0 normal-case tracking-normal tabular-nums" data-ph-mask>
                  {manualUnsigned > 0 ? t('rail_group_manual_unsigned', { count: manualUnsigned, total: manual.length }) : String(manual.length)}
                </span>
              </button>
            </li>
            {showManual && (
              <Fragment>
                <li id="recon-rail-manual" className="sr-only" aria-hidden />
                {manual.map(renderRow)}
              </Fragment>
            )}
          </Fragment>
        )}
      </ul>
    </nav>
  )
}

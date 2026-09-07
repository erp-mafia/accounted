'use client'

import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ChevronDown, X, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import type { TransactionWithInvoice } from '@/components/transactions/transaction-types'
import { TransactionAttachmentIndicator } from './TransactionAttachmentIndicator'

/**
 * Shell v2 transaction drawer (concept .drawer): a fixed panel on the right
 * that opens when a row is clicked, instead of the row folding out in the
 * table. The category chip, the row's actions and the details the foldout
 * used to hold, in one place that does not move the list.
 */

export interface DrawerAction {
  key: string
  label: string
  icon: LucideIcon
  onSelect: () => void
  destructive?: boolean
}

interface TransactionDrawerProps {
  transaction: TransactionWithInvoice
  accountLabel: string | null
  accountLogo?: string | null
  categoryLabel: string | null
  primaryLabel: string
  onPrimary: (anchor: HTMLElement) => void
  onOpenCategory: (anchor: HTMLElement) => void
  actions: DrawerAction[]
  methodLabel: string | null
  originalName: string | null
  skvCounterpartDate?: string
  isPreMigration: boolean
  attachedDocumentId: string | null
  /** Anything the foldout showed that has no slot here (extraction status). */
  extra?: ReactNode
  processing: boolean
  onClose: () => void
}

export function TransactionDrawer({
  transaction,
  accountLabel,
  accountLogo = null,
  categoryLabel,
  primaryLabel,
  onPrimary,
  onOpenCategory,
  actions,
  methodLabel,
  originalName,
  skvCounterpartDate,
  isPreMigration,
  attachedDocumentId,
  extra,
  processing,
  onClose,
}: TransactionDrawerProps) {
  const t = useTranslations('tx_inbox_card')
  const isIncome = transaction.amount > 0
  const booked = !!transaction.journal_entry_id
  const attach = actions.find((a) => a.key === 'attach')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (typeof document === 'undefined') return null

  const fact = (label: string, value: ReactNode) =>
    value == null || value === '' ? null : (
      <div className="contents">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="min-w-0 break-words" data-ph-mask>
          {value}
        </dd>
      </div>
    )

  return createPortal(
    <aside
      role="dialog"
      aria-label={transaction.description}
      className="fixed bottom-2.5 right-2.5 top-2.5 z-40 flex w-[min(400px,calc(100vw-20px))] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-[0_12px_32px_rgba(0,0,0,0.10)] animate-fade-in"
    >
      <div className="flex items-start gap-3 border-b border-border/70 px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium" data-ph-mask title={transaction.description}>
            {transaction.description}
          </p>
          <p className={cn('mt-0.5 text-[20px] tabular-nums tracking-tight', isIncome && 'text-success')} data-ph-mask>
            {isIncome ? '+' : ''}
            {formatCurrency(transaction.amount, transaction.currency)}
          </p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            <span className="tabular-nums">{formatDate(transaction.date)}</span>
            {accountLabel ? <span data-ph-mask> · {accountLabel}</span> : null}
            {' · '}
            {booked ? t('drawer_state_booked') : t('drawer_state_unbooked')}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="-mr-2 -mt-1 h-7 w-7 shrink-0 text-muted-foreground" onClick={onClose} aria-label={t('drawer_close')}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!booked && (
          <div className="border-b border-border/70 px-5 py-3">
            <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t('drawer_category')}</p>
            <button
              type="button"
              className={cn(
                'inline-flex max-w-full items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[13px] transition-colors duration-150 hover:bg-secondary/60',
                !categoryLabel && 'text-muted-foreground',
              )}
              onClick={(e) => onOpenCategory(e.currentTarget)}
              disabled={processing}
            >
              <span className="truncate">{categoryLabel ?? t('category_pick')}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
            </button>
          </div>
        )}

        <div className="border-b border-border/70 px-5 py-3">
          <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t('drawer_actions')}</p>
          <div className="flex flex-col items-start gap-1.5">
            <Button size="sm" className="h-8" onClick={(e) => onPrimary(e.currentTarget)} disabled={processing}>
              {primaryLabel}
            </Button>
            <div className="flex flex-col items-start gap-1 pt-1">
              {actions.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  className={cn(QUIET_LINK_CLASS, 'inline-flex items-center gap-2 no-underline', a.destructive && 'hover:text-destructive')}
                  onClick={a.onSelect}
                  disabled={processing}
                >
                  <a.icon className="h-3.5 w-3.5" aria-hidden />
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="px-5 py-3">
          <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t('drawer_details')}</p>
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
            {fact(
              t('drawer_account'),
              accountLabel ? (
                <span className="inline-flex items-center gap-1.5">
                  {accountLogo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={accountLogo} alt="" className="h-4 w-4 rounded-sm object-contain" />
                  )}
                  {accountLabel}
                </span>
              ) : null,
            )}
            {fact(t('drawer_bank_text'), originalName ?? transaction.original_description ?? null)}
            {fact(t('drawer_method'), methodLabel)}
            {transaction.currency !== 'SEK' && transaction.amount_sek != null
              ? fact(t('drawer_amount_fx'), <span className="tabular-nums">{formatCurrency(transaction.amount_sek)}</span>)
              : null}
            {fact(
              t('drawer_underlag'),
              attachedDocumentId ? (
                <span className="inline-flex items-center gap-1.5">
                  {t('drawer_underlag_attached')}
                  <TransactionAttachmentIndicator documentId={attachedDocumentId} />
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <span className="text-warning">{t('drawer_underlag_missing')}</span>
                  {attach && (
                    <button type="button" className={QUIET_LINK_CLASS} onClick={attach.onSelect} disabled={processing}>
                      {attach.label}
                    </button>
                  )}
                </span>
              ),
            )}
            {booked
              ? fact(
                  t('drawer_voucher'),
                  <Link href={`/bookkeeping/${transaction.journal_entry_id}`} className={QUIET_LINK_CLASS}>
                    {t('drawer_open_voucher')}
                  </Link>,
                )
              : null}
            {skvCounterpartDate ? fact(t('skv_counterpart_label'), t('skv_counterpart_body', { date: skvCounterpartDate })) : null}
          </dl>
          {isPreMigration && <p className="mt-3 text-[12px] text-muted-foreground">{t('pre_migration_foldout')}</p>}
          {extra ? <div className="mt-3">{extra}</div> : null}
        </div>
      </div>
    </aside>,
    document.body,
  )
}

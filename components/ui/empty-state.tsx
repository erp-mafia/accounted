'use client'

import * as React from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  ReceiptText,
  Users,
  ArrowLeftRight,
  Camera,
  Building2,
  FileText,
  Calendar,
  Plus,
  type LucideIcon,
} from 'lucide-react'
import { SupportLink } from '@/components/ui/support-link'

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description: string
  actionLabel?: string
  actionHref?: string
  onAction?: () => void
  secondaryActionLabel?: string
  secondaryActionHref?: string
  supportHint?: boolean
  className?: string
  children?: React.ReactNode
}

/**
 * EmptyState: friendly placeholder shown when there is no data.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
  secondaryActionLabel,
  secondaryActionHref,
  supportHint,
  className,
  children,
}: EmptyStateProps) {
  const t = useTranslations('empty')
  return (
    <div className={cn('flex flex-col items-center justify-center py-12 px-4 text-center', className)}>
      {Icon && (
        <div className="mb-6">
          <div className="p-4 rounded-full bg-muted">
            <Icon className="h-8 w-8 text-muted-foreground" />
          </div>
        </div>
      )}
      <h3 className="text-lg font-medium mb-2">{title}</h3>
      <p className="text-sm text-muted-foreground max-w-sm mb-6 text-balance">{description}</p>

      {supportHint && (
        <div className="mb-6">
          <SupportLink variant="muted" subject={t('support_hint_subject')}>
            {t('support_hint_label')}
          </SupportLink>
        </div>
      )}

      {(actionLabel || children) && (
        <div className="flex flex-col sm:flex-row items-center gap-3">
          {actionHref && actionLabel && (
            <Link href={actionHref}>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                {actionLabel}
              </Button>
            </Link>
          )}
          {onAction && actionLabel && (
            <Button onClick={onAction}>
              <Plus className="mr-2 h-4 w-4" />
              {actionLabel}
            </Button>
          )}
          {secondaryActionHref && secondaryActionLabel && (
            <Link href={secondaryActionHref}>
              <Button variant="outline">{secondaryActionLabel}</Button>
            </Link>
          )}
          {children}
        </div>
      )}
    </div>
  )
}

// Preset empty states for common pages

export function EmptyInvoices({ onAction }: { onAction?: () => void } = {}) {
  const t = useTranslations('empty')
  return (
    <EmptyState
      icon={ReceiptText}
      title={t('preset_invoices_title')}
      description={t('preset_invoices_description')}
      actionLabel={t('preset_invoices_action')}
      actionHref={onAction ? undefined : '/invoices?new=1'}
      onAction={onAction}
    />
  )
}

export function EmptyCustomers({ onAction }: { onAction?: () => void } = {}) {
  const t = useTranslations('empty')
  return (
    <EmptyState
      icon={Users}
      title={t('preset_customers_title')}
      description={t('preset_customers_description')}
      actionLabel={t('preset_customers_action')}
      actionHref={onAction ? undefined : '/customers/new'}
      onAction={onAction}
    />
  )
}

export function EmptyTransactions() {
  const t = useTranslations('empty')
  return (
    <EmptyState
      icon={ArrowLeftRight}
      title={t('preset_transactions_title')}
      description={t('preset_transactions_description')}
      actionLabel={t('preset_transactions_action')}
      actionHref="/import"
      supportHint
    />
  )
}

export function EmptyReceipts() {
  const t = useTranslations('empty')
  return (
    <EmptyState
      icon={Camera}
      title={t('preset_receipts_title')}
      description={t('preset_receipts_description')}
      actionLabel={t('preset_receipts_action')}
      actionHref="/receipts/scan"
    />
  )
}

export function EmptyDeadlines() {
  const t = useTranslations('empty')
  return (
    <EmptyState
      icon={Calendar}
      title={t('preset_deadlines_title')}
      description={t('preset_deadlines_description')}
    />
  )
}

export function NoBankConnected() {
  const t = useTranslations('empty')
  return (
    <EmptyState
      icon={Building2}
      title={t('preset_no_bank_title')}
      description={t('preset_no_bank_description')}
      actionLabel={t('preset_no_bank_action')}
      actionHref="/import"
      supportHint
    />
  )
}

export function EmptyReports() {
  const t = useTranslations('empty')
  return (
    <EmptyState
      icon={FileText}
      title={t('preset_reports_title')}
      description={t('preset_reports_description')}
      actionLabel={t('preset_reports_action')}
      actionHref="/invoices?new=1"
      secondaryActionLabel={t('preset_reports_secondary')}
      secondaryActionHref="/import"
    />
  )
}

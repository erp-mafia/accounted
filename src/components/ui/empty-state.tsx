'use client'

import * as React from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  Users,
  Plus,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'
import { SupportLink } from '@/components/ui/support-link'

interface EmptyStateProps {
  icon?: LucideIcon
  /**
   * Usually static i18n strings. The empty state is data-ph-unmask chrome in
   * session replays, so a title or description carrying user data (e.g. an
   * interpolated search term) must wrap that part in a data-ph-mask element.
   */
  title: React.ReactNode
  description: React.ReactNode
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
    // data-ph-unmask: empty states are static i18n chrome in session replays.
    <div data-ph-unmask="" className={cn('flex flex-col items-center justify-center py-12 px-4 text-center', className)}>
      {Icon && (
        <div className="mb-6">
          <div className="p-4 rounded-full bg-muted">
            <Icon className="h-8 w-8 text-muted-foreground" />
          </div>
        </div>
      )}
      <h3 className="text-lg mb-2">{title}</h3>
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

/**
 * Byrå cockpit: no client companies yet. A preset, not a bare <EmptyState
 * icon={TrendingUp} />, because the only caller is a Server Component: a
 * lucide icon is a forwardRef object that cannot cross the RSC boundary as a
 * prop, while a reference to this client component can. The copy lives in the
 * byra namespace, where the byrå surfaces already keep it.
 */
export function EmptyByraClients() {
  // Named tByra, not t: this is the only preset here that reads from a
  // namespace other than `empty`, and i18n/__tests__/message-keys.test.ts maps
  // one variable name to one namespace per file. Reusing `t` would silently
  // re-point every other preset's key in this file at `byra`.
  const tByra = useTranslations('byra')
  return (
    <EmptyState
      icon={TrendingUp}
      title={tByra('kpi_empty_title')}
      description={tByra('kpi_empty_description')}
    />
  )
}

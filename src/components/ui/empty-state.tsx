'use client'

import * as React from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ArrowTrendingUpIcon, ExclamationTriangleIcon, UsersIcon, type Icon as AppIcon } from '@/components/icons'
import { SupportLink } from '@/components/ui/support-link'

type StateTone = 'empty' | 'done' | 'error'

interface EmptyStateProps {
  icon?: AppIcon
  /**
   * Usually static i18n strings. The empty state is data-ph-unmask chrome in
   * session replays, so a title or description carrying user data (e.g. an
   * interpolated search term) must wrap that part in a data-ph-mask element.
   */
  title: React.ReactNode
  description?: React.ReactNode
  actionLabel?: string
  actionHref?: string
  onAction?: () => void
  secondaryActionLabel?: string
  secondaryActionHref?: string
  /** A second, quieter way forward, drawn as a text link beside the primary. */
  onSecondaryAction?: () => void
  supportHint?: boolean
  /**
   * empty (first time, nothing yet), done (everything handled: the icon is
   * the green check) or error (the page could not load: role="alert", the
   * red warning glyph).
   */
  tone?: StateTone
  className?: string
  children?: React.ReactNode
}

const TONE_ICON_CLASS: Record<StateTone, string> = {
  empty: 'text-muted-foreground',
  done: 'text-success',
  error: 'text-destructive',
}

/**
 * The state block (Stil v3, Tillstand-v3): what a page shows in place of its
 * first row when there is nothing to list, everything is done, or the page
 * could not load. The shell, title bar and toolbar stay where they are. One
 * sentence as the title, at most one more sentence, at most one primary and
 * one quiet link; a 20px line icon or none. Centered in the space the rows
 * would fill (founder call 2026-11-02).
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
  onSecondaryAction,
  supportHint,
  tone = 'empty',
  className,
  children,
}: EmptyStateProps) {
  const t = useTranslations('empty')
  const hasSecondary = secondaryActionLabel && (secondaryActionHref || onSecondaryAction)
  return (
    // data-ph-unmask: empty states are static i18n chrome in session replays.
    <section
      data-ph-unmask=""
      role={tone === 'error' ? 'alert' : undefined}
      className={cn('mx-auto flex max-w-[560px] flex-col items-center gap-1 pb-2 pt-10 text-center animate-rise', className)}
    >
      {Icon && <Icon aria-hidden="true" className={cn('mb-2 h-5 w-5', TONE_ICON_CLASS[tone])} />}
      <h2 className="text-[15px] font-medium leading-[22px] text-strong">{title}</h2>
      {description && <div className="text-[13px] text-muted-foreground text-balance">{description}</div>}

      {supportHint && (
        <div className="mt-1">
          <SupportLink variant="muted" subject={t('support_hint_subject')}>
            {t('support_hint_label')}
          </SupportLink>
        </div>
      )}

      {(actionLabel || hasSecondary || children) && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
          {actionHref && actionLabel && (
            <Button asChild size="toolbar">
              <Link href={actionHref}>{actionLabel}</Link>
            </Button>
          )}
          {onAction && !actionHref && actionLabel && (
            <Button size="toolbar" onClick={onAction}>
              {actionLabel}
            </Button>
          )}
          {hasSecondary &&
            (secondaryActionHref ? (
              <Button asChild variant="link">
                <Link href={secondaryActionHref}>{secondaryActionLabel}</Link>
              </Button>
            ) : (
              <Button variant="link" onClick={onSecondaryAction}>
                {secondaryActionLabel}
              </Button>
            ))}
          {children}
        </div>
      )}
    </section>
  )
}

interface LoadErrorProps {
  /** What could not load, as a sentence ("Kunde inte ladda transaktioner"). Defaults to the generic line. */
  title?: React.ReactNode
  description?: React.ReactNode
  onRetry: () => void
  className?: string
}

/**
 * A page or list that could not load (Stil v3): it says so in the page, in
 * place of the rows, with "Försök igen". Never a toast: a toast is for an
 * undoable success, and an error that vanishes leaves an empty page behind.
 */
export function LoadError({ title, description, onRetry, className }: LoadErrorProps) {
  const tCommon = useTranslations('common')
  return (
    <EmptyState
      tone="error"
      icon={ExclamationTriangleIcon}
      title={title ?? tCommon('load_error')}
      description={description ?? tCommon('load_error_hint')}
      className={className}
    >
      <Button variant="outline" size="toolbar" onClick={onRetry}>
        {tCommon('retry')}
      </Button>
    </EmptyState>
  )
}

interface NotFoundStateProps {
  /** What is missing, as a sentence ("Kunden hittades inte"). */
  title: React.ReactNode
  /** The list the object belonged to, and its label ("Till kunderna"). */
  backHref: string
  backLabel: string
  /** Replaces the shared hint, whose Swedish "Den" fits en-words only ("Avtalet" needs "Det"). */
  description?: React.ReactNode
  className?: string
}

/**
 * A detail page whose object does not exist (deleted, or a wrong link): it
 * says so in the page, with the way back to its list. Distinct from
 * LoadError, which is for a read that failed and can be retried.
 */
export function NotFoundState({ title, backHref, backLabel, description, className }: NotFoundStateProps) {
  const tCommon = useTranslations('common')
  return (
    <EmptyState
      title={title}
      description={description ?? tCommon('not_found_hint')}
      secondaryActionLabel={backLabel}
      secondaryActionHref={backHref}
      className={className}
    />
  )
}

// Preset empty states for common pages

/**
 * The action opens the customers page's own create dialog, so it is a
 * handler, not a link: there is no /customers/new page, and that address
 * opened the customer card with id "new" (a 500 from /api/customers/new).
 */
export function EmptyCustomers({ onAction }: { onAction: () => void }) {
  const t = useTranslations('empty')
  return (
    <EmptyState
      icon={UsersIcon}
      title={t('preset_customers_title')}
      description={t('preset_customers_description')}
      actionLabel={t('preset_customers_action')}
      onAction={onAction}
    />
  )
}

/**
 * Byrå cockpit: no client companies yet. A preset, not a bare <EmptyState
 * icon={ArrowTrendingUpIcon} />, because the only caller is a Server
 * Component: an icon from @/components/icons is a plain function that cannot
 * cross the RSC boundary as a prop, while a reference to this client
 * component can. The copy lives in the
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
      icon={ArrowTrendingUpIcon}
      title={tByra('kpi_empty_title')}
      description={tByra('kpi_empty_description')}
    />
  )
}

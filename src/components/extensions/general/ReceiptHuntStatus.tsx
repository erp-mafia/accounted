'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import type { ReceiptHunt } from './use-receipt-hunt'

/**
 * The one line a receipt hunt says about itself, on both surfaces that run it
 * (the Gmail door in Underlag and Kopplingar > Gmail).
 *
 * A pass takes minutes and reports nothing until it lands, so the running
 * line says so instead of leaving a spinner to be watched. The result says
 * what was fetched and how many purchases are left, and when a mailbox could
 * not be read it says exactly that: zero fetched from a mailbox we could not
 * search is not "nothing found", and saying it would tell someone their
 * receipts do not exist because Gmail was busy.
 *
 * Always mounted, so screen readers announce the line when it changes.
 */
export function ReceiptHuntStatus({
  hunt,
  blocked = false,
  className,
}: {
  hunt: Pick<ReceiptHunt, 'hunting' | 'stopping' | 'progress' | 'result'>
  /** The company lacks the paid `ai` capability: say so before anyone presses. */
  blocked?: boolean
  className?: string
}) {
  const t = useTranslations('mail')
  const result = hunt.result

  let content: React.ReactNode = null
  let attention = false

  if (hunt.hunting) {
    content = hunt.stopping
      ? t('hunt_stopping')
      : hunt.progress
        ? t('hunt_progress', { count: hunt.progress.fetched })
        : t('hunt_started')
  } else if (blocked || result?.kind === 'blocked') {
    content = (
      <>
        {t('hunt_blocked')}{' '}
        <Link href="/settings/billing" className="underline underline-offset-2 hover:text-foreground">
          {t('hunt_upgrade')}
        </Link>
      </>
    )
  } else if (result) {
    const fetched = result.fetched > 0 ? t('hunt_fetched', { count: result.fetched }) : null
    if (result.kind === 'finished') {
      content = [
        fetched ?? t('hunt_nothing'),
        result.remaining > 0 ? t('hunt_remaining', { count: result.remaining }) : null,
      ]
        .filter(Boolean)
        .join(' ')
    } else {
      attention = true
      content = [
        fetched,
        result.kind === 'mailbox_unreadable'
          ? t('hunt_mailbox_unreadable')
          : result.kind === 'busy'
            ? t('hunt_busy')
            : result.kind === 'limited'
              ? t('hunt_limited')
              : t('hunt_failed'),
      ]
        .filter(Boolean)
        .join(' ')
    }
  }

  return (
    <div role="status" aria-live="polite" className={cn(attention && 'text-attn', className)}>
      {content}
    </div>
  )
}

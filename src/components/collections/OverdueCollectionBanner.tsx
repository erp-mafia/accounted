'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { Button } from '@/components/ui/button'
import type { CollectionReadinessView } from '@/lib/collections/invoice-collection'
import { bannerCheckLine, bannerCheckNeedsLook, bannerUnpaid, overdueBanner } from '@/lib/collections/overdue-banner'
import { BATCH_REVIEW_HREF } from '@/lib/collections/batch-dialog'
import type { BatchItem } from '@/lib/collections/batch'
import type { EntryCase, EntryInvoice } from '@/lib/collections/invoice-entry'
import { formatInvoiceAmount } from '@/lib/collections/amount-text'
import { cn, formatDate } from '@/lib/utils'
import { fetchCollectionReadiness, useCaseWords, type InvoiceCollectionAvailability } from './case-client'
import { checkLineText } from './check-text'

/**
 * The overdue banner at the top of an owed invoice past its due date (inkasso
 * lives on the invoice): when it fell due and how long ago, what is unpaid,
 * the bank check in one line, and ONE button named after the step that goes
 * out first. The button opens the handover dialog, which shows every check
 * and asks for anything a person must attest. Before activation it offers
 * activation (owners and admins) or says who can; without the paid plan it
 * shows the upgrade note. Renders nothing while collections is hidden.
 * Decisions live in lib/collections/overdue-banner.ts.
 */

interface Props {
  invoiceId: string
  invoice: EntryInvoice & { total?: number | null; currency?: string | null }
  availability: InvoiceCollectionAvailability
  openCase: EntryCase | null
  canWrite: boolean
  canManage: boolean
  today: string
  /** Bumped by the page after a handover or a payment: read the bank check again. */
  refreshKey?: number
  /** The invoice's item in today's pending run (batchItemFor): the banner says so and links to the run. */
  batchItem?: Pick<BatchItem, 'kind' | 'start_step'> | null
  onSend: () => void
}

export function OverdueCollectionBanner({
  invoiceId,
  invoice,
  availability,
  openCase,
  canWrite,
  canManage,
  today,
  refreshKey = 0,
  batchItem = null,
  onSend,
}: Props) {
  const { tp } = useCaseWords(availability.displayName)
  // The check as read for one invoice and refresh: undefined while it loads
  // (or belongs to an earlier read), null when it could not be read.
  const readKey = `${invoiceId}:${refreshKey}`
  const [read, setRead] = useState<{ key: string; readiness: CollectionReadinessView | null } | null>(null)
  const readiness = read?.key === readKey ? read.readiness : undefined

  const banner = overdueBanner({
    invoice,
    start: availability.start,
    openCase,
    today,
    canWrite,
    canManage,
    defaultStartStep: availability.connection?.defaultStartStep ?? null,
    readiness,
    batchItem,
  })
  const ready = banner?.kind === 'ready'

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    fetchCollectionReadiness(invoiceId)
      .then((next) => {
        if (!cancelled) setRead({ key: readKey, readiness: next })
      })
      .catch(() => {
        if (!cancelled) setRead({ key: readKey, readiness: null })
      })
    return () => {
      cancelled = true
    }
  }, [ready, invoiceId, readKey])

  if (!banner) return null
  const unpaid = bannerUnpaid(invoice, readiness)
  const check = ready ? bannerCheckLine(readiness) : null

  return (
    <section
      aria-label={tp('menu_send')}
      className="flex flex-col gap-3 rounded-lg px-4 py-3 sm:flex-row sm:items-center sm:justify-between bg-control shadow-raised"
    >
      <div className="min-w-0 space-y-1">
        <p className="text-[13px]">
          <span>{tp('banner_due', { date: formatDate(banner.dueDate), days: banner.overdueDays })}</span>
          {unpaid !== null && (
            <>
              <span className="text-muted-foreground"> · </span>
              <span className="tabular-nums">{tp('banner_unpaid', { amount: formatInvoiceAmount(unpaid, invoice.currency) })}</span>
            </>
          )}
        </p>
        {check && (
          <p className={cn('text-xs', bannerCheckNeedsLook(check) ? 'text-attn' : 'text-muted-foreground')}>
            {checkLineText(check, tp)}
          </p>
        )}
        {banner.kind === 'activate' && (
          <p className="text-xs text-muted-foreground">
            {banner.canActivate ? tp('banner_activate_hint') : tp('banner_activate_ask')}
          </p>
        )}
        {banner.kind === 'batch' && (
          <p className="text-xs text-muted-foreground">
            {tp(banner.labelKey)}{' '}
            <Link href={BATCH_REVIEW_HREF} className="text-foreground underline underline-offset-2">
              {tp('banner_in_batch_link')}
            </Link>
          </p>
        )}
        {banner.kind === 'upgrade' && <UpgradeNote className="mt-2">{tp('upgrade_note')}</UpgradeNote>}
      </div>
      {banner.kind === 'ready' && (
        // Never the primary action: that is the page header's (design rule 9), and the dialog asks before anything is sent.
        <Button variant="outline" className="shrink-0 self-start sm:self-auto" onClick={onSend}>
          {tp(banner.labelKey)}
        </Button>
      )}
      {banner.kind === 'activate' && banner.canActivate && (
        <Button asChild variant="outline" className="shrink-0 self-start sm:self-auto">
          <Link href="/settings/collections">{tp('activate_cta')}</Link>
        </Button>
      )}
    </section>
  )
}


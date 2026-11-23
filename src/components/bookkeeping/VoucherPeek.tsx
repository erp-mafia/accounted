'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowTopRightOnSquareIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { IntentLink } from '@/components/ui/intent-link'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { SlideOver, SlideOverBody, SlideOverContent, SlideOverFooter, SlideOverHeader } from '@/components/ui/slide-over'
import JournalEntryStatusBadge from '@/components/bookkeeping/JournalEntryStatusBadge'
import { VoucherLinesTable } from '@/components/bookkeeping/VoucherLinesTable'
import { voucherLineViews } from '@/lib/bookkeeping/voucher-line-view'
import {
  readVoucherPeek,
  readVoucherPeekUnderlag,
  voucherPageHref,
  type VoucherPeekRead,
  type VoucherPeekUnderlagRead,
} from '@/lib/bookkeeping/voucher-peek'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { formatDate } from '@/lib/utils'

interface VoucherPeekProps {
  /** The verifikat (journal entry id) the panel shows. */
  entryId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when the panel has closed and focus is free: the opener takes it back. */
  onClosed?: () => void
}

/**
 * A verifikat in a right slide-over (design convention 13), for reading it
 * without leaving the list it was opened from: number and date, description,
 * the markers of a reversed or corrected verifikat, its lines with totals and
 * its underlag. Read-only: the panel only reads, and every action on a
 * verifikat (rättelse, storno, underlag) stays on the verifikat page, which
 * the footer links to. A new `entryId` while it is open swaps the content.
 */
export function VoucherPeek({ entryId, open, onOpenChange, onClosed }: VoucherPeekProps) {
  return (
    <SlideOver open={open} onOpenChange={onOpenChange}>
      <SlideOverContent
        aria-describedby={undefined}
        // The slide-over is non-modal, so Radix leaves focus where the closing
        // click landed; it goes back to the link that opened the panel.
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onClosed?.()
        }}
      >
        {/* Keyed by the verifikat: another one starts from the loading state. */}
        <VoucherPeekLoader key={entryId} entryId={entryId} />
      </SlideOverContent>
    </SlideOver>
  )
}

/** Reads the verifikat when the panel opens, and again on a retry. */
function VoucherPeekLoader({ entryId }: { entryId: string }) {
  // null while the read is out.
  const [read, setRead] = useState<VoucherPeekRead | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    void readVoucherPeek(entryId, (url) => fetch(url, { signal: controller.signal })).then((result) => {
      if (!controller.signal.aborted) setRead(result)
    })
    return () => controller.abort()
  }, [entryId, attempt])

  return (
    <VoucherPeekView
      entryId={entryId}
      read={read}
      onRetry={() => {
        setRead(null)
        setAttempt((count) => count + 1)
      }}
    />
  )
}

interface VoucherPeekViewProps {
  entryId: string
  /** null while the read is out. */
  read: VoucherPeekRead | null
  onRetry: () => void
}

/** The panel's header, body and footer for one state of the read. Rendered inside the slide-over. */
export function VoucherPeekView({ entryId, read, onRetry }: VoucherPeekViewProps) {
  const tPeek = useTranslations('voucher_peek')
  const tDetail = useTranslations('journal_detail')
  const tList = useTranslations('journal_list')
  const tCommon = useTranslations('common')
  const entry = read?.state === 'ready' ? read.entry : null
  const lines = (entry?.lines ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)

  return (
    <>
      <SlideOverHeader
        title={
          entry ? (
            // The verifikat page's own title: the voucher label, or "draft" before a number is assigned.
            <span data-ph-mask="">
              {entry.status === 'draft' ? tDetail('title_draft') : tDetail('title', { label: formatVoucher(entry) })}
            </span>
          ) : (
            tPeek('title')
          )
        }
      />
      <SlideOverBody className="space-y-5">
        {read === null && (
          <LateReveal role="status" aria-label={tCommon('loading')} className="space-y-5">
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-64" />
            </div>
            {/* Three ledger rows (36px) in the table's columns. */}
            <div>
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex h-9 items-center gap-4 border-b-hairline">
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-20" />
                </div>
              ))}
            </div>
          </LateReveal>
        )}
        {read?.state === 'failed' && <LoadError title={tDetail('error_load_failed')} onRetry={onRetry} />}
        {read?.state === 'missing' && (
          <EmptyState title={tDetail('error_not_found')} description={tDetail('not_found_hint')} />
        )}
        {read?.state === 'ready' && entry && (
          <>
            <div className="space-y-1 text-[13px]">
              <div className="tabular-nums text-muted-foreground" data-ph-mask="">
                {formatDate(entry.entry_date)}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 break-words" data-ph-mask="">
                  {entry.description}
                </span>
                {/* The verifikat page's markers: the status unless plainly posted, and storno or rättelse by source. */}
                <JournalEntryStatusBadge entry={entry} showStatus={entry.status !== 'posted'} />
                {/* An inline rättelse, marked as the verifikat list marks it. */}
                {read.corrected && (
                  <Badge variant="outline" title={tList('rattelse_badge_tooltip')}>
                    {tList('rattelse_badge')}
                  </Badge>
                )}
              </div>
            </div>

            <VoucherLinesTable
              aria-label={tDetail('lines_title')}
              lines={voucherLineViews(lines)}
              showTotals
              redundantTexts={[entry.description]}
            />

            <VoucherPeekUnderlag entryId={entryId} />
          </>
        )}
      </SlideOverBody>
      <SlideOverFooter>
        <Button variant="outline" asChild>
          <IntentLink href={voucherPageHref(entryId)}>{tPeek('open_full')}</IntentLink>
        </Button>
      </SlideOverFooter>
    </>
  )
}

/** Reads the verifikat's documents on its own, so the lines never wait for them. */
function VoucherPeekUnderlag({ entryId }: { entryId: string }) {
  // null while the read is out.
  const [read, setRead] = useState<VoucherPeekUnderlagRead | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    void readVoucherPeekUnderlag(entryId, (url) => fetch(url, { signal: controller.signal })).then((result) => {
      if (!controller.signal.aborted) setRead(result)
    })
    return () => controller.abort()
  }, [entryId, attempt])

  return (
    <VoucherPeekUnderlagView
      read={read}
      onRetry={() => {
        setRead(null)
        setAttempt((count) => count + 1)
      }}
    />
  )
}

interface VoucherPeekUnderlagViewProps {
  /** null while the read is out. */
  read: VoucherPeekUnderlagRead | null
  onRetry: () => void
}

/**
 * The verifikat's documents as links that open the stored file in a new tab,
 * through the same-origin inline route the verifikat page previews from.
 */
export function VoucherPeekUnderlagView({ read, onRetry }: VoucherPeekUnderlagViewProps) {
  const tAttachments = useTranslations('journal_attachments')
  const tDetail = useTranslations('journal_detail')
  const heading = <h3 className="text-xs font-medium text-muted-foreground">{tAttachments('title')}</h3>

  if (read === null) {
    return (
      // The heading waits with the skeleton: a read that answers in time shows neither.
      <LateReveal role="status" aria-label={tAttachments('loading')} className="space-y-2">
        {heading}
        <Skeleton className="h-4 w-48" />
      </LateReveal>
    )
  }
  if (read.state === 'failed') {
    return (
      <section className="space-y-2">
        {heading}
        <LoadError title={tAttachments('load_failed')} onRetry={onRetry} />
      </section>
    )
  }
  if (read.documents.length === 0) {
    // A verifikat whose underlag is a linked record (an invoice, a lönekörning) shows it on its page; nothing is claimed here.
    if (!read.none) return null
    return (
      <section className="space-y-2">
        {heading}
        <div className="text-[13px] text-muted-foreground">{tAttachments('empty')}</div>
      </section>
    )
  }
  return (
    <section className="space-y-2">
      {heading}
      <ul className="space-y-1.5">
        {read.documents.map((doc) => (
          <li key={doc.id}>
            {/* data-ph-mask: a file name and an invoice number are user data. */}
            <a
              href={`/api/documents/${encodeURIComponent(doc.id)}/inline`}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex min-w-0 items-center gap-1.5 text-[13px]"
              data-ph-mask=""
            >
              {/* The glyph says it opens a new tab. */}
              <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate underline decoration-foreground/25 underline-offset-[3px] transition-colors duration-150 group-hover:decoration-foreground/60">
                {doc.source === 'entry'
                  ? // A file stored without a name still gets a link with a name.
                    doc.fileName.trim() || tAttachments('title')
                  : tDetail('reference_supplier_invoice', { number: doc.invoiceNumber ?? '' })}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

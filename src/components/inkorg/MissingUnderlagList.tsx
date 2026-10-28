'use client'

import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { CheckCircleIcon, DocumentMagnifyingGlassIcon } from '@/components/icons'
import { AttnLine } from '@/components/ui/attn-line'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import type { Expectation, PurchaseOnTheWay } from '@/lib/inkorg/expectations'
import {
  bandByMonth,
  dragCarriesFiles,
  purchaseDisplay,
  splitMissing,
  underlagRoute,
  type MissingPurchase,
  type RouteContext,
  type UnderlagRoute,
} from '@/lib/inkorg/missing'
import { cn, formatCurrency } from '@/lib/utils'
import { shortDate } from '@/lib/inkorg/dates'
import { BrandMark } from '@/components/parties/BrandMark'
import { ExpectedLaterList } from './ExpectedLaterList'
import { ROW_CLASS, RowChevron, RowTitle } from './row-parts'
import type { LoadState } from './use-inkorg-data'

/**
 * A part of the list: Behöver dig, På väg. These are h3s, and the app sets
 * h1 to h3 in the serif display face: a small label stays in the body face.
 */
const GROUP_HEADING_CLASS = 'mb-2 flex items-baseline gap-2 px-2 font-sans text-[13px] font-medium'
const GROUP_COUNT_CLASS = 'text-[12.5px] tabular-nums text-muted-foreground'

const NONE_ATTACHED: ReadonlyMap<string, readonly string[]> = new Map()

/** A purchase row's columns: mark, who, where the underlag comes from, amount, chevron. */
const GRID = 'grid-cols-[28px_minmax(0,1fr)_auto] sm:grid-cols-[28px_minmax(8rem,15rem)_minmax(0,1fr)_7.5rem_1rem]'

/** "oktober 2026" / "October 2026" for a YYYY-MM band. */
function monthLabel(month: string, locale: string): string {
  const [year, m] = month.split('-').map(Number)
  if (!year || !m) return month
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'sv-SE', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, m - 1, 1)))
}

/**
 * Saknar underlag: the purchases on the company account that have no
 * document, newest first in month bands, each a row: who (with their mark),
 * when and the bank's text, where its underlag will come from, and how
 * much. A file dropped on a row
 * becomes that purchase's underlag; a row opens the focus view, which also
 * has the file button a phone needs.
 *
 * In three parts once the expectations are read: Behöver dig (what needs a
 * person now), På väg (what usually comes by itself and is not due yet,
 * quiet, each with why) and, folded, Väntas senare (what the regular
 * suppliers usually send in the coming weeks). Until then, or when that
 * read failed, every purchase is under Behöver dig and the fold is left out.
 */
export function MissingUnderlagList({
  purchases,
  state,
  routes,
  onTheWay,
  expectations,
  busyId,
  lastOpenedId,
  onOpen,
  onFiles,
  onRetry,
  portal,
  attached = NONE_ATTACHED,
}: {
  /** In queue order (orderMissing), with the ones attached on this page back in place. */
  purchases: MissingPurchase[]
  /**
   * The purchases that got their underlag on this page, with the files dropped on them: their
   * rows stay, marked and still taking a drop (another document for the same purchase), so
   * nothing slides under the pointer mid-flow (crm#1479). Not counted as missing.
   */
  attached?: ReadonlyMap<string, readonly string[]>
  state: LoadState
  routes: RouteContext | null
  /** The purchases whose document is on its way, by id. */
  onTheWay: ReadonlyMap<string, PurchaseOnTheWay>
  /** Väntas senare; null while unread or unreadable. */
  expectations: Expectation[] | null
  /** The purchase whose file is on its way. */
  busyId: string | null
  /** The row the focus view was left on, scrolled into view and marked. */
  lastOpenedId: string | null
  onOpen: (id: string) => void
  onFiles: (purchaseId: string, files: File[]) => void
  onRetry: () => void
  /** Set when the list is one supplier's (a row under Portaler): its empty state names the supplier. */
  portal?: string
}) {
  const t = useTranslations('inkorg')
  const locale = useLocale()
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const parts = useMemo(() => splitMissing(purchases, onTheWay), [purchases, onTheWay])
  const bands = useMemo(() => bandByMonth(parts.needsYou), [parts])

  // Back from the focus view: the row it was left on comes into view, once.
  useEffect(() => {
    if (lastOpenedId) document.getElementById(`inkorg-purchase-${lastOpenedId}`)?.scrollIntoView({ block: 'nearest' })
  }, [lastOpenedId])

  if (state === 'loading') {
    return (
      <div className="space-y-3" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    )
  }
  if (state === 'failed') {
    return <AttnLine action={{ label: t('retry'), onClick: onRetry }}>{t('missing_load_failed')}</AttnLine>
  }
  const later = expectations && expectations.length > 0 ? <ExpectedLaterList expectations={expectations} /> : null

  const empty = (
    <EmptyState
      icon={DocumentMagnifyingGlassIcon}
      title={portal ? t('portal_empty_title', { vendor: portal }) : t('missing_empty_title')}
      description={portal ? t('portal_empty_body', { vendor: portal }) : t('missing_empty_body')}
    />
  )
  if (purchases.length === 0) {
    return (
      <div className="space-y-8">
        {empty}
        {later}
      </div>
    )
  }
  // What still lacks underlag: the counts leave out the rows kept after their attach.
  const open = (list: readonly MissingPurchase[]) => list.filter((p) => !attached.has(p.id)).length

  const row = (purchase: MissingPurchase) => (
    <PurchaseRow
      key={purchase.id}
      purchase={purchase}
      route={underlagRoute(purchase, routes)}
      onTheWay={onTheWay.get(purchase.id) ?? null}
      busy={busyId === purchase.id}
      attachedFiles={attached.get(purchase.id) ?? null}
      dropping={dropTarget === purchase.id}
      marked={purchase.id === lastOpenedId}
      onOpen={onOpen}
      onDrag={(over) => setDropTarget((current) => (over ? purchase.id : current === purchase.id ? null : current))}
      onFiles={(files) => {
        setDropTarget(null)
        onFiles(purchase.id, files)
      }}
    />
  )
  // The parts are named only when there is more than one: a list that is all Behöver dig needs no heading.
  const split = parts.onTheWay.length > 0

  return (
    <div className="space-y-8">
      {open(purchases) === 0 && empty}
      {parts.needsYou.length > 0 && (
        <section aria-labelledby={split ? 'inkorg-missing-need' : undefined}>
          {split && (
            <h3 id="inkorg-missing-need" className={GROUP_HEADING_CLASS}>
              <span>{t('missing_group_need')}</span>
              <span className={GROUP_COUNT_CLASS}>{open(parts.needsYou)}</span>
            </h3>
          )}
          <div className="stagger-enter space-y-6">
            {bands.map((band) => (
              <section key={band.month} aria-labelledby={`inkorg-month-${band.month}`}>
                <h3
                  id={`inkorg-month-${band.month}`}
                  className="mb-1 flex items-baseline gap-2 px-2 font-sans text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
                >
                  <span>{monthLabel(band.month, locale)}</span>
                  <span className="tabular-nums">{open(band.purchases)}</span>
                </h3>
                <ul className="border-t border-border">{band.purchases.map(row)}</ul>
              </section>
            ))}
          </div>
        </section>
      )}

      {split && (
        <section aria-labelledby="inkorg-missing-way" className="animate-fade-in">
          <h3 id="inkorg-missing-way" className={GROUP_HEADING_CLASS}>
            <span>{t('missing_group_way')}</span>
            <span className={GROUP_COUNT_CLASS}>{open(parts.onTheWay)}</span>
          </h3>
          <p className="mb-2 px-2 text-[12.5px] text-muted-foreground">{t('missing_way_body')}</p>
          <ul className="border-t border-border">{parts.onTheWay.map(row)}</ul>
        </section>
      )}

      {later}
    </div>
  )
}

function PurchaseRow({
  purchase,
  route,
  onTheWay,
  busy,
  attachedFiles,
  dropping,
  marked,
  onOpen,
  onDrag,
  onFiles,
}: {
  purchase: MissingPurchase
  route: UnderlagRoute
  /** Set when its document is on its way: the row is quiet and says why. */
  onTheWay: PurchaseOnTheWay | null
  busy: boolean
  /** The files attached on this page: the row is done, stays in place and takes another one. */
  attachedFiles: readonly string[] | null
  dropping: boolean
  marked: boolean
  onOpen: (id: string) => void
  onDrag: (over: boolean) => void
  onFiles: (files: File[]) => void
}) {
  const t = useTranslations('inkorg')
  const locale = useLocale()

  // The row's short word on where the underlag will come from; nothing where the app does not know.
  // A purchase on its way says how it is coming and by when instead.
  const wayHint = onTheWay
    ? t(onTheWay.door === 'peppol' ? 'missing_way_peppol' : 'missing_way_intake', {
        date: shortDate(onTheWay.expected_by, locale),
      })
    : null
  const routeHint = wayHint ?? (
    route.kind === 'portal'
      ? t('missing_portal', { vendor: route.vendor })
      : route.kind === 'photo'
        ? route.whatsapp
          ? t('missing_hint_photo_whatsapp')
          : t('missing_hint_photo')
        : route.kind === 'intake'
          ? t('missing_hint_intake')
          : '')
  const done = attachedFiles !== null && attachedFiles.length > 0
  const doneHint = done
    ? t('missing_row_attached', { count: attachedFiles.length, file: attachedFiles[attachedFiles.length - 1] ?? '' })
    : null
  const hint = busy
    ? t('uploading')
    : dropping
      ? t(done ? 'missing_row_drop_more' : 'missing_row_drop')
      : (doneHint ?? routeHint)
  const { name, vendor, bankText } = purchaseDisplay(purchase)
  const cells = (
    <>
      <BrandMark
        name={name ?? '?'}
        vendor={vendor}
        variant="mark"
        size={28}
        logoUrl={purchase.logo_url}
        className={cn(onTheWay && 'opacity-60')}
      />
      <RowTitle
        name={name ?? t('missing_unknown')}
        meta={[shortDate(purchase.date, locale), bankText].filter(Boolean).join(' · ')}
        muted={!!onTheWay}
      />
      <span data-ph-mask="" className="hidden truncate text-muted-foreground sm:block">
        {hint}
      </span>
      <span data-ph-mask="" className={cn('text-right font-medium tabular-nums', onTheWay && 'font-normal text-muted-foreground')}>
        {formatCurrency(Math.abs(purchase.amount), purchase.currency)}
      </span>
    </>
  )

  return (
    <li
      id={`inkorg-purchase-${purchase.id}`}
      onDragOver={(e: DragEvent) => {
        if (!dragCarriesFiles(e.dataTransfer?.types)) return
        e.preventDefault()
        e.stopPropagation()
        if (!dropping) onDrag(true)
      }}
      onDragLeave={(e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDrag(false)
      }}
      onDrop={(e: DragEvent) => {
        if (!dragCarriesFiles(e.dataTransfer?.types)) return
        e.preventDefault()
        e.stopPropagation()
        const files = Array.from(e.dataTransfer.files ?? [])
        if (files.length > 0 && !busy) onFiles(files)
        else onDrag(false)
      }}
    >
      {done ? (
        // Attached on this page: nothing to open, the row only keeps its place and takes another file.
        <div
          aria-busy={busy || undefined}
          className={cn(
            ROW_CLASS,
            GRID,
            'hover:bg-transparent active:bg-transparent',
            busy && 'bg-secondary/35',
            dropping && 'bg-secondary/60 hover:bg-secondary/60',
          )}
        >
          {cells}
          <span className="sr-only">{doneHint}</span>
          <CheckCircleIcon aria-hidden="true" className="hidden h-4 w-4 text-success sm:block" />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(purchase.id)}
          aria-busy={busy || undefined}
          className={cn(ROW_CLASS, GRID, (marked || busy) && 'bg-secondary/35', dropping && 'bg-secondary/60')}
        >
          {cells}
          <RowChevron />
        </button>
      )}
    </li>
  )
}


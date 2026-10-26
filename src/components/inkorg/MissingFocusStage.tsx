'use client'

import { useRef, useState, type DragEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowTopRightOnSquareIcon, ArrowUpTrayIcon, CheckIcon } from '@/components/icons'
import { Button, type ButtonProps } from '@/components/ui/button'
import { INBOX_UPLOAD_ACCEPT } from '@/lib/documents/upload-types'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import {
  canAddPortal,
  dragCarriesFiles,
  purchaseDisplay,
  type AiHandoff,
  type MissingAction,
  type MissingDecision,
  type MissingPurchase,
  type UnderlagRoute,
} from '@/lib/inkorg/missing'
import { cn, formatCurrency } from '@/lib/utils'
import { shortDate } from '@/lib/inkorg/dates'
import { BrandMark } from '@/components/parties/BrandMark'
import { FetchWithAiButton } from './FetchWithAiButton'
import { PortalLinkForm } from './PortalLinkForm'

/**
 * One purchase without underlag in focus, laid out like a document in
 * focus: where the document goes on the left (here the place to drop it,
 * which a tap opens the camera or the files from on a phone), on the right
 * who was paid, the one question, the line that says where the underlag
 * will come from, and at most three answers. The whole stage takes a
 * dropped file. On a phone the question comes first.
 *
 * Under the answers of a purchase with no portal, one quiet link says the
 * invoice is in a portal: it opens the one field for the link in place, and
 * saving it makes the portal the purchase's first answer, and the answer of
 * every other purchase from the same supplier.
 */
export function MissingFocusStage({
  purchase,
  decision,
  handoff,
  busy,
  finishing,
  onFiles,
  onAddPortal,
}: {
  purchase: MissingPurchase
  decision: MissingDecision
  handoff: AiHandoff | null
  /** Its file is on its way. */
  busy: boolean
  /** It just got its underlag: "Klart" sits over it while it leaves. */
  finishing: boolean
  onFiles: (files: File[]) => void
  /** Saves the purchase's supplier as a portal at this link; resolves true when it was saved. */
  onAddPortal?: (url: string) => Promise<boolean>
}) {
  const t = useTranslations('inkorg')
  const locale = useLocale()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [addingPortal, setAddingPortal] = useState(false)
  const portalOffered = !!onAddPortal && decision.route.kind !== 'portal' && canAddPortal(purchase)
  const { name, vendor, bankText } = purchaseDisplay(purchase)
  const date = shortDate(purchase.date, locale)
  const meta = [date, bankText].filter(Boolean).join(' · ')

  function chooseFile() {
    inputRef.current?.click()
  }

  const dropHandlers = {
    onDragOver: (e: DragEvent) => {
      if (!dragCarriesFiles(e.dataTransfer?.types)) return
      e.preventDefault()
      if (!dragging) setDragging(true)
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
    },
    onDrop: (e: DragEvent) => {
      if (!dragCarriesFiles(e.dataTransfer?.types)) return
      e.preventDefault()
      // The page takes a drop that misses the stage; this one is the stage's alone.
      e.stopPropagation()
      setDragging(false)
      const files = Array.from(e.dataTransfer.files ?? [])
      if (files.length > 0 && !busy) onFiles(files)
    },
  }

  const variantAt = (index: number): ButtonProps['variant'] => (index === 0 ? 'default' : index === 1 ? 'secondary' : 'ghost')
  // Two pills side by side from a tablet up, stacked on a phone; a third is a quiet text button under them.
  const widthAt = (index: number) => (index < 2 ? 'w-full sm:w-auto' : undefined)

  function renderAction(action: MissingAction, index: number) {
    const variant = variantAt(index)
    const width = widthAt(index)
    switch (action) {
      case 'open_portal':
        return decision.route.kind === 'portal' ? (
          <Button key={action} asChild variant={variant} className={width}>
            <a href={decision.route.url} target="_blank" rel="noopener noreferrer">
              {t('action_open_portal', { vendor: decision.route.vendor })}
              <ArrowTopRightOnSquareIcon aria-hidden="true" className="ml-1 h-3.5 w-3.5" />
            </a>
          </Button>
        ) : null
      case 'choose_file':
        return (
          <Button key={action} variant={variant} className={width} onClick={chooseFile} loading={busy}>
            <span className="pointer-coarse:hidden">{t('action_upload')}</span>
            <span className="hidden pointer-coarse:inline">{t('action_upload_phone')}</span>
          </Button>
        )
      case 'fetch_with_ai':
      case 'connect_ai':
        return <FetchWithAiButton key={action} clients={handoff?.clients ?? []} variant={variant} className={width} />
    }
  }

  return (
    <div className="relative" {...dropHandlers}>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={INBOX_UPLOAD_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length > 0) onFiles(files)
          e.target.value = ''
        }}
      />
      <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start lg:gap-10">
        <div className="order-2 lg:order-1">
          <button
            type="button"
            onClick={chooseFile}
            disabled={busy}
            className={cn(
              'flex h-48 w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 text-center text-[13px] text-muted-foreground transition-colors duration-150 lg:aspect-[210/297] lg:h-[calc(100vh-12rem)] lg:w-auto lg:max-w-[40rem]',
              'hover:bg-secondary/60 hover:text-foreground active:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
              dragging && 'border-foreground bg-secondary/60 text-foreground',
            )}
          >
            <ArrowUpTrayIcon aria-hidden="true" className="h-6 w-6" />
            {busy ? (
              <span>{t('uploading')}</span>
            ) : dragging ? (
              <span>{t('drop_area_release')}</span>
            ) : (
              <>
                <span className="pointer-coarse:hidden">{t('drop_area')}</span>
                <span className="hidden pointer-coarse:inline">{t('drop_area_phone')}</span>
              </>
            )}
            <span data-ph-mask="" className="tabular-nums text-[12.5px]">
              {formatCurrency(Math.abs(purchase.amount), purchase.currency)} · {date}
            </span>
          </button>
        </div>

        <div className="order-1 min-w-0 space-y-6 lg:order-2 lg:max-w-[36rem]">
          <header className="flex items-start gap-3 border-b border-border pb-6">
            <BrandMark name={name ?? '?'} vendor={vendor} variant="mark" size={40} logoUrl={purchase.logo_url} />
            <div className="min-w-0 flex-1">
              <h2 data-ph-mask="" className="font-display text-2xl leading-8 tracking-[-0.02em] [overflow-wrap:anywhere] sm:text-3xl sm:leading-9">
                {name ?? t('missing_unknown')}
              </h2>
              <p data-ph-mask="" className="mt-1 truncate text-[12.5px] text-muted-foreground">
                {meta}
              </p>
            </div>
            <p data-ph-mask="" className="shrink-0 pt-1 font-display text-2xl leading-8 tracking-[-0.02em] tabular-nums">
              {formatCurrency(Math.abs(purchase.amount), purchase.currency)}
            </p>
          </header>

          <section aria-labelledby={`q-${purchase.id}`} className="space-y-6">
            <div className="space-y-3">
              <h3 id={`q-${purchase.id}`} className="font-display text-2xl leading-8 tracking-[-0.02em]">
                {t('q_missing')}
              </h3>
              <RouteEvidence route={decision.route} />
            </div>
            {decision.actions.length > 0 && (
              <div className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">{decision.actions.slice(0, 2).map(renderAction)}</div>
                {decision.actions.length > 2 && (
                  <div className="flex">{decision.actions.slice(2).map((action, i) => renderAction(action, i + 2))}</div>
                )}
              </div>
            )}
            {portalOffered &&
              onAddPortal &&
              (addingPortal ? (
                <PortalLinkForm
                  onSave={async (url) => {
                    const saved = await onAddPortal(url)
                    if (saved) setAddingPortal(false)
                    return saved
                  }}
                  onCancel={() => setAddingPortal(false)}
                />
              ) : (
                <div className="flex">
                  <button type="button" onClick={() => setAddingPortal(true)} className={QUIET_LINK_CLASS}>
                    {t('portal_add')}
                  </button>
                </div>
              ))}
          </section>
        </div>
      </div>

      {finishing && (
        <div className="absolute inset-0 flex items-start justify-center bg-background/70 pt-12 animate-fade-in" aria-live="polite">
          <span className="flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-[13px] font-medium">
            <CheckIcon aria-hidden="true" className="h-4 w-4" />
            {t('done')}
          </span>
        </div>
      )}
    </div>
  )
}

/** The one line under the question: where the underlag will come from, where the app knows. */
function RouteEvidence({ route }: { route: UnderlagRoute }) {
  const t = useTranslations('inkorg')
  switch (route.kind) {
    case 'portal':
      return (
        <p className="text-[13px] text-muted-foreground">
          {t('ev_missing_portal', { vendor: route.vendor })}
          {route.note ? ` ${route.note}` : ''}
        </p>
      )
    case 'photo':
      return (
        <p className="text-[13px] text-muted-foreground">
          {route.whatsapp ? t('ev_missing_photo_whatsapp') : t('ev_missing_photo')}
        </p>
      )
    case 'intake':
      return (
        <p data-ph-mask="" className="text-[13px] text-muted-foreground">
          {t('ev_missing_intake', { address: route.address })}
        </p>
      )
    case 'unknown':
      return null
  }
}

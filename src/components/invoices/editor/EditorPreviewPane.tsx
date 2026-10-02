'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { SegmentedControl } from '@/components/ui/segmented-control'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { PdfPreviewState } from './use-editor-previews'

type PreviewTab = 'document' | 'email'
type Zoom = 'page' | 'width'

interface EditorPreviewPaneProps {
  /** "Faktura", "Offert", ...: the first tab names the document. */
  documentLabel: string
  pdf: PdfPreviewState
  /** The predicted number ("Nummer N preliminärt"); null when the document has its own. */
  preliminaryNumber: string | null
  /** The Mejl tab's content (EditorEmailPreview), mounted only while the tab is open. */
  renderEmail: () => ReactNode
  /**
   * Why no email goes out with this send (a customer without an address, the
   * manual channel, ...): the Mejl tab is disabled with this as its reason.
   * Null while the email goes out.
   */
  emailDisabledReason: string | null
  statusLine: ReactNode
}

// PDF open parameters: no viewer toolbar or thumbnails, and the page fitted
// to the frame ("Hela sidan") or to its width ("Sidbredd").
const PDF_VIEW: Record<Zoom, string> = {
  page: '#toolbar=0&navpanes=0&view=Fit',
  width: '#toolbar=0&navpanes=0&view=FitH',
}

// The box each render loads in. Hela sidan: the largest A4-shaped box (210 x
// 297) that fits the pane, centred at its top, so the viewer's dark backdrop
// never shows as bands around the page. The container units read the pane
// (container-type: size on the frame below). Sidbredd: the pane's full width,
// scrolling down the page.
const PDF_BOX: Record<Zoom, string> = {
  page: 'absolute inset-x-0 top-0 mx-auto h-[min(100cqh,calc(100cqw*297/210))] w-[min(100cqw,calc(100cqh*210/297))]',
  width: 'absolute inset-0 h-full w-full',
}

/** The zoom a buffer was loaded with, read back from its URL. */
function zoomOf(url: string): Zoom {
  return url.endsWith(PDF_VIEW.width) ? 'width' : 'page'
}

/**
 * The right pane: Faktura | Mejl tabs, the page and preliminary-number
 * chips, the live PDF fitted to the pane's height so the payment area is
 * always in view, and the status line under it.
 */
export function EditorPreviewPane({
  documentLabel,
  pdf,
  preliminaryNumber,
  renderEmail,
  emailDisabledReason,
  statusLine,
}: EditorPreviewPaneProps) {
  const t = useTranslations('invoice_editor_shell')
  const [chosenTab, setTab] = useState<PreviewTab>('document')
  // A send that stops emailing (customer switched, channel changed) takes
  // the pane back to the document.
  const tab: PreviewTab = emailDisabledReason ? 'document' : chosenTab
  const [zoom, setZoom] = useState<Zoom>('page')

  // Double-buffered: a new render loads in a hidden <object> over the shown
  // one and swaps in once it has painted, so an edit never blanks the page.
  // The timer covers a plugin that never reports the load.
  const target = pdf.url ? `${pdf.url}${PDF_VIEW[zoom]}` : null
  const [shown, setShown] = useState<string | null>(null)
  const visible = shown ?? target
  useEffect(() => {
    if (!target || target === shown) return
    // The first render has nothing to cover: show it at once.
    const timer = window.setTimeout(() => setShown(target), shown === null ? 0 : 2000)
    return () => window.clearTimeout(timer)
  }, [target, shown])
  // The shown buffer first, the loading one after it: promoting the second
  // drops the first and leaves the promoted node where it is, never moved.
  const buffers = visible ? (target && target !== visible ? [visible, target] : [visible]) : []

  return (
    <section aria-label={t('preview_aria')} className="flex min-h-[80dvh] flex-1 flex-col md:min-h-0">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 md:px-6">
        <SegmentedControl
          aria-label={t('tabs_aria')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'document', label: documentLabel },
            { value: 'email', label: t('tab_email'), disabledReason: emailDisabledReason ?? undefined },
          ]}
        />
        {tab === 'document' && pdf.pageCount !== null && (
          <Badge variant="secondary" className="tabular-nums">
            {t('pages', { count: pdf.pageCount })}
          </Badge>
        )}
        {preliminaryNumber && (
          <Badge variant="secondary" className="tabular-nums" data-ph-mask="">
            {t('number_preliminary', { number: preliminaryNumber })}
          </Badge>
        )}
        {tab === 'document' && (
          <div className="ml-auto flex items-center gap-1">
            {visible && (
              // The way out when the browser shows no PDF: a link here, never
              // fallback content inside the <object> (see below).
              <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground">
                <a href={visible} target="_blank" rel="noreferrer" aria-label={t('preview_open')} title={t('preview_open')}>
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1 rounded-full px-3 text-[12.5px] text-muted-foreground transition-colors duration-150 hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {zoom === 'page' ? t('zoom_page') : t('zoom_width')}
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup value={zoom} onValueChange={(value) => setZoom(value as Zoom)}>
                  <DropdownMenuRadioItem value="page">{t('zoom_page')}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="width">{t('zoom_width')}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-4 pt-3 md:px-6">
        {tab === 'document' ? (
          <div
            className={cn(
              'relative min-h-0 flex-1 transition-opacity duration-150 [container-type:size]',
              pdf.loading && pdf.url && 'opacity-80',
            )}
            aria-busy={pdf.loading}
          >
            {visible ? (
              // <object type="application/pdf">, not an <iframe>: Chrome's
              // frame pipeline intermittently blocked the PDF (see
              // InvoicePreviewCard).
              //
              // Both buffers are the same element with NO children, and a
              // promotion only flips attributes and classes. Chrome unloads a
              // PDF that has already painted in an <object> as soon as a
              // child node is inserted into it: a fallback <p> that only the
              // shown buffer carried was added to the promoted node on every
              // swap, and the preview went blank after the first edit. Never
              // put fallback content inside these; the toolbar link above is
              // the fallback.
              buffers.map((url) => {
                const isShown = url === visible
                return (
                  <object
                    key={url}
                    data={url}
                    type="application/pdf"
                    title={t('preview_title')}
                    aria-hidden={isShown ? undefined : true}
                    tabIndex={isShown ? undefined : -1}
                    onLoad={() => setShown(url)}
                    className={cn(
                      PDF_BOX[zoomOf(url)],
                      'rounded-lg border border-border bg-background',
                      !isShown && 'pointer-events-none opacity-0',
                    )}
                  />
                )
              })
            ) : (
              <Skeleton className="h-full w-full rounded-lg" aria-label={t('preview_loading')} />
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto pb-1">{renderEmail()}</div>
        )}
      </div>

      <div className="px-4 py-3 md:px-6">{statusLine}</div>
    </section>
  )
}

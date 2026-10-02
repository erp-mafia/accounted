'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
  statusLine: ReactNode
}

// PDF open parameters: no viewer toolbar or thumbnails, and the page fitted
// to the frame ("Hela sidan") or to its width ("Sidbredd").
const PDF_VIEW: Record<Zoom, string> = {
  page: '#toolbar=0&navpanes=0&view=Fit',
  width: '#toolbar=0&navpanes=0&view=FitH',
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
  statusLine,
}: EditorPreviewPaneProps) {
  const t = useTranslations('invoice_editor_shell')
  const [tab, setTab] = useState<PreviewTab>('document')
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

  return (
    <section aria-label={t('preview_aria')} className="flex min-h-[80dvh] flex-1 flex-col md:min-h-0">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 md:px-6">
        <SegmentedControl
          aria-label={t('tabs_aria')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'document', label: documentLabel },
            { value: 'email', label: t('tab_email') },
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="ml-auto inline-flex h-8 items-center gap-1 rounded-full px-3 text-[12.5px] text-muted-foreground transition-colors duration-150 hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-4 pt-3 md:px-6">
        {tab === 'document' ? (
          <div
            className={cn('relative min-h-0 flex-1 transition-opacity duration-150', pdf.loading && pdf.url && 'opacity-80')}
            aria-busy={pdf.loading}
          >
            {visible ? (
              <>
                {/* <object type="application/pdf">, not an <iframe>: Chrome's
                    frame pipeline intermittently blocked the PDF (see
                    InvoicePreviewCard). */}
                <object
                  key={visible}
                  data={visible}
                  type="application/pdf"
                  title={t('preview_title')}
                  className="absolute inset-0 h-full w-full rounded-lg border border-border bg-background"
                >
                  <p className="p-4 text-[13px] text-muted-foreground">
                    <a href={visible} target="_blank" rel="noreferrer" className="underline">
                      {t('preview_open')}
                    </a>
                  </p>
                </object>
                {target && target !== visible && (
                  <object
                    key={target}
                    data={target}
                    type="application/pdf"
                    aria-hidden="true"
                    tabIndex={-1}
                    onLoad={() => setShown(target)}
                    className="pointer-events-none absolute inset-0 h-full w-full rounded-lg border border-border bg-background opacity-0"
                  />
                )}
              </>
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

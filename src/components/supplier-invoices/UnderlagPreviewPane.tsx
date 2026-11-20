'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowTopRightOnSquareIcon, DocumentTextIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { FocusDocumentPreview, useDocumentMeta } from '@/components/inkorg/FocusDocumentPreview'
import { isUnpreviewableType } from '@/lib/documents/preview-kind'
import { cn } from '@/lib/utils'

/**
 * The underlag beside the supplier-invoice form, so supplier, amounts and
 * accounts are checked against the invoice itself. It is the preview the
 * inbox shows (FocusDocumentPreview: loading, could not be shown with a
 * retry, PDF, photo, mail HTML) as the dialog's one raised object, with the
 * way to the file in a new tab under it. A recorded type no viewer draws (a
 * spreadsheet, a Word file) says so and offers the file, instead of going to
 * the PDF plugin.
 */
export function UnderlagPreviewPane({ documentId, className }: { documentId: string; className?: string }) {
  const t = useTranslations('supplier_invoice_editor')
  const tCommon = useTranslations('common')
  const [generation, setGeneration] = useState(0)
  const { meta, state } = useDocumentMeta(documentId, generation)
  const unsupported = state === 'ready' && isUnpreviewableType(meta?.mime)
  // The file itself: the viewer shows a sized preview of a photo.
  const fileHref = `/api/documents/${documentId}/inline?original=1`

  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden rounded-lg bg-control shadow-raised', className)}>
      {/* Always present, so a screen reader hears the line when loading starts. */}
      <span role="status" className="sr-only">
        {state === 'loading' ? t('underlag_preview_loading') : null}
      </span>
      {unsupported ? (
        <div className="flex min-h-0 flex-1 px-6">
          <EmptyState icon={DocumentTextIcon} title={t('underlag_preview_unsupported')}>
            <Button asChild variant="outline" size="toolbar">
              <a href={fileHref} target="_blank" rel="noopener noreferrer">
                {tCommon('open_in_new_tab')}
              </a>
            </Button>
          </EmptyState>
        </div>
      ) : (
        <>
          <FocusDocumentPreview
            meta={meta}
            state={state}
            onRetry={() => setGeneration((n) => n + 1)}
            className="min-h-0 flex-1"
          />
          <div className="flex shrink-0 justify-end border-t-hairline px-3 py-2">
            <a
              href={fileHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {tCommon('open_in_new_tab')}
            </a>
          </div>
        </>
      )}
    </div>
  )
}

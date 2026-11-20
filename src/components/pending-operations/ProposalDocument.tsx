'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { isUuid } from '@/lib/invariants/uuid'
import { DocumentViewButton } from '@/components/bookkeeping/DocumentViewButton'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import type { ProposalDocumentRef } from './proposal-document'

/**
 * The underlag of a proposal, always last in the preview: embedded in the
 * Granskning drawer (`detail`), a button in the confirm dialog and the chat
 * card, which stay compact.
 */
export function ProposalDocument({
  docRef,
  detail,
  viewerClassName,
}: {
  docRef: ProposalDocumentRef
  detail: boolean
  /**
   * The review template's underlag slot: the file alone as one raised object
   * at this height, under the slot's own heading.
   */
  viewerClassName?: string
}) {
  if (docRef.kind === 'supplier_invoice') {
    // The lookup is one more request per card: only the review surface pays it.
    return detail ? (
      <SupplierInvoiceDocument supplierInvoiceId={docRef.supplierInvoiceId} viewerClassName={viewerClassName} />
    ) : null
  }
  return (
    <DocumentBlock
      documentId={docRef.documentId}
      fileName={docRef.fileName}
      mime={docRef.mime}
      detail={detail}
      viewerClassName={viewerClassName}
    />
  )
}

function DocumentBlock({
  documentId,
  fileName,
  mime,
  detail,
  viewerClassName,
}: {
  documentId: string
  fileName: string | null
  mime: string | null
  detail: boolean
  viewerClassName?: string
}) {
  const t = useTranslations('pending')
  if (!detail) return <DocumentViewButton documentId={documentId} />
  if (viewerClassName) {
    return (
      <div className="min-w-0 overflow-hidden rounded-lg bg-control text-sm shadow-raised">
        <DocumentViewerPane documentId={documentId} mime={mime} fileName={fileName} className={viewerClassName} />
      </div>
    )
  }
  return (
    <div className="min-w-0 space-y-2 rounded-lg p-3 text-sm bg-control shadow-raised">
      <p className="text-xs font-medium text-muted-foreground">
        {t('preview_link_document_heading')}
      </p>
      <DocumentViewerPane documentId={documentId} mime={mime} fileName={fileName} className="h-[56vh]" />
    </div>
  )
}

/**
 * The document of the supplier invoice a proposal acts on. Tagged with the
 * invoice it was fetched for, so a slow answer for the previous review never
 * renders under the next one (the DocumentViewerPane idiom). An invoice with
 * no document, or a failed read, renders nothing.
 */
function SupplierInvoiceDocument({
  supplierInvoiceId,
  viewerClassName,
}: {
  supplierInvoiceId: string
  viewerClassName?: string
}) {
  const [fetched, setFetched] = useState<{ id: string; documentId: string | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/supplier-invoices/${supplierInvoiceId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { data?: { document_id?: unknown } } | null) => {
        if (cancelled) return
        const id = body?.data?.document_id
        setFetched({ id: supplierInvoiceId, documentId: isUuid(id) ? id : null })
      })
      .catch(() => {
        if (!cancelled) setFetched({ id: supplierInvoiceId, documentId: null })
      })
    return () => {
      cancelled = true
    }
  }, [supplierInvoiceId])
  const documentId = fetched?.id === supplierInvoiceId ? fetched.documentId : null
  if (!documentId) return null
  return <DocumentBlock documentId={documentId} fileName={null} mime={null} detail viewerClassName={viewerClassName} />
}

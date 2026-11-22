'use client'

import type { ReactNode, RefObject } from 'react'
import { useTranslations } from 'next-intl'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import UnderlagFileRow from './UnderlagFileRow'
import type { useHeldUnderlag } from './use-held-underlag'

/**
 * The rows under the document a bank-row booking shows, in the booking
 * dialog and on the booking screen: the row's earlier underlag (it can be
 * taken off), one compact zone for more (the only zone then, so a drop is
 * handled once), the documents picked from the inbox, and the host's own way
 * in last.
 */
export function HeldUnderlagRows({
  attachments,
  onDetachEarlier,
  dropSurfaceRef,
  children,
}: {
  attachments: ReturnType<typeof useHeldUnderlag>
  onDetachEarlier: () => void
  dropSurfaceRef: RefObject<HTMLElement | null>
  children?: ReactNode
}) {
  const t = useTranslations('tx_booking_dialog')
  const tUnderlag = useTranslations('tx_booking_underlag')
  const tDetach = useTranslations('tx_detach')
  const { underlag } = attachments
  return (
    <div className="flex shrink-0 flex-col gap-2">
      {attachments.ownFromBefore && (
        <UnderlagFileRow
          name={underlag.fileName ?? tUnderlag('file_fallback')}
          removeLabel={tDetach('menu_item')}
          disabled={underlag.busy}
          onRemove={onDetachEarlier}
        />
      )}
      <DocumentUploadZone
        files={attachments.attached.files}
        onFilesChange={attachments.onFilesChange}
        onUploaded={attachments.claimUpload}
        compact
        dropSurfaceRef={dropSurfaceRef}
      />
      {attachments.attached.inboxDocs.map((doc) => (
        <UnderlagFileRow
          key={doc.document_id}
          name={doc.supplier_name ?? doc.file_name}
          removeLabel={t('doc_picked_remove')}
          onRemove={() => void attachments.letGo(doc.document_id)}
        />
      ))}
      {children}
    </div>
  )
}

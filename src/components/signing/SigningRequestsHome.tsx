'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowUpTrayIcon, LockClosedIcon, SpinnerIcon } from '@/components/icons'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { PageHeader } from '@/components/ui/page-header'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { isRetryableArchiveUploadFailure, uploadToArchive } from '@/lib/documents/archive-upload'
import { formatMegabytes } from '@/lib/documents/upload-size'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { SIGNABLE_FILE_ACCEPT, signableFileRefusal, type SignableFileRefusal } from '@/lib/signing/signable-file'
import { SIGNING_MAX_DOCUMENT_BYTES } from '@/lib/signing/types'
import { cn } from '@/lib/utils'
import { RequestSignatureDialog } from './RequestSignatureDialog'
import { SigningRequestsList } from './SigningRequestsList'
import { useSigningAvailability } from './use-signing-availability'

/** Where one "Ladda upp för signering" stands; the page shows one line for it, in one place. */
type UploadState =
  | { step: 'idle' }
  | { step: 'uploading'; fileName: string }
  | { step: 'refused'; fileName: string; refusal: SignableFileRefusal; size: number }
  | { step: 'failed'; file: File; reason: string; retryable: boolean }
  | { step: 'requesting'; documentId: string; fileName: string; sent: boolean }
  | { step: 'kept'; documentId: string; fileName: string }

const IDLE: UploadState = { step: 'idle' }

/**
 * /arkiv/signeringar: the list of signing requests under a top bar whose one
 * primary uploads a PDF and opens Begär signering on it (crm#1969), so a
 * document that is not in the archive yet is sent from here in one go.
 *
 * The upload is Arkiv's own (uploadToArchive): the PDF is archived as a
 * document, never filed in the bookkeeping inbox. The dialog is the Arkiv
 * record's, behind the same gate: sending needs signing in the company's
 * plan (useSigningAvailability().available, else no button at all), a PDF
 * within the signing limit (signableFileRefusal, checked before anything is
 * uploaded) and write access (useViewerLock).
 *
 * Closing the dialog without sending deletes nothing: the document stays in
 * the archive, and the page says so with the way to it.
 */
export function SigningRequestsHome() {
  const t = useTranslations('signing')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const signing = useSigningAvailability()
  const { canWrite, lockedTitle } = useViewerLock()
  const input = useRef<HTMLInputElement>(null)
  const topBarButton = useRef<HTMLButtonElement>(null)
  const [upload, setUpload] = useState<UploadState>(IDLE)
  const [reloadSignal, setReloadSignal] = useState(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const uploading = upload.step === 'uploading'
  const pick = () => {
    if (!uploading) input.current?.click()
  }
  // The button is disabled while the file goes up, which drops keyboard focus on the page itself: once the upload
  // has ended (refused by the server, or its dialog closed), focus goes back to the button unless the person moved on.
  const refocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (document.activeElement === document.body) topBarButton.current?.focus()
    })
  }, [])

  const send = useCallback(
    async (file: File) => {
      const refusal = signableFileRefusal(file)
      if (refusal) {
        setUpload({ step: 'refused', fileName: file.name, refusal, size: file.size })
        return
      }
      setUpload({ step: 'uploading', fileName: file.name })
      const result = await uploadToArchive(file)
      if (!alive.current) return
      if (!result.ok) {
        const reason = getErrorMessage(result.body, { locale, statusCode: result.status || undefined, fallback: t('upload_for_signing_no_answer') })
        setUpload({ step: 'failed', file, reason, retryable: isRetryableArchiveUploadFailure(result.status) })
        refocus()
        return
      }
      setUpload({ step: 'requesting', documentId: result.documentId, fileName: file.name, sent: false })
    },
    [locale, t, refocus],
  )

  // The page's one primary, drawn in the top bar and again in the empty list.
  const buttonProps = { loading: uploading, disabled: !canWrite, title: lockedTitle, onClick: pick }
  const buttonLabel = (
    <>
      {/* Kept mounted while the spinner shows, like the spinner itself (components/ui/button.tsx). */}
      {canWrite ? (
        <ArrowUpTrayIcon aria-hidden="true" className={cn('h-4 w-4', uploading && 'hidden')} />
      ) : (
        <LockClosedIcon aria-hidden="true" className="h-4 w-4" />
      )}
      {t('upload_for_signing')}
    </>
  )

  // One line for the upload, where the list's own refresh line would be. The file's name is the person's data.
  let notice: React.ReactNode = null
  if (upload.step === 'uploading') {
    notice = (
      // The geometry of AttnLine, with the spinner where its glyph sits: the sentence stays put when the line changes.
      <div role="status" data-ph-mask="" className="flex items-start gap-2 text-[13px] leading-5 text-muted-foreground">
        <SpinnerIcon aria-hidden="true" className="mt-[3px] h-3.5 w-3.5 animate-spin" />
        <span className="min-w-0">{t('upload_for_signing_progress', { name: upload.fileName })}</span>
      </div>
    )
  } else if (upload.step === 'refused') {
    notice = (
      <div role="alert" data-ph-mask="">
        <AttnLine action={{ label: t('upload_for_signing_other_file'), onClick: pick }}>
          {upload.refusal === 'too_large'
            ? t('upload_for_signing_too_large', { name: upload.fileName, size: formatMegabytes(upload.size), limit: formatMegabytes(SIGNING_MAX_DOCUMENT_BYTES) })
            : t('upload_for_signing_not_pdf', { name: upload.fileName })}
        </AttnLine>
      </div>
    )
  } else if (upload.step === 'failed') {
    const { file, retryable } = upload
    notice = (
      <div role="alert" data-ph-mask="">
        <AttnLine action={retryable ? { label: tCommon('retry'), onClick: () => void send(file) } : { label: t('upload_for_signing_other_file'), onClick: pick }}>
          {t('upload_for_signing_failed', { name: file.name, reason: upload.reason })}
        </AttnLine>
      </div>
    )
  } else if (upload.step === 'kept') {
    notice = (
      <div role="status" data-ph-mask="">
        <AttnLine tone="info" action={{ label: t('upload_for_signing_open_document'), href: `/arkiv/dokument/${upload.documentId}` }}>
          {t('upload_for_signing_kept', { name: upload.fileName })}
        </AttnLine>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('list_title')}
        help={<HelpPopover>{signing.available ? t('list_help_upload') : t('list_help')}</HelpPopover>}
        action={
          signing.available ? (
            <Button ref={topBarButton} size="toolbar" {...buttonProps}>
              {buttonLabel}
            </Button>
          ) : undefined
        }
      />
      <input
        ref={input}
        type="file"
        accept={SIGNABLE_FILE_ACCEPT}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Cleared so the same file can be picked again after a refusal.
          e.target.value = ''
          if (file) void send(file)
        }}
      />
      <SigningRequestsList
        reloadSignal={reloadSignal}
        notice={notice}
        // Offered again where the first row would be, to someone who can use it.
        emptyOffer={
          signing.available && canWrite ? { description: t('list_empty_upload_body'), action: <Button size="toolbar" {...buttonProps}>{buttonLabel}</Button> } : undefined
        }
      />
      {upload.step === 'requesting' && (
        <RequestSignatureDialog
          key={upload.documentId}
          documentId={upload.documentId}
          fileName={upload.fileName}
          onOpenChange={(open) => {
            if (open) return
            setUpload((u) => (u.step !== 'requesting' ? u : u.sent ? IDLE : { step: 'kept', documentId: u.documentId, fileName: u.fileName }))
            refocus()
          }}
          onCreated={() => {
            // The request exists: the list reads again, and closing the dialog now has nothing left to say.
            setUpload((u) => (u.step === 'requesting' ? { ...u, sent: true } : u))
            setReloadSignal((n) => n + 1)
          }}
        />
      )}
    </div>
  )
}

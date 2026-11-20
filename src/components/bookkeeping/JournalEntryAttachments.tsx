'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { LoadError } from '@/components/ui/empty-state'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn } from '@/lib/utils'
import { openDeferredTab } from '@/lib/browser/deferred-tab'
import { DocumentPreview } from '@/components/bookkeeping/DocumentPreview'
import { documentPreviewKind } from '@/lib/documents/preview-kind'
import { postDocumentForm } from '@/lib/documents/direct-upload'
import { prepareDocumentUpload } from '@/lib/documents/shrink-image'
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  InboxIcon,
  LockClosedIcon,
  PhotoIcon,
  PlusIcon,
  TrashIcon,
} from '@/components/icons'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import InboxDocumentPicker from '@/components/bookkeeping/InboxDocumentPicker'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { useBranding } from '@/lib/branding/brand-context'
import { DOCUMENT_UPLOAD_ACCEPT } from '@/lib/documents/upload-types'

interface DocumentRecord {
  id: string
  file_name: string
  file_size_bytes: number
  mime_type: string | null
  storage_path: string
  created_at: string
  sha256_hash?: string | null
  referenced?: boolean
}

interface JournalEntryAttachmentsProps {
  journalEntryId: string
  onCountChange?: (count: number) => void
  /**
   * 'section': embedded under a DetailSection kicker that already names the
   * group and states the empty case (verifikat detail page). Drops the own
   * border, heading and empty line so nothing is said twice; the action
   * buttons and the document list stay. Default keeps the self-contained
   * foldout look used by JournalEntryList.
   */
  variant?: 'default' | 'section'
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function JournalEntryAttachments({
  journalEntryId,
  onCountChange,
  variant = 'default',
}: JournalEntryAttachmentsProps) {
  const embedded = variant === 'section'
  const t = useTranslations('journal_attachments')
  const tCommon = useTranslations('common')
  const { appName } = useBranding()
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite, lockedTitle } = useViewerLock()
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [loading, setLoading] = useState(true)
  // The underlag list could not load: said in place with "Försök igen"
  // (Stil v3 states), never an empty list that reads as "no underlag".
  const [loadFailed, setLoadFailed] = useState(false)
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [showInboxPicker, setShowInboxPicker] = useState(false)
  const [uploadFiles, setUploadFiles] = useState<UploadedFile[]>([])

  // Docs listed here are filtered by journal_entry_id, so every row is bound
  // to a verifikation: BFL 7 kap 2§ blocks deletion. "Ta bort" therefore
  // surfaces the educational modal; "Ersätt" goes through createNewVersion()
  // so the original stays in the version chain.
  const [blockedDoc, setBlockedDoc] = useState<DocumentRecord | null>(null)
  const [replacingDocId, setReplacingDocId] = useState<string | null>(null)
  const [detachingDocId, setDetachingDocId] = useState<string | null>(null)
  const replaceFileInputRef = useRef<HTMLInputElement | null>(null)
  const replaceTargetIdRef = useRef<string | null>(null)
  // The upload zone's own file input: "Lägg till underlag" opens the OS
  // picker in the same click. It used to only toggle the zone, so a second
  // click (the one users made, expecting the picker) closed it again.
  const addFileInputRef = useRef<HTMLInputElement | null>(null)

  const onCountChangeRef = useRef(onCountChange)
  onCountChangeRef.current = onCountChange

  const fetchDocuments = useCallback(async () => {
    try {
      const [documentsRes, referencesRes] = await Promise.all([
        fetch(`/api/documents?journal_entry_id=${journalEntryId}&current_only=true`),
        fetch(`/api/bookkeeping/journal-entries/${journalEntryId}/references`),
      ])
      if (!documentsRes.ok) {
        setLoadFailed(true)
        return
      }
      const { data: directDocuments } = await documentsRes.json()
      const direct = (directDocuments || []) as DocumentRecord[]
      const directIds = new Set(direct.map((document) => document.id))

      let referenced: DocumentRecord[] = []
      if (referencesRes.ok) {
        const { data: referenceData } = await referencesRes.json()
        const documentIds = Array.from(new Set<string>(
          (referenceData?.references || [])
            .map((reference: { document_id?: string }) => reference.document_id)
            .filter((documentId: string | undefined): documentId is string => (
              Boolean(documentId) && !directIds.has(documentId as string)
            )),
        ))

        const referencedDocuments = await Promise.all(
          documentIds.map(async (documentId) => {
            try {
              const response = await fetch(`/api/documents/${documentId}`)
              if (!response.ok) return null
              const { data } = await response.json()
              return data ? { ...data, referenced: true } as DocumentRecord : null
            } catch {
              return null
            }
          }),
        )
        referenced = referencedDocuments.filter(
          (document): document is DocumentRecord => document !== null,
        )
      }

      const allDocuments = [...direct, ...referenced]
      setDocuments(allDocuments)
      onCountChangeRef.current?.(allDocuments.length)
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [journalEntryId])

  useEffect(() => {
    fetchDocuments()
  }, [fetchDocuments])

  // Refresh documents when uploads complete
  useEffect(() => {
    const allDone = uploadFiles.length > 0 && uploadFiles.every((f) => f.status !== 'uploading')
    const hasUploaded = uploadFiles.some((f) => f.status === 'uploaded')
    if (allDone && hasUploaded) {
      fetchDocuments()
      setUploadFiles([])
      setShowUpload(false)
    }
  }, [uploadFiles, fetchDocuments])

  const handleDownload = async (docId: string) => {
    // Pre-open inside the click's user activation: a window.open after the
    // await is popup-blocked when the signed-URL fetch is slow.
    const tab = openDeferredTab(tCommon('loading'))
    try {
      const res = await fetch(`/api/documents/${docId}`)
      const { data } = await res.json()
      if (!data?.download_url || !tab.navigate(data.download_url)) {
        tab.close()
        toast({
          title: t('download_failed'),
          description: tab.blocked ? tCommon('popup_blocked_description', { appName }) : undefined,
          variant: 'destructive',
        })
      }
    } catch {
      tab.close()
      toast({ title: t('download_failed'), variant: 'destructive' })
    }
  }

  // Opens at once: the preview loads from the same-origin inline route, so
  // nothing has to be fetched first. A signed-URL round trip used to sit
  // before the expand with no feedback, and the clicks made while waiting
  // toggled the preview shut again.
  const handlePreviewToggle = (doc: DocumentRecord) => {
    setExpandedDoc((current) => (current === doc.id ? null : doc.id))
  }

  const handleAddClick = () => {
    setShowUpload(true)
    addFileInputRef.current?.click()
  }

  const handleRequestRemove = (doc: DocumentRecord) => {
    setBlockedDoc(doc)
  }

  // A duplicate may be detached (not deleted) only when another directly
  // anchored doc with the SAME content hash remains on the verifikat: the
  // detach_underlag_duplicate RPC enforces sha256 equality, so the button is
  // gated on the same condition. Referenced docs (via a supplier invoice)
  // don't count: they are not anchored to this entry.
  const hasDuplicateSibling = (doc: DocumentRecord) =>
    Boolean(doc.sha256_hash) &&
    documents.some(
      (d) => !d.referenced && d.id !== doc.id && d.sha256_hash === doc.sha256_hash,
    )

  const handleDetach = async (doc: DocumentRecord) => {
    setDetachingDocId(doc.id)
    try {
      const res = await fetch(`/api/documents/${doc.id}/detach`, { method: 'POST' })
      if (!res.ok) {
        const failure = await res.json().catch(() => null)
        toast({
          title: t('detach_failed'),
          description: getErrorMessage(failure, { statusCode: res.status, locale: errorLocale }),
          variant: 'destructive',
        })
      } else {
        await fetchDocuments()
        setBlockedDoc(null)
      }
    } catch {
      toast({ title: t('detach_failed'), variant: 'destructive' })
    } finally {
      setDetachingDocId(null)
    }
  }

  const handleOpenReplacePicker = (docId: string) => {
    replaceTargetIdRef.current = docId
    replaceFileInputRef.current?.click()
  }

  const handleReplaceFileSelected = async (file: File | null) => {
    const docId = replaceTargetIdRef.current
    replaceTargetIdRef.current = null
    if (replaceFileInputRef.current) {
      replaceFileInputRef.current.value = ''
    }
    if (!file || !docId) return

    setReplacingDocId(docId)
    try {
      const prepared = await prepareDocumentUpload(file)
      if (!prepared.ok) {
        toast({ title: t('replace_failed'), description: prepared.message, variant: 'destructive' })
        return
      }
      const res = await postDocumentForm(`/api/documents/${docId}/versions`, new FormData(), prepared.file)
      if (!res.ok) {
        const failure = await res.json().catch(() => null)
        toast({
          title: t('replace_failed'),
          description: getErrorMessage(failure, { statusCode: res.status, locale: errorLocale }),
          variant: 'destructive',
        })
      } else {
        await fetchDocuments()
        setBlockedDoc(null)
      }
    } catch {
      toast({ title: t('replace_failed'), variant: 'destructive' })
    } finally {
      setReplacingDocId(null)
    }
  }

  if (loading) {
    return (
      <LateReveal className="space-y-2 py-2" aria-label={t('loading')}>
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-4 w-40" />
      </LateReveal>
    )
  }

  return (
    <div className={embedded ? undefined : 'border-t pt-3 mt-3'}>
      <input
        ref={replaceFileInputRef}
        type="file"
        accept={DOCUMENT_UPLOAD_ACCEPT}
        className="hidden"
        onChange={(e) => handleReplaceFileSelected(e.target.files?.[0] ?? null)}
      />

      <div className={cn('mb-2 flex items-center gap-2', embedded ? 'justify-end' : 'justify-between')}>
        {!embedded && (
          <h4 className="text-sm font-medium">
            {t('title')} {documents.length > 0 && `(${documents.length})`}
          </h4>
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setShowInboxPicker(true)}
            disabled={!canWrite}
            title={lockedTitle}
          >
            <InboxIcon className="h-3 w-3" />
            {t('choose_from_inbox')}
          </Button>
          <Button
            variant="outline"
            onClick={handleAddClick}
            disabled={!canWrite}
            title={lockedTitle}
          >
            <PlusIcon className="h-3 w-3" />
            {t('add')}
          </Button>
        </div>
      </div>

      {/* Always mounted so the button can reach its file input; shown once
          the button was used, for drag and drop and the upload progress. */}
      <div className={showUpload ? 'mb-3' : 'hidden'}>
        <DocumentUploadZone
          files={uploadFiles}
          onFilesChange={setUploadFiles}
          journalEntryId={journalEntryId}
          fileInputRef={addFileInputRef}
          disabled={!canWrite}
          compact
        />
      </div>

      {loadFailed && documents.length === 0 ? (
        <LoadError title={t('load_failed')} onRetry={() => void fetchDocuments()} />
      ) : documents.length === 0 && !showUpload ? (
        !embedded && (
          <p className="text-sm text-muted-foreground py-1">
            {t('empty')}
          </p>
        )
      ) : (
        <div className="space-y-1">
          {documents.map((doc) => {
            const isReplacing = replacingDocId === doc.id
            const kind = documentPreviewKind(doc.mime_type, doc.file_name)
            const previewable = kind === 'pdf' || kind === 'image'
            const isExpanded = expandedDoc === doc.id
            return (
              <div key={doc.id}>
                <div className="flex items-center gap-2 text-sm py-1.5 px-2 rounded-sm bg-muted/50">
                  {previewable ? (
                    // The chevron, the icon and the file name are one toggle:
                    // the 16 px chevron alone was the most rage-clicked target
                    // on /bookkeeping.
                    <button
                      type="button"
                      onClick={() => handlePreviewToggle(doc)}
                      aria-expanded={isExpanded}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-primary transition-colors"
                    >
                      {isExpanded ? (
                        <ChevronUpIcon className="h-4 w-4 shrink-0" />
                      ) : (
                        <ChevronDownIcon className="h-4 w-4 shrink-0" />
                      )}
                      {!isExpanded && (
                        kind === 'image' ? (
                          <PhotoIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                        ) : (
                          <DocumentTextIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                        )
                      )}
                      <span className="truncate flex-1">{doc.file_name}</span>
                    </button>
                  ) : (
                    <>
                      <DocumentTextIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="truncate flex-1">{doc.file_name}</span>
                    </>
                  )}
                  {doc.referenced && (
                    <Badge variant="secondary" className="shrink-0">
                      {t('via_supplier_invoice')}
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatFileSize(doc.file_size_bytes)}
                  </span>

                  {!doc.referenced && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0"
                        onClick={() => handleOpenReplacePicker(doc.id)}
                        loading={isReplacing}
                        disabled={!canWrite}
                        title={lockedTitle ?? t('replace')}
                        aria-label={t('replace')}
                      >
                        {!isReplacing && <ArrowPathIcon className="h-3 w-3" />}
                      </Button>

                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0"
                        onClick={() => handleRequestRemove(doc)}
                        disabled={!canWrite}
                        title={lockedTitle ?? t('remove')}
                        aria-label={t('remove')}
                      >
                        <TrashIcon className="h-3 w-3" />
                      </Button>
                    </>
                  )}

                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={() => handleDownload(doc.id)}
                    title={t('download')}
                    aria-label={t('download')}
                  >
                    <ArrowDownTrayIcon className="h-3 w-3" />
                  </Button>
                </div>

                {isExpanded && previewable && (
                  <div className="px-2 py-2">
                    <DocumentPreview
                      src={`/api/documents/${doc.id}/inline`}
                      kind={kind}
                      label={doc.file_name}
                      className="h-[60vh] w-full rounded-lg bg-control shadow-raised"
                      imageClassName="max-h-48 rounded-lg object-contain"
                      fallback={
                        <button
                          type="button"
                          onClick={() => handleDownload(doc.id)}
                          className="block px-4 py-2 text-sm text-muted-foreground underline"
                        >
                          {t('download')}
                        </button>
                      }
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <Dialog
        open={blockedDoc !== null}
        onOpenChange={(o) => {
          if (!o) setBlockedDoc(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted shrink-0">
                <LockClosedIcon className="h-5 w-5 text-attn" />
              </div>
              <DialogTitle>{t('remove_blocked_title')}</DialogTitle>
            </div>
            <DialogDescription className="pt-3 text-sm text-muted-foreground">
              {t('remove_blocked_body')}
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg p-3 text-sm bg-control shadow-raised">
            <div className="flex items-start gap-2">
              <ExclamationTriangleIcon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-muted-foreground">
                {blockedDoc !== null && hasDuplicateSibling(blockedDoc)
                  ? t('detach_hint')
                  : t('remove_blocked_hint')}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setBlockedDoc(null)}>
              {t('remove_blocked_cancel_cta')}
            </Button>
            {blockedDoc !== null && hasDuplicateSibling(blockedDoc) && (
              <Button
                variant="outline"
                onClick={() => {
                  if (blockedDoc) handleDetach(blockedDoc)
                }}
                loading={blockedDoc !== null && detachingDocId === blockedDoc.id}
              >
                {blockedDoc !== null && detachingDocId === blockedDoc.id ? (
                  t('detaching')
                ) : (
                  t('detach_cta')
                )}
              </Button>
            )}
            <Button
              onClick={() => {
                if (blockedDoc) handleOpenReplacePicker(blockedDoc.id)
              }}
              loading={blockedDoc !== null && replacingDocId === blockedDoc.id}
            >
              {blockedDoc !== null && replacingDocId === blockedDoc.id ? (
                t('replace_uploading')
              ) : (
                t('remove_blocked_replace_cta')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <InboxDocumentPicker
        open={showInboxPicker}
        onClose={() => setShowInboxPicker(false)}
        journalEntryId={journalEntryId}
        onLinked={fetchDocuments}
      />
    </div>
  )
}

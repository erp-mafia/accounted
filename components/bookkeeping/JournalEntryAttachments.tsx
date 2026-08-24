'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { openDeferredTab } from '@/lib/browser/deferred-tab'
import {
  FileText,
  ImageIcon,
  Download,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  RefreshCw,
  Loader2,
  Lock,
  AlertTriangle,
  Inbox,
} from 'lucide-react'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import InboxDocumentPicker from '@/components/bookkeeping/InboxDocumentPicker'

interface DocumentRecord {
  id: string
  file_name: string
  file_size_bytes: number
  mime_type: string | null
  storage_path: string
  created_at: string
  sha256_hash?: string | null
  download_url?: string
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

function isImageType(type: string | null): boolean {
  return type?.startsWith('image/') ?? false
}

function isPdfType(type: string | null): boolean {
  return type === 'application/pdf'
}

function isPreviewable(type: string | null): boolean {
  return isImageType(type) || isPdfType(type)
}

export default function JournalEntryAttachments({
  journalEntryId,
  onCountChange,
  variant = 'default',
}: JournalEntryAttachmentsProps) {
  const embedded = variant === 'section'
  const t = useTranslations('journal_attachments')
  const tCommon = useTranslations('common')
  const { toast } = useToast()
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [loading, setLoading] = useState(true)
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

  const onCountChangeRef = useRef(onCountChange)
  onCountChangeRef.current = onCountChange

  const fetchDocuments = useCallback(async () => {
    try {
      const [documentsRes, referencesRes] = await Promise.all([
        fetch(`/api/documents?journal_entry_id=${journalEntryId}&current_only=true`),
        fetch(`/api/bookkeeping/journal-entries/${journalEntryId}/references`),
      ])
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
    } catch {
      // Non-critical: silently ignore
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
          description: tab.blocked ? tCommon('popup_blocked_description') : undefined,
          variant: 'destructive',
        })
      }
    } catch {
      tab.close()
      toast({ title: t('download_failed'), variant: 'destructive' })
    }
  }

  const handlePreviewToggle = async (doc: DocumentRecord) => {
    if (expandedDoc === doc.id) {
      setExpandedDoc(null)
      return
    }

    if (!doc.download_url) {
      try {
        const res = await fetch(`/api/documents/${doc.id}`)
        const { data } = await res.json()
        if (data?.download_url) {
          setDocuments((prev) =>
            prev.map((d) => (d.id === doc.id ? { ...d, download_url: data.download_url } : d))
          )
        }
      } catch {
        return
      }
    }

    setExpandedDoc(doc.id)
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
        const { error } = await res.json().catch(() => ({ error: undefined }))
        toast({
          title: t('detach_failed'),
          description: typeof error === 'string' ? error : undefined,
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
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`/api/documents/${docId}/versions`, {
        method: 'POST',
        body: fd,
      })
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: undefined }))
        toast({
          title: t('replace_failed'),
          description: error || undefined,
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
      <div className="py-2 text-sm text-muted-foreground">
        {t('loading')}
      </div>
    )
  }

  return (
    <div className={embedded ? undefined : 'border-t pt-3 mt-3'}>
      <input
        ref={replaceFileInputRef}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp"
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
            size="sm"
            className="h-7 text-xs"
            onClick={() => setShowInboxPicker(true)}
          >
            <Inbox className="h-3 w-3 mr-1" />
            {t('choose_from_inbox')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setShowUpload(!showUpload)}
          >
            <Plus className="h-3 w-3 mr-1" />
            {t('add')}
          </Button>
        </div>
      </div>

      {showUpload && (
        <div className="mb-3">
          <DocumentUploadZone
            files={uploadFiles}
            onFilesChange={setUploadFiles}
            journalEntryId={journalEntryId}
            compact
          />
        </div>
      )}

      {documents.length === 0 && !showUpload ? (
        !embedded && (
          <p className="text-sm text-muted-foreground py-1">
            {t('empty')}
          </p>
        )
      ) : (
        <div className="space-y-1">
          {documents.map((doc) => {
            const isReplacing = replacingDocId === doc.id
            return (
              <div key={doc.id}>
                <div className="flex items-center gap-2 text-sm py-1.5 px-2 rounded-sm bg-muted/50">
                  {isPreviewable(doc.mime_type) ? (
                    <button
                      onClick={() => handlePreviewToggle(doc)}
                      className="shrink-0 hover:text-primary transition-colors"
                    >
                      {expandedDoc === doc.id ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </button>
                  ) : (
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}

                  {isPreviewable(doc.mime_type) && expandedDoc !== doc.id && (
                    isImageType(doc.mime_type) ? (
                      <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                    ) : (
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    )
                  )}

                  <span className="truncate flex-1">{doc.file_name}</span>
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
                        size="sm"
                        className="h-6 w-6 p-0 shrink-0 min-h-[44px] min-w-[44px]"
                        onClick={() => handleOpenReplacePicker(doc.id)}
                        disabled={isReplacing}
                        title={t('replace')}
                        aria-label={t('replace')}
                      >
                        {isReplacing ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                      </Button>

                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 shrink-0 min-h-[44px] min-w-[44px]"
                        onClick={() => handleRequestRemove(doc)}
                        title={t('remove')}
                        aria-label={t('remove')}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </>
                  )}

                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 shrink-0 min-h-[44px] min-w-[44px]"
                    onClick={() => handleDownload(doc.id)}
                    title={t('download')}
                    aria-label={t('download')}
                  >
                    <Download className="h-3 w-3" />
                  </Button>
                </div>

                {expandedDoc === doc.id && doc.download_url && isImageType(doc.mime_type) && (
                  <div className="px-2 py-2">
                    <img
                      src={`/api/documents/${doc.id}/inline`}
                      alt={doc.file_name}
                      className="max-h-48 rounded-lg object-contain"
                    />
                  </div>
                )}

                {expandedDoc === doc.id && doc.download_url && isPdfType(doc.mime_type) && (
                  <div className="px-2 py-2">
                    {/* <object> + type="application/pdf" invokes Chrome's PDF
                        plugin directly. <iframe> intermittently surfaced
                        "Det här innehållet har blockerats" in Chrome even
                        with a permissive CSP. See crbug.com/271452. */}
                    <object
                      data={`/api/documents/${doc.id}/inline`}
                      type="application/pdf"
                      aria-label={doc.file_name}
                      className="w-full h-[60vh] rounded-lg border"
                    >
                      <a
                        href={doc.download_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block px-4 py-2 text-sm text-muted-foreground underline"
                      >
                        {t('download')}
                      </a>
                    </object>
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
                <Lock className="h-5 w-5 text-attn" />
              </div>
              <DialogTitle>{t('remove_blocked_title')}</DialogTitle>
            </div>
            <DialogDescription className="pt-3 text-sm text-muted-foreground">
              {t('remove_blocked_body')}
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
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
                disabled={blockedDoc !== null && detachingDocId === blockedDoc.id}
              >
                {blockedDoc !== null && detachingDocId === blockedDoc.id ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('detaching')}
                  </>
                ) : (
                  t('detach_cta')
                )}
              </Button>
            )}
            <Button
              onClick={() => {
                if (blockedDoc) handleOpenReplacePicker(blockedDoc.id)
              }}
              disabled={blockedDoc !== null && replacingDocId === blockedDoc.id}
            >
              {blockedDoc !== null && replacingDocId === blockedDoc.id ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('replace_uploading')}
                </>
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

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
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
} from 'lucide-react'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'

interface DocumentRecord {
  id: string
  file_name: string
  file_size_bytes: number
  mime_type: string | null
  storage_path: string
  created_at: string
  download_url?: string
}

interface JournalEntryAttachmentsProps {
  journalEntryId: string
  onCountChange?: (count: number) => void
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
}: JournalEntryAttachmentsProps) {
  const t = useTranslations('journal_attachments')
  const { toast } = useToast()
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [uploadFiles, setUploadFiles] = useState<UploadedFile[]>([])

  // Docs listed here are filtered by journal_entry_id, so every row is bound
  // to a verifikation — BFL 7 kap 2§ blocks deletion. "Ta bort" therefore
  // surfaces the educational modal; "Ersätt" goes through createNewVersion()
  // so the original stays in the version chain.
  const [blockedDoc, setBlockedDoc] = useState<DocumentRecord | null>(null)
  const [replacingDocId, setReplacingDocId] = useState<string | null>(null)
  const replaceFileInputRef = useRef<HTMLInputElement | null>(null)
  const replaceTargetIdRef = useRef<string | null>(null)

  const onCountChangeRef = useRef(onCountChange)
  onCountChangeRef.current = onCountChange

  const fetchDocuments = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/documents?journal_entry_id=${journalEntryId}&current_only=true`
      )
      const { data } = await res.json()
      setDocuments(data || [])
      onCountChangeRef.current?.(data?.length || 0)
    } catch {
      // Non-critical — silently ignore
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
    try {
      const res = await fetch(`/api/documents/${docId}`)
      const { data } = await res.json()
      if (data?.download_url) {
        window.open(data.download_url, '_blank')
      }
    } catch {
      // Non-critical — silently ignore
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
    <div className="border-t pt-3 mt-3">
      <input
        ref={replaceFileInputRef}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => handleReplaceFileSelected(e.target.files?.[0] ?? null)}
      />

      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-medium">
          {t('title')} {documents.length > 0 && `(${documents.length})`}
        </h4>
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
        <p className="text-sm text-muted-foreground py-1">
          {t('empty')}
        </p>
      ) : (
        <div className="space-y-1">
          {documents.map((doc) => {
            const isReplacing = replacingDocId === doc.id
            return (
              <div key={doc.id}>
                <div className="flex items-center gap-2 text-sm py-1.5 px-2 rounded bg-muted/50">
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
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatFileSize(doc.file_size_bytes)}
                  </span>

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
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-warning/15 shrink-0">
                <Lock className="h-5 w-5 text-warning-foreground" />
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
              <p className="text-muted-foreground">{t('remove_blocked_hint')}</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setBlockedDoc(null)}>
              {t('remove_blocked_cancel_cta')}
            </Button>
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
    </div>
  )
}

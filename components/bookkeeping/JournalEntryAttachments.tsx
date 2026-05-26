'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { FileText, ImageIcon, Download, ChevronDown, ChevronUp, Plus } from 'lucide-react'
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
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [uploadFiles, setUploadFiles] = useState<UploadedFile[]>([])

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

    // Fetch signed URL for preview if not already loaded
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
        // Non-critical — silently ignore
        return
      }
    }

    setExpandedDoc(doc.id)
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

      {/* Upload zone */}
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

      {/* Document list */}
      {documents.length === 0 && !showUpload ? (
        <p className="text-sm text-muted-foreground py-1">
          {t('empty')}
        </p>
      ) : (
        <div className="space-y-1">
          {documents.map((doc) => (
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
                  onClick={() => handleDownload(doc.id)}
                  title={t('download')}
                >
                  <Download className="h-3 w-3" />
                </Button>
              </div>

              {/* Image preview */}
              {expandedDoc === doc.id && doc.download_url && isImageType(doc.mime_type) && (
                <div className="px-2 py-2">
                  <img
                    src={`/api/documents/${doc.id}/inline`}
                    alt={doc.file_name}
                    className="max-h-48 rounded-lg object-contain"
                  />
                </div>
              )}

              {/* PDF preview */}
              {expandedDoc === doc.id && doc.download_url && isPdfType(doc.mime_type) && (
                <div className="px-2 py-2">
                  <iframe
                    src={`/api/documents/${doc.id}/inline`}
                    title={doc.file_name}
                    className="w-full h-[60vh] rounded-lg border"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

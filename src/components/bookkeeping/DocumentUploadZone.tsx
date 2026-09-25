'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Upload, FileText, ImageIcon, X, Loader2 } from 'lucide-react'

export interface UploadedFile {
  id?: string
  file: File
  status: 'pending' | 'uploading' | 'uploaded' | 'error'
  error?: string
  fileName: string
  fileSize: number
  /** Unique key to track this upload (handles duplicate filenames) */
  uploadKey: string
}

interface DocumentUploadZoneProps {
  files: UploadedFile[]
  onFilesChange: (files: UploadedFile[]) => void
  journalEntryId?: string
  maxFiles?: number
  disabled?: boolean
  compact?: boolean
  /**
   * An ancestor (typically the dialog content) that takes a dropped file as
   * if it landed in the dashed box. While a file is dragged over it, the
   * whole surface is outlined and a drop anywhere on it uploads, so nobody
   * has to hit the small box (or, missing it, have the browser open the
   * file in the tab).
   */
  dropSurfaceRef?: React.RefObject<HTMLElement | null>
}

let uploadCounter = 0
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const ACCEPTED_EXTENSIONS = '.pdf,.jpg,.jpeg,.png,.webp,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.odt,.ods,.odp,.rtf,.csv'
const FILE_NAME_TAIL_LENGTH = 16

function TruncatedFileName({ fileName }: { fileName: string }) {
  const characters = Array.from(fileName)

  if (characters.length <= FILE_NAME_TAIL_LENGTH * 2) {
    return (
      <span className="min-w-0 flex-1 truncate" title={fileName}>
        {fileName}
      </span>
    )
  }

  const splitAt = characters.length - FILE_NAME_TAIL_LENGTH
  const start = characters.slice(0, splitAt).join('')
  const end = characters.slice(splitAt).join('')

  return (
    <span
      className="flex min-w-0 flex-1"
      title={fileName}
    >
      <span className="sr-only">{fileName}</span>
      <span aria-hidden="true" className="min-w-0 flex-1 truncate">
        {start}
      </span>
      <span
        aria-hidden="true"
        className="max-w-1/2 shrink overflow-hidden whitespace-nowrap text-right"
      >
        {end}
      </span>
    </span>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isImageType(type: string): boolean {
  return type.startsWith('image/')
}

/**
 * Extract a Swedish error message from the structured error envelope
 * returned by /api/documents. Falls back to message_en or null if the
 * shape is unexpected.
 */
function extractErrorMessage(err: unknown, locale: string): string | null {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; message_en?: unknown; code?: unknown }
    if (locale === 'en' && typeof e.message_en === 'string' && e.message_en.length > 0) {
      return e.message_en
    }
    if (typeof e.message === 'string' && e.message.length > 0) return e.message
    if (typeof e.message_en === 'string' && e.message_en.length > 0) return e.message_en
    if (typeof e.code === 'string') return e.code
  }
  return null
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

export default function DocumentUploadZone({
  files,
  onFilesChange,
  journalEntryId,
  maxFiles = 5,
  disabled = false,
  compact = false,
  dropSurfaceRef,
}: DocumentUploadZoneProps) {
  const t = useTranslations('document_upload')
  const locale = useLocale()
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const zoneRef = useRef<HTMLDivElement>(null)
  // The surface's outline is a fixed overlay over the surface's box (the
  // surface scrolls, an absolute child would scroll with it). Null while no
  // file is over the surface.
  const [surfaceRect, setSurfaceRect] = useState<DOMRect | null>(null)

  const uploadFile = useCallback(async (file: UploadedFile): Promise<UploadedFile> => {
    const formData = new FormData()
    formData.append('file', file.file)
    formData.append('upload_source', 'file_upload')
    if (journalEntryId) {
      formData.append('journal_entry_id', journalEntryId)
    }

    try {
      const res = await fetch('/api/documents', {
        method: 'POST',
        body: formData,
      })

      // Try to parse JSON, but tolerate non-JSON responses (auth redirect HTML, 502 etc.)
      let result: { data?: { id?: string }; error?: unknown } = {}
      try {
        result = await res.json()
      } catch {
        console.warn('[DocumentUploadZone] Non-JSON response', {
          status: res.status,
          fileName: file.fileName,
        })
        const reason = res.status === 401 || res.status === 403
          ? t('session_expired')
          : t('server_status', { status: res.status })
        return { ...file, status: 'error', error: reason }
      }

      if (!res.ok || result.error) {
        const errMessage = extractErrorMessage(result.error, locale) || t('failed_status', { status: res.status })
        console.warn('[DocumentUploadZone] Upload error', {
          status: res.status,
          error: result.error,
          fileName: file.fileName,
        })
        return { ...file, status: 'error', error: errMessage }
      }

      return { ...file, status: 'uploaded', id: result.data?.id }
    } catch (err) {
      console.error('[DocumentUploadZone] Upload threw', {
        error: err,
        fileName: file.fileName,
      })
      return { ...file, status: 'error', error: t('network_error') }
    }
  }, [journalEntryId, locale, t])

  const handleFiles = useCallback(async (newFiles: File[]) => {
    const remaining = maxFiles - files.length
    if (remaining <= 0) return

    const validFiles: UploadedFile[] = []

    for (const file of newFiles.slice(0, remaining)) {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        validFiles.push({
          file,
          status: 'error',
          error: t('unsupported_type'),
          fileName: file.name,
          fileSize: file.size,
          uploadKey: `upload-${++uploadCounter}`,
        })
        continue
      }
      if (file.size > MAX_FILE_SIZE) {
        validFiles.push({
          file,
          status: 'error',
          error: t('too_large'),
          fileName: file.name,
          fileSize: file.size,
          uploadKey: `upload-${++uploadCounter}`,
        })
        continue
      }
      validFiles.push({
        file,
        status: 'uploading',
        fileName: file.name,
        fileSize: file.size,
        uploadKey: `upload-${++uploadCounter}`,
      })
    }

    let currentFiles = [...files, ...validFiles]
    onFilesChange(currentFiles)

    // Upload files that passed validation
    for (const f of validFiles.filter((f) => f.status === 'uploading')) {
      const result = await uploadFile(f)
      currentFiles = currentFiles.map((cf) =>
        cf.uploadKey === f.uploadKey ? result : cf
      )
      onFilesChange([...currentFiles])
    }
  }, [files, maxFiles, onFilesChange, t, uploadFile])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (!disabled) setIsDragging(true)
  }, [disabled])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (disabled) return

    const droppedFiles = Array.from(e.dataTransfer.files)
    handleFiles(droppedFiles)
  }, [disabled, handleFiles])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files
    if (selectedFiles) {
      handleFiles(Array.from(selectedFiles))
    }
    // Reset input so the same file can be re-selected
    if (inputRef.current) inputRef.current.value = ''
  }, [handleFiles])

  const removeFile = useCallback((index: number) => {
    onFilesChange(files.filter((_, i) => i !== index))
  }, [files, onFilesChange])

  // Whole-surface drop. Native listeners on the surface element: a
  // dragenter/dragleave pair fires for every child crossed, so a depth
  // counter tells "left the surface" from "moved between its children". A
  // drop inside the dashed box is the box's own (React) handler's: skipped
  // here so one drop never uploads twice.
  useEffect(() => {
    const surface = dropSurfaceRef?.current
    if (!surface || disabled) return
    let depth = 0
    const reset = () => {
      depth = 0
      setSurfaceRect(null)
    }
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth += 1
      if (depth === 1) setSurfaceRect(surface.getBoundingClientRect())
    }
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      // Without this the browser refuses the drop (and would open the file).
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      // The drag may already be over the surface when these listeners
      // attach (a dialog that mounts this zone on its first dragenter):
      // then the enter was never seen, and the first over stands in for it.
      if (depth === 0) {
        depth = 1
        setSurfaceRect(surface.getBoundingClientRect())
      }
    }
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setSurfaceRect(null)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      reset()
      if (zoneRef.current && e.target instanceof Node && zoneRef.current.contains(e.target)) return
      handleFiles(Array.from(e.dataTransfer?.files ?? []))
    }
    surface.addEventListener('dragenter', onDragEnter)
    surface.addEventListener('dragover', onDragOver)
    surface.addEventListener('dragleave', onDragLeave)
    surface.addEventListener('drop', onDrop)
    // A drag that ends anywhere else (dropped on the desktop, escaped) never
    // sends the surface a dragleave: clear the outline on the global end.
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)
    return () => {
      surface.removeEventListener('dragenter', onDragEnter)
      surface.removeEventListener('dragover', onDragOver)
      surface.removeEventListener('dragleave', onDragLeave)
      surface.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('drop', reset)
    }
  }, [dropSurfaceRef, disabled, handleFiles])

  const isUploading = files.some((f) => f.status === 'uploading')

  return (
    <div className="min-w-0 space-y-2">
      {/* Surface outline: sits above the dialog (z-50) and a docked agent
          sheet (z-60), lets every event through to the surface beneath. */}
      {surfaceRect &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            aria-hidden="true"
            className="pointer-events-none fixed z-[70] flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/85"
            style={{ top: surfaceRect.top, left: surfaceRect.left, width: surfaceRect.width, height: surfaceRect.height }}
          >
            <div className="flex flex-col items-center gap-2 text-center">
              <Upload className="h-8 w-8 text-primary" />
              <p className="text-sm font-medium text-foreground">{t('drop_surface_prompt')}</p>
              <p className="text-xs text-muted-foreground">{t('format_hint')}</p>
            </div>
          </div>,
          document.body,
        )}
      {/* Drop zone */}
      <div
        ref={zoneRef}
        className={`
          relative border-2 border-dashed rounded-lg text-center transition-colors
          ${compact ? 'p-3' : 'p-6'}
          ${isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'}
          ${disabled ? 'pointer-events-none opacity-50' : 'cursor-pointer hover:border-primary/50'}
        `}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS}
          className="hidden"
          onChange={handleInputChange}
          disabled={disabled}
        />

        <div className={compact ? 'flex items-center justify-center gap-2' : 'space-y-2'}>
          <Upload className={compact ? 'h-4 w-4 text-muted-foreground' : 'mx-auto h-8 w-8 text-muted-foreground'} />
          <div>
            <p className={compact ? 'text-sm text-muted-foreground' : 'text-sm font-medium'}>
              {compact ? t('compact_prompt') : t('prompt')}
            </p>
            {!compact && (
              <p className="text-xs text-muted-foreground">
                {t('format_hint')}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="space-y-1">
          {files.map((file, index) => (
            <div
              key={file.uploadKey}
              className="flex min-w-0 items-center gap-2 text-sm py-1.5 px-2 rounded-sm bg-muted/50"
            >
              {isImageType(file.file.type) ? (
                <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0" />
              ) : (
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              <TruncatedFileName fileName={file.fileName} />
              <span className="text-xs text-muted-foreground shrink-0">
                {formatFileSize(file.fileSize)}
              </span>

              {file.status === 'uploading' && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
              )}
              {file.status === 'uploaded' && (
                <span className="text-xs text-muted-foreground shrink-0">
                  {t('uploaded')}
                </span>
              )}
              {file.status === 'error' && (
                <>
                  <Badge variant="destructive" className="text-xs px-1.5 py-0">
                    {t('error')}
                  </Badge>
                  {file.error && (
                    <span className="text-xs text-destructive">{file.error}</span>
                  )}
                </>
              )}

              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('remove_file')}
                className="shrink-0"
                onClick={(e) => {
                  e.stopPropagation()
                  removeFile(index)
                }}
                disabled={file.status === 'uploading'}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {isUploading && (
        <p className="text-xs text-muted-foreground">{t('uploading')}</p>
      )}
    </div>
  )
}

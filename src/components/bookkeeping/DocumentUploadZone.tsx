'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  ArrowUpTrayIcon,
  DocumentTextIcon,
  PhotoIcon,
  SpinnerIcon,
  XMarkIcon,
} from '@/components/icons'
import { postDocumentForm } from '@/lib/documents/direct-upload'
import { prepareDocumentUpload } from '@/lib/documents/shrink-image'
import { DOCUMENT_UPLOAD_ACCEPT, isAllowedDocumentFile } from '@/lib/documents/upload-types'
import { addUploads, finishUpload, removeUpload, type UploadedFilesUpdate } from './upload-list'

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
  /**
   * Every change (a drop, a finished upload, the x on a file) arrives as an
   * update of the host's latest list, never as a whole list: an upload
   * finishes after later changes, and a list built at its drop would undo
   * them (upload-list.ts). A useState setter can be passed as is.
   */
  onFilesChange: (update: UploadedFilesUpdate) => void
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
  /**
   * Called once for every file that finished uploading (it has its document
   * id by then), also when the host closed in the meantime: a booking dialog
   * pins it to its bank transaction right away.
   */
  onUploaded?: (file: UploadedFile) => void
  /**
   * Receives the zone's file input, so a host button can open the file
   * picker in its own click (one click to the OS picker) instead of only
   * revealing the zone and waiting for a second click inside it.
   */
  fileInputRef?: React.RefObject<HTMLInputElement | null>
  /**
   * More ways in, shown in the compact row after "Ladda upp" (e.g. "Välj
   * från Inkorgen"), so a dialog's Underlag reads as one line.
   */
  actions?: React.ReactNode
}

let uploadCounter = 0
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
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
  onUploaded,
  fileInputRef,
  actions,
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
    const prepared = await prepareDocumentUpload(file.file)
    if (!prepared.ok) {
      return { ...file, status: 'error', error: prepared.message }
    }
    const formData = new FormData()
    formData.append('upload_source', 'file_upload')
    if (journalEntryId) {
      formData.append('journal_entry_id', journalEntryId)
    }

    try {
      const res = await postDocumentForm('/api/documents', formData, prepared.file)

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
      // Same allowlist and type reading as POST /api/documents
      // (lib/documents/upload-types), so a file the picker offers is never
      // refused here and then accepted by the server, or the other way round.
      if (!isAllowedDocumentFile(file)) {
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

    onFilesChange(addUploads(validFiles))

    // Upload files that passed validation. Each result lands on the host's
    // list as it is by then, not on the one this drop started from.
    for (const f of validFiles.filter((f) => f.status === 'uploading')) {
      const result = await uploadFile(f)
      onFilesChange(finishUpload(result))
      if (result.status === 'uploaded' && result.id) onUploaded?.(result)
    }
  }, [files.length, maxFiles, onFilesChange, onUploaded, t, uploadFile])

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

  const removeFile = useCallback((uploadKey: string) => {
    onFilesChange(removeUpload(uploadKey))
  }, [onFilesChange])

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
              <ArrowUpTrayIcon className="h-8 w-8 text-primary" />
              <p className="text-sm font-medium text-foreground">{t('drop_surface_prompt')}</p>
              <p className="text-xs text-muted-foreground">{t('format_hint')}</p>
            </div>
          </div>,
          document.body,
        )}
      <input
        ref={(element) => {
          inputRef.current = element
          if (fileInputRef) fileInputRef.current = element
        }}
        type="file"
        multiple
        accept={DOCUMENT_UPLOAD_ACCEPT}
        className="hidden"
        onChange={handleInputChange}
        disabled={disabled}
      />
      {compact ? (
        // Compact (Stil v3, board Dlg-Bokfor): one line, not a dashed box:
        // "Ladda upp", the host's other ways in, and the drag hint. The row
        // still takes a dropped file, and so does dropSurfaceRef.
        <div
          ref={zoneRef}
          className={cn(
            'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md transition-shadow duration-150',
            isDragging && 'ring-[1.5px] ring-primary',
            disabled && 'pointer-events-none opacity-40',
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={disabled}>
            <ArrowUpTrayIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {t('upload_button')}
          </Button>
          {actions}
          <span className="text-xs text-muted-foreground">{t('drag_hint')}</span>
        </div>
      ) : (
        <div
          ref={zoneRef}
          className={`
            relative border-2 border-dashed rounded-lg text-center transition-colors p-6
            ${isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'}
            ${disabled ? 'pointer-events-none opacity-50' : 'cursor-pointer hover:border-primary/50'}
          `}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          <div className="space-y-2">
            <ArrowUpTrayIcon className="mx-auto h-8 w-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">{t('prompt')}</p>
              <p className="text-xs text-muted-foreground">{t('format_hint')}</p>
            </div>
          </div>
        </div>
      )}

      {/* File list */}
      {files.length > 0 && (
        <div className="space-y-1">
          {files.map((file) => (
            <div
              key={file.uploadKey}
              className="flex min-w-0 items-center gap-2 text-sm py-1.5 px-2 rounded-sm bg-muted/50"
            >
              {isImageType(file.file.type) ? (
                <PhotoIcon className="h-4 w-4 text-muted-foreground shrink-0" />
              ) : (
                <DocumentTextIcon className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              <TruncatedFileName fileName={file.fileName} />
              <span className="text-xs text-muted-foreground shrink-0">
                {formatFileSize(file.fileSize)}
              </span>

              {file.status === 'uploading' && (
                <SpinnerIcon className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
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
                size="icon"
                aria-label={t('remove_file')}
                className="shrink-0"
                onClick={(e) => {
                  e.stopPropagation()
                  removeFile(file.uploadKey)
                }}
                // A disabled zone takes no removal either: a booking dialog
                // locks it while it links what the list held when it began.
                disabled={disabled || file.status === 'uploading'}
              >
                <XMarkIcon className="h-3 w-3" />
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

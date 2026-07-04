'use client'

import { useState, useCallback, useRef } from 'react'
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
}

let uploadCounter = 0
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const ACCEPTED_EXTENSIONS = '.pdf,.jpg,.jpeg,.png,.webp'

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
function extractErrorMessage(err: unknown): string | null {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; message_en?: unknown; code?: unknown }
    if (typeof e.message === 'string' && e.message.length > 0) return e.message
    if (typeof e.message_en === 'string' && e.message_en.length > 0) return e.message_en
    if (typeof e.code === 'string') return e.code
  }
  return null
}

export default function DocumentUploadZone({
  files,
  onFilesChange,
  journalEntryId,
  maxFiles = 5,
  disabled = false,
  compact = false,
}: DocumentUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

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
          ? 'Din session har gått ut. Ladda om sidan och logga in igen.'
          : `Servern svarade ${res.status}.`
        return { ...file, status: 'error', error: reason }
      }

      if (!res.ok || result.error) {
        const errMessage = extractErrorMessage(result.error) || `Uppladdning misslyckades (${res.status})`
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
      return { ...file, status: 'error', error: 'Uppladdning misslyckades: nätverksfel' }
    }
  }, [journalEntryId])

  const handleFiles = useCallback(async (newFiles: File[]) => {
    const remaining = maxFiles - files.length
    if (remaining <= 0) return

    const validFiles: UploadedFile[] = []

    for (const file of newFiles.slice(0, remaining)) {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        validFiles.push({
          file,
          status: 'error',
          error: 'Filtypen stöds inte',
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
          error: 'Filen är för stor (max 10 MB)',
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
  }, [files, maxFiles, onFilesChange, uploadFile])

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

  const isUploading = files.some((f) => f.status === 'uploading')

  return (
    <div className="space-y-2">
      {/* Drop zone */}
      <div
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
              {compact ? 'Dra och släpp eller klicka' : 'Dra och släpp filer här'}
            </p>
            {!compact && (
              <p className="text-xs text-muted-foreground">
                PDF, bilder (max 10 MB)
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
              className="flex items-center gap-2 text-sm py-1.5 px-2 rounded bg-muted/50"
            >
              {isImageType(file.file.type) ? (
                <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0" />
              ) : (
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              <span className="truncate flex-1">{file.fileName}</span>
              <span className="text-xs text-muted-foreground shrink-0">
                {formatFileSize(file.fileSize)}
              </span>

              {file.status === 'uploading' && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
              )}
              {file.status === 'uploaded' && (
                <Badge variant="success" className="text-xs px-1.5 py-0">
                  Uppladdad
                </Badge>
              )}
              {file.status === 'error' && (
                <>
                  <Badge variant="destructive" className="text-xs px-1.5 py-0">
                    Fel
                  </Badge>
                  {file.error && (
                    <span className="text-xs text-destructive">{file.error}</span>
                  )}
                </>
              )}

              <Button
                variant="ghost"
                size="sm"
                aria-label="Ta bort fil"
                className="h-6 w-6 p-0 shrink-0"
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
        <p className="text-xs text-muted-foreground">Laddar upp...</p>
      )}
    </div>
  )
}

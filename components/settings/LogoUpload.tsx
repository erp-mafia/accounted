'use client'

import { useState, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Upload, Trash2 } from 'lucide-react'
import {
  SettingsGroup,
  SettingsRow,
} from '@/components/settings/SettingsRows'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { LOGO_UPLOAD_MAX_BYTES } from '@/lib/invoices/branding-constants'

interface LogoUploadProps {
  logoUrl: string | null
  onUpdate: (logoUrl: string | null) => void
}

export function LogoUpload({ logoUrl, onUpdate }: LogoUploadProps) {
  const t = useTranslations('settings_company')
  const { toast } = useToast()
  const [isUploading, setIsUploading] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [preview, setPreview] = useState<string | null>(logoUrl)
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp']

  function validateAndUpload(file: File) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast({ title: t('logo_disallowed_type_title'), description: t('logo_disallowed_type_description'), variant: 'destructive' })
      return
    }
    if (file.size > LOGO_UPLOAD_MAX_BYTES) {
      toast({ title: t('logo_too_large'), variant: 'destructive' })
      return
    }
    handleUpload(file)
  }

  async function handleUpload(file: File) {
    setIsUploading(true)

    const formData = new FormData()
    formData.append('file', file)

    try {
      const response = await fetch('/api/settings/logo', {
        method: 'POST',
        body: formData,
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || t('logo_upload_failed_default'))
      }

      setPreview(result.data.logo_url)
      onUpdate(result.data.logo_url)
    } catch (error) {
      toast({
        title: t('logo_upload_failed_title'),
        description: error instanceof Error ? getUserErrorMessage(error) : t('logo_try_again'),
        variant: 'destructive',
      })
    }

    setIsUploading(false)
  }

  async function handleDelete() {
    setIsDeleting(true)

    try {
      const response = await fetch('/api/settings/logo', { method: 'DELETE' })
      if (!response.ok) throw new Error()

      setPreview(null)
      onUpdate(null)
      if (inputRef.current) inputRef.current.value = ''
    } catch {
      toast({ title: t('logo_delete_failed'), variant: 'destructive' })
    }

    setIsDeleting(false)
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    validateAndUpload(file)
  }

  function handleDrop(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) validateAndUpload(file)
  }

  function handleDragOver(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault()
    setIsDragging(false)
  }

  return (
    <SettingsGroup>
      <SettingsRow label={t('logo_heading')} help={t('logo_help')}>
        {preview ? (
          <>
            <span className="inline-flex rounded-lg border border-border bg-muted/30 p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={preview}
                alt={t('logo_alt')}
                className="max-h-10 max-w-32 object-contain"
              />
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={isUploading}
              className="text-muted-foreground hover:text-foreground"
            >
              {isUploading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              {t('logo_change')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDelete}
              disabled={isDeleting}
              className="text-muted-foreground hover:text-destructive"
            >
              {isDeleting ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-2 h-3.5 w-3.5" />}
              {t('logo_remove')}
            </Button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragEnter={handleDragOver}
            onDragLeave={handleDragLeave}
            disabled={isUploading}
            className={`inline-flex min-h-10 items-center gap-2 rounded-lg border border-dashed px-4 py-2 text-sm text-muted-foreground transition-colors duration-150 disabled:opacity-50 ${
              isDragging ? 'border-foreground bg-muted/40' : 'border-border hover:bg-muted/20'
            }`}
          >
            {isUploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 text-muted-foreground/60" />
            )}
            {isUploading ? t('logo_uploading') : t('logo_pick_or_drop')}
          </button>
        )}
      </SettingsRow>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={handleFileChange}
      />
    </SettingsGroup>
  )
}

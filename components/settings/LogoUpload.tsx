'use client'

import { useState, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Upload, Trash2 } from 'lucide-react'

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

  const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']

  function validateAndUpload(file: File) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast({ title: t('logo_disallowed_type_title'), description: t('logo_disallowed_type_description'), variant: 'destructive' })
      return
    }
    if (file.size > 2 * 1024 * 1024) {
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
        description: error instanceof Error ? error.message : t('logo_try_again'),
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
    <section className="space-y-4">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        {t('logo_heading')}
      </h2>
      <p className="text-xs text-muted-foreground -mt-2">
        {t('logo_help')}
      </p>

      {preview ? (
        <div className="space-y-3">
          <div className="inline-block rounded-lg border border-border bg-muted/30 p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preview}
              alt={t('logo_alt')}
              className="max-h-16 max-w-[200px] object-contain"
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={isUploading}
            >
              {isUploading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-2 h-3.5 w-3.5" />}
              {t('logo_change')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              disabled={isDeleting}
              className="text-muted-foreground hover:text-destructive"
            >
              {isDeleting ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-2 h-3.5 w-3.5" />}
              {t('logo_remove')}
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          disabled={isUploading}
          className={`flex flex-col items-center justify-center w-full max-w-xs rounded-lg border-2 border-dashed py-8 px-4 text-center transition-colors disabled:opacity-50 ${
            isDragging ? 'border-foreground bg-muted/40' : 'border-border hover:border-border hover:bg-muted/20'
          }`}
        >
          {isUploading ? (
            <Loader2 className="h-6 w-6 text-muted-foreground animate-spin mb-2" />
          ) : (
            <Upload className="h-6 w-6 text-muted-foreground/50 mb-2" />
          )}
          <Label className="text-sm text-muted-foreground cursor-pointer">
            {isUploading ? t('logo_uploading') : t('logo_pick_or_drop')}
          </Label>
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,image/webp"
        className="hidden"
        onChange={handleFileChange}
      />
    </section>
  )
}

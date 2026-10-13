'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { FileDropzone } from '@/components/ui/file-dropzone'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Upload, Trash2 } from 'lucide-react'
import {
  SettingsGroup,
  SettingsRow,
} from '@/components/settings/SettingsRows'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { LOGO_UPLOAD_MAX_BYTES } from '@/lib/invoices/branding-constants'

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const LOGO_ACCEPT = LOGO_TYPES.join(',')

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


  function validateAndUpload(file: File) {
    if (!LOGO_TYPES.includes(file.type)) {
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
    } catch {
      toast({ title: t('logo_delete_failed'), variant: 'destructive' })
    }

    setIsDeleting(false)
  }

  return (
    <SettingsGroup>
      <SettingsRow label={t('logo_heading')} help={t('logo_help')}>
        {preview ? (
          <>
            {/* The logo itself is the change control: click it, or drop a new one on it. */}
            <FileDropzone
              onFile={validateAndUpload}
              accept={LOGO_ACCEPT}
              disabled={isUploading}
              label={t('logo_change')}
              className="inline-flex items-center gap-2 border p-2 text-sm text-muted-foreground"
            >
              <span className="inline-flex rounded-sm bg-muted/30">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={preview}
                  alt={t('logo_alt')}
                  className="max-h-10 max-w-32 object-contain"
                />
              </span>
              {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <span className="px-1">{t('logo_change')}</span>}
            </FileDropzone>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDelete}
              loading={isDeleting}
              className="text-muted-foreground hover:text-destructive"
            >
              {!isDeleting && <Trash2 className="mr-2 h-3.5 w-3.5" />}
              {t('logo_remove')}
            </Button>
          </>
        ) : (
          <FileDropzone
            onFile={validateAndUpload}
            accept={LOGO_ACCEPT}
            disabled={isUploading}
            label={t('logo_pick_or_drop')}
            className="inline-flex min-h-10 items-center gap-2 border px-4 py-2 text-sm text-muted-foreground"
          >
            {isUploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 text-muted-foreground/60" />
            )}
            {isUploading ? t('logo_uploading') : t('logo_pick_or_drop')}
          </FileDropzone>
        )}
      </SettingsRow>
    </SettingsGroup>
  )
}

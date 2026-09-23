'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2, Palette, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/use-toast'
import { SettingsGroup, SettingsInput, SettingsRow } from '@/components/settings/SettingsRows'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { LOGO_UPLOAD_MAX_BYTES } from '@/lib/invoices/branding-constants'

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp']

interface ByraBrand {
  hasBrand: boolean
  domain: string | null
  appName: string | null
  logoUrl: string | null
  canEdit: boolean
}

/**
 * Byrå settings: Varumärke (WL-17). Byråer edit the logo and the app name
 * themselves; domain and colors render read-only (ops-managed, the
 * white-glove decision). Upload interaction mirrors the company invoice
 * logo (components/settings/LogoUpload.tsx) against the byrå brand route.
 * The logo saves on upload; the app name has an inline save that appears
 * when the field is dirty (SettingsFormWrapper is wired to /api/settings,
 * so this single team-scoped field saves itself).
 */
export function BrandSettingsContent() {
  const t = useTranslations('settings_brand')
  const { toast } = useToast()
  const [brand, setBrand] = useState<ByraBrand | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [appNameDraft, setAppNameDraft] = useState('')
  const [isSavingName, setIsSavingName] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/byra/brand')
      .then(async (res) => {
        if (!res.ok) throw new Error()
        const body = (await res.json()) as { data: ByraBrand }
        if (!cancelled) {
          setBrand(body.data)
          setAppNameDraft(body.data.appName ?? '')
        }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const appNameDirty =
    !!brand?.hasBrand &&
    brand.canEdit &&
    appNameDraft.trim().length > 0 &&
    appNameDraft.trim() !== brand.appName

  async function handleSaveAppName() {
    if (!appNameDirty || isSavingName) return
    setIsSavingName(true)
    try {
      const response = await fetch('/api/byra/brand', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appName: appNameDraft.trim() }),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(result.error || t('app_name_save_failed'))
      }
      setBrand((prev) => (prev ? { ...prev, appName: result.data.app_name } : prev))
      setAppNameDraft(result.data.app_name)
    } catch (error) {
      toast({
        title: t('app_name_save_failed'),
        description: error instanceof Error ? getUserErrorMessage(error) : undefined,
        variant: 'destructive',
      })
    }
    setIsSavingName(false)
  }

  function validateAndUpload(file: File) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast({ title: t('logo_disallowed_type'), variant: 'destructive' })
      return
    }
    if (file.size > LOGO_UPLOAD_MAX_BYTES) {
      toast({ title: t('logo_too_large'), variant: 'destructive' })
      return
    }
    void handleUpload(file)
  }

  async function handleUpload(file: File) {
    setIsUploading(true)
    const formData = new FormData()
    formData.append('file', file)
    try {
      const response = await fetch('/api/byra/brand/logo', { method: 'POST', body: formData })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(result.error || t('logo_upload_failed'))
      }
      setBrand((prev) => (prev ? { ...prev, logoUrl: result.data.logo_url } : prev))
    } catch (error) {
      toast({
        title: t('logo_upload_failed'),
        description: error instanceof Error ? getUserErrorMessage(error) : undefined,
        variant: 'destructive',
      })
    }
    setIsUploading(false)
  }

  async function handleDelete() {
    setIsDeleting(true)
    try {
      const response = await fetch('/api/byra/brand/logo', { method: 'DELETE' })
      if (!response.ok) throw new Error()
      setBrand((prev) => (prev ? { ...prev, logoUrl: null } : prev))
      if (inputRef.current) inputRef.current.value = ''
    } catch {
      toast({ title: t('logo_delete_failed'), variant: 'destructive' })
    }
    setIsDeleting(false)
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

  if (loadFailed) {
    return <p className="text-sm text-muted-foreground">{t('load_failed')}</p>
  }
  if (!brand) {
    return <SettingsLoadingSkeleton />
  }
  if (!brand.hasBrand) {
    return (
      <EmptyState
        icon={Palette}
        title={t('empty_title')}
        description={t('empty_description')}
      />
    )
  }

  return (
    <SettingsGroup>
      <SettingsRow label={t('logo_label')} help={t('logo_help')}>
        {brand.logoUrl ? (
          <>
            <span className="inline-flex rounded-lg border border-border bg-muted/30 p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={brand.logoUrl}
                alt={t('logo_alt')}
                className="max-h-10 max-w-32 object-contain"
              />
            </span>
            {brand.canEdit && (
              <>
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
                  {isDeleting ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                  )}
                  {t('logo_remove')}
                </Button>
              </>
            )}
          </>
        ) : brand.canEdit ? (
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
        ) : (
          <span className="text-sm text-muted-foreground">{t('logo_none')}</span>
        )}
      </SettingsRow>

      <SettingsRow label={t('domain_label')} help={t('domain_help')}>
        <span className="text-sm tabular-nums">{brand.domain}</span>
      </SettingsRow>

      <SettingsRow label={t('app_name_label')} help={t('app_name_help')} htmlFor="byra-app-name">
        {brand.canEdit ? (
          <>
            <SettingsInput
              id="byra-app-name"
              value={appNameDraft}
              maxLength={60}
              onChange={(e) => setAppNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleSaveAppName()
                }
              }}
            />
            {appNameDirty && (
              <Button size="sm" onClick={handleSaveAppName} disabled={isSavingName}>
                {isSavingName ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                {t('app_name_save')}
              </Button>
            )}
          </>
        ) : (
          <span className="text-sm">{brand.appName}</span>
        )}
      </SettingsRow>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) validateAndUpload(file)
        }}
      />
    </SettingsGroup>
  )
}

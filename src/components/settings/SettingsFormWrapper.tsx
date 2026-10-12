'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Check, Lock } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useSaveSettings } from '@/components/settings/use-save-settings'
import type { CompanySettings } from '@/types'
import { cn } from '@/lib/utils'

type SaveResult =
  | Record<string, unknown>
  | { updates: Record<string, unknown>; onSuccess?: (data: Record<string, unknown>) => void }

interface SettingsFormWrapperProps {
  children: React.ReactNode
  onSave?: (formData: FormData) => SaveResult
  className?: string
}

/**
 * Form shell for settings sections saving to PUT /api/settings. The save
 * affordance is a sticky bar that fades in only when the form is dirty
 * (Fönster concept): a quiet page until you actually change something.
 */
export function SettingsFormWrapper({ children, onSave, className }: SettingsFormWrapperProps) {
  const t = useTranslations('settings_company')
  const saveSettings = useSaveSettings()
  const { canWrite } = useCanWrite()
  const [isSaving, setIsSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleSubmit = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!onSave) return

    const formData = new FormData(e.currentTarget)
    const saveResult = onSave(formData)

    // Support both plain object and { updates, onSuccess } return types
    const isStructured = saveResult && 'updates' in saveResult && typeof saveResult.updates === 'object'
    const updates = isStructured ? saveResult.updates : saveResult
    const onSuccess = isStructured ? (saveResult as { onSuccess?: (data: Record<string, unknown>) => void }).onSuccess : undefined

    if (!updates || Object.keys(updates).length === 0) return

    setIsSaving(true)
    setSaved(false)

    const result = await saveSettings(updates as Partial<CompanySettings>, { failedTitle: t('wrapper_save_failed_title') })
    if (result) {
      onSuccess?.((result.data as Record<string, unknown> | undefined) ?? (updates as Record<string, unknown>))
      setDirty(false)
      setSaved(true)
      timerRef.current = setTimeout(() => setSaved(false), 2000)
    }

    setIsSaving(false)
  }, [onSave, saveSettings, t])

  const barVisible = dirty || isSaving || saved

  return (
    <form
      onSubmit={handleSubmit}
      onInput={() => setDirty(true)}
      // Radix Switch renders a button, so toggling it fires no form input
      // event; catch those clicks too or switch-only changes never reveal
      // the save bar.
      onClickCapture={(e) => {
        const el = e.target as HTMLElement
        if (el.closest('[role="switch"]:not([disabled])')) setDirty(true)
      }}
      className={className}
    >
      {children}

      {/* Sticky save bar: invisible until the form is dirty. The gradient
          lets rows scroll away underneath without a hard edge. */}
      <div
        className={cn(
          'sticky bottom-0 flex items-center gap-4 bg-gradient-to-t from-background via-background/95 to-transparent px-1 transition-opacity duration-150',
          barVisible
            ? 'mt-2 pb-3 pt-6 opacity-100'
            : 'pointer-events-none h-0 overflow-hidden py-0 opacity-0',
        )}
        aria-hidden={!barVisible}
      >
        <Button
          type="submit"
          disabled={!canWrite}
          loading={isSaving}
          size="sm"
          tabIndex={barVisible ? 0 : -1}
          title={!canWrite ? t('wrapper_readonly_tooltip') : undefined}
        >
          {isSaving ? (
            t('wrapper_saving')
          ) : !canWrite ? (
            <>
              <Lock className="mr-2 h-3.5 w-3.5" />
              {t('wrapper_save_changes')}
            </>
          ) : (
            t('wrapper_save_changes')
          )}
        </Button>
        {saved ? (
          <span className="flex items-center gap-2 text-sm text-muted-foreground animate-in fade-in duration-150">
            <Check className="h-3.5 w-3.5" />
            {t('wrapper_saved')}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{t('wrapper_unsaved')}</span>
        )}
      </div>
    </form>
  )
}

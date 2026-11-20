'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { CheckIcon, LockClosedIcon } from '@/components/icons'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useSaveSettings, type SaveSettingsOptions } from '@/components/settings/use-save-settings'
import { SettingsViewerScope } from '@/components/settings/SettingsRows'
import type { CompanySettings } from '@/types'
import { cn } from '@/lib/utils'

type SaveResult =
  | Record<string, unknown>
  | { updates: Record<string, unknown>; onSuccess?: (data: Record<string, unknown>) => void }

interface SettingsFormWrapperProps {
  children: React.ReactNode
  onSave?: (formData: FormData) => SaveResult
  /** Asked before this form's save reopens filed momsperioder (see SaveSettingsOptions). */
  confirmReopeningFiledVat?: SaveSettingsOptions['confirmReopeningFiledVat']
  className?: string
}

/**
 * Form shell for settings sections saving to PUT /api/settings. The save
 * affordance is a sticky bar that fades in only when the form is dirty
 * (Fönster concept): a quiet page until you actually change something.
 */
export function SettingsFormWrapper({ children, onSave, confirmReopeningFiledVat, className }: SettingsFormWrapperProps) {
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

    const result = await saveSettings(updates as Partial<CompanySettings>, {
      failedTitle: t('wrapper_save_failed_title'),
      confirmReopeningFiledVat,
    })
    if (result) {
      onSuccess?.((result.data as Record<string, unknown> | undefined) ?? (updates as Record<string, unknown>))
      setDirty(false)
      setSaved(true)
      timerRef.current = setTimeout(() => setSaved(false), 2000)
    }

    setIsSaving(false)
  }, [onSave, confirmReopeningFiledVat, saveSettings, t])

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
      {/* Saves company settings: a read-only member's rows are locked. */}
      <SettingsViewerScope>{children}</SettingsViewerScope>

      <SettingsSaveBar visible={barVisible} saving={isSaving} saved={saved} canWrite={canWrite} />
    </form>
  )
}

interface SettingsSaveBarProps {
  visible: boolean
  saving: boolean
  saved: boolean
  /** False for a read-only member: the button locks with a tooltip. */
  canWrite?: boolean
  /** Extra reasons the save cannot run yet (an invalid field). */
  disabled?: boolean
  /**
   * Outside a <form>: what the button runs. Without it the button submits
   * the form it sits in (SettingsFormWrapper).
   */
  onSave?: () => void
  /** A quiet secondary action beside the save button (e.g. "Återställ"). */
  secondary?: React.ReactNode
}

/**
 * The Fönster save bar: sticky at the bottom of its container and invisible
 * until something changed. SettingsFormWrapper renders it for the forms
 * that save to /api/settings; a section that saves elsewhere (the first
 * fiscal year) renders it directly with `onSave`.
 */
export function SettingsSaveBar({
  visible,
  saving,
  saved,
  canWrite = true,
  disabled = false,
  onSave,
  secondary,
}: SettingsSaveBarProps) {
  const t = useTranslations('settings_company')
  return (
    // The gradient lets rows scroll away underneath without a hard edge.
    <div
      className={cn(
        'sticky bottom-[var(--bottom-nav-h)] flex items-center gap-4 bg-gradient-to-t from-background via-background/95 to-transparent px-1 transition-opacity duration-150',
        visible
          ? 'mt-2 pb-3 pt-6 opacity-100'
          : 'pointer-events-none h-0 overflow-hidden py-0 opacity-0',
      )}
      aria-hidden={!visible}
    >
      <Button
        type={onSave ? 'button' : 'submit'}
        onClick={onSave}
        disabled={!canWrite || disabled}
        loading={saving}
        tabIndex={visible ? 0 : -1}
        title={!canWrite ? t('wrapper_readonly_tooltip') : undefined}
      >
        {saving ? (
          t('wrapper_saving')
        ) : !canWrite ? (
          <>
            <LockClosedIcon className="h-3.5 w-3.5" />
            {t('wrapper_save_changes')}
          </>
        ) : (
          t('wrapper_save_changes')
        )}
      </Button>
      {secondary}
      {saved ? (
        <span className="flex items-center gap-2 text-sm text-muted-foreground animate-in fade-in duration-150">
          <CheckIcon className="h-3.5 w-3.5" />
          {t('wrapper_saved')}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">{t('wrapper_unsaved')}</span>
      )}
    </div>
  )
}

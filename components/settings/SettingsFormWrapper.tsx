'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Loader2, Check, Lock } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'

type SaveResult =
  | Record<string, unknown>
  | { updates: Record<string, unknown>; onSuccess?: (data: Record<string, unknown>) => void }

interface SettingsFormWrapperProps {
  children: React.ReactNode
  onSave?: (formData: FormData) => SaveResult
  className?: string
}

export function SettingsFormWrapper({ children, onSave, className }: SettingsFormWrapperProps) {
  const t = useTranslations('settings_company')
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const [isSaving, setIsSaving] = useState(false)
  const [saved, setSaved] = useState(false)
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

    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })

      const result = await response.json()

      if (!response.ok) {
        // Surface the specific Zod field message when the API sent a
        // validation_error envelope: generic "Validation failed" is useless
        // to the user.
        if (
          result?.type === 'validation_error'
          && Array.isArray(result.errors)
          && result.errors.length > 0
        ) {
          const messages = result.errors
            .map((e: { message?: string }) => e.message)
            .filter((m: unknown): m is string => typeof m === 'string' && m.length > 0)
          if (messages.length > 0) {
            throw new Error(messages.join(' • '))
          }
        }
        throw new Error(result.error || t('wrapper_save_failed_default'))
      }

      onSuccess?.(result.data ?? updates)
      setSaved(true)
      timerRef.current = setTimeout(() => setSaved(false), 2000)
    } catch (error) {
      toast({
        title: t('wrapper_save_failed_title'),
        description: error instanceof Error ? error.message : t('wrapper_try_again'),
        variant: 'destructive',
      })
    }

    setIsSaving(false)
  }, [onSave, toast, t])

  return (
    <form onSubmit={handleSubmit} className={className}>
      {children}

      <div className="flex items-center justify-end gap-3 mt-8">
        {saved && (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground animate-in fade-in duration-200">
            <Check className="h-3.5 w-3.5" />
            {t('wrapper_saved')}
          </span>
        )}
        <Button
          type="submit"
          disabled={isSaving || !canWrite}
          size="sm"
          title={!canWrite ? t('wrapper_readonly_tooltip') : undefined}
        >
          {isSaving ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              {t('wrapper_saving')}
            </>
          ) : !canWrite ? (
            <>
              <Lock className="mr-2 h-3.5 w-3.5" />
              {t('wrapper_save_changes')}
            </>
          ) : (
            t('wrapper_save_changes')
          )}
        </Button>
      </div>
    </form>
  )
}

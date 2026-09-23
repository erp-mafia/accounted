'use client'

import { useTranslations } from 'next-intl'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Shown when a settings section's fetch settled without a row (or errored).
 * Replaces the old behaviour where a null `settings` object left the loading
 * skeleton on screen indefinitely: a settled fetch always resolves to either
 * content or this retryable state.
 */
export function SettingsLoadError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('common')
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
      <AlertCircle className="h-8 w-8 text-muted-foreground" aria-hidden />
      <p className="text-sm text-muted-foreground">{t('load_error')}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  )
}

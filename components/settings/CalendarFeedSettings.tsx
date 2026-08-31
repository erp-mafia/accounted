'use client'

import { useLocale, useTranslations } from 'next-intl'
import { formatDateLong } from '@/lib/utils'
import { useState, useEffect } from 'react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { Calendar, Copy, RefreshCw, Loader2, Check } from 'lucide-react'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'
import type { CalendarFeed } from '@/types'

interface CalendarFeedWithUrls extends CalendarFeed {
  webcalUrl: string
  httpsUrl: string
}

export function CalendarFeedSettings() {
  const t = useTranslations('settings_calendar_feed')
  const locale = useLocale()
  const { toast } = useToast()

  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isRegenerating, setIsRegenerating] = useState(false)
  const [feed, setFeed] = useState<CalendarFeedWithUrls | null>(null)
  const [copied, setCopied] = useState(false)
  const { dialogProps: confirmDialogProps, confirm: confirmAction } = useDestructiveConfirm()

  useEffect(() => {
    fetchFeed()
  }, [])

  const fetchFeed = async () => {
    setIsLoading(true)

    const response = await fetch('/api/calendar/feed')
    const { data } = await response.json()

    setFeed(data)
    setIsLoading(false)
  }

  const createFeed = async () => {
    setIsSaving(true)

    try {
      const response = await fetch('/api/calendar/feed', {
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error('Failed to create feed')
      }

      const { data } = await response.json()
      setFeed(data)

      toast({
        title: t('toast_feed_created_title'),
        description: t('toast_feed_created_description'),
      })
    } catch {
      toast({
        title: t('toast_create_failed'),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  const updateFeed = async (key: keyof CalendarFeed, value: boolean) => {
    if (!feed) return

    setIsSaving(true)

    try {
      const response = await fetch('/api/calendar/feed', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      })

      if (!response.ok) {
        throw new Error('Failed to update feed')
      }

      const { data } = await response.json()
      setFeed(data)
    } catch {
      toast({
        title: t('toast_update_failed'),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  const regenerateToken = async () => {
    const ok = await confirmAction({
      title: t('regen_dialog_title'),
      description: t('regen_dialog_description'),
      confirmLabel: t('regen_confirm'),
      variant: 'warning',
    })
    if (!ok) return

    setIsRegenerating(true)

    try {
      const response = await fetch('/api/calendar/feed', {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error('Failed to regenerate token')
      }

      const { data } = await response.json()
      setFeed(data)

      toast({
        title: t('toast_new_link_title'),
        description: t('toast_new_link_description'),
      })
    } catch {
      toast({
        title: t('toast_regen_failed'),
        variant: 'destructive',
      })
    } finally {
      setIsRegenerating(false)
    }
  }

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast({
        title: t('toast_copied_title'),
        description: t('toast_copied_description'),
      })
    } catch {
      toast({
        title: t('toast_copy_failed'),
        variant: 'destructive',
      })
    }
  }

  const openWebcal = () => {
    if (feed?.webcalUrl) {
      window.location.href = feed.webcalUrl
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!feed) {
    return (
      <SettingsGroup label={t('title')} help={t('description')}>
        <SettingsRow label={t('activate_sync')} help={t('empty_intro')}>
          <SettingsRowEnd>
            <Button variant="outline" size="sm" onClick={createFeed} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  {t('creating')}
                </>
              ) : (
                <>
                  <Calendar className="mr-2 h-3.5 w-3.5" />
                  {t('activate_sync')}
                </>
              )}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
      </SettingsGroup>
    )
  }

  return (
    <>
      {/* Feed URL */}
      <SettingsGroup label={t('title')} help={t('subscribe_description')}>
        <SettingsRow
          label={t('calendar_link_label')}
          htmlFor="calendar-feed-url"
          help={t('calendar_link_help')}
          align="baseline"
        >
          <SettingsInput
            id="calendar-feed-url"
            value={feed.httpsUrl}
            readOnly
            className="font-mono text-xs"
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => copyToClipboard(feed.httpsUrl)}
            aria-label={t('calendar_link_help')}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
          <SettingsRowEnd>
            <Button variant="outline" size="sm" onClick={openWebcal}>
              <Calendar className="mr-2 h-3.5 w-3.5" />
              {t('add_to_apple_calendar')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>

        <p className="px-1 pt-2 text-xs text-muted-foreground">
          {t('google_reminders_note')}
        </p>

        <SettingsRow label={t('create_new_link')} help={t('regen_help')}>
          {/* Live feed stats stay visible: they are state, not instructions */}
          {feed.last_accessed_at && (
            <SettingsRowNote className="tabular-nums">
              {t('last_fetched')}{' '}
              {formatDateLong(feed.last_accessed_at, locale)}
              {' · '}
              {t('times_count', { count: feed.access_count })}
            </SettingsRowNote>
          )}
          <SettingsRowEnd>
            <Button
              variant="outline"
              size="sm"
              onClick={regenerateToken}
              disabled={isRegenerating}
            >
              {isRegenerating ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  {t('creating_new_link')}
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  {t('create_new_link')}
                </>
              )}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
      </SettingsGroup>

      {/* Content settings */}
      <SettingsGroup label={t('content_title')} help={t('content_description')}>
        <SettingsRow
          label={t('tax_deadlines_label')}
          htmlFor="include-tax"
          help={t('tax_deadlines_help')}
        >
          <Switch
            id="include-tax"
            checked={feed.include_tax_deadlines}
            onCheckedChange={(checked) =>
              updateFeed('include_tax_deadlines', checked)
            }
            disabled={isSaving}
          />
        </SettingsRow>

        <SettingsRow
          label={t('invoices_label')}
          htmlFor="include-invoices"
          help={t('invoices_help')}
        >
          <Switch
            id="include-invoices"
            checked={feed.include_invoices}
            onCheckedChange={(checked) =>
              updateFeed('include_invoices', checked)
            }
            disabled={isSaving}
          />
        </SettingsRow>
      </SettingsGroup>

      <DestructiveConfirmDialog {...confirmDialogProps} />
    </>
  )
}

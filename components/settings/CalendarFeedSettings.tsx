'use client'

import { useTranslations } from 'next-intl'
import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { Calendar, Copy, RefreshCw, Loader2, ExternalLink, Check } from 'lucide-react'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import type { CalendarFeed } from '@/types'

interface CalendarFeedWithUrls extends CalendarFeed {
  webcalUrl: string
  httpsUrl: string
}

export function CalendarFeedSettings() {
  const t = useTranslations('settings_calendar_feed')
  const { toast } = useToast()

  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isRegenerating, setIsRegenerating] = useState(false)
  const [feed, setFeed] = useState<CalendarFeedWithUrls | null>(null)
  const [copied, setCopied] = useState(false)
  const { dialogProps: confirmDialogProps, confirm: confirmAction } = useDestructiveConfirm()

  useEffect(() => {
    fetchFeed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      <div className="flex items-center justify-center h-32">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!feed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            {t('title')}
          </CardTitle>
          <CardDescription>
            {t('description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center space-y-4 py-4">
            <p className="text-muted-foreground">
              {t('empty_intro')}
            </p>
            <Button onClick={createFeed} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('creating')}
                </>
              ) : (
                <>
                  <Calendar className="mr-2 h-4 w-4" />
                  {t('activate_sync')}
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {/* Feed URL */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            {t('title')}
          </CardTitle>
          <CardDescription>
            {t('subscribe_description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Quick add for Apple Calendar */}
          <div className="flex gap-2">
            <Button onClick={openWebcal} className="flex-1">
              <Calendar className="mr-2 h-4 w-4" />
              {t('add_to_apple_calendar')}
            </Button>
            <Button variant="outline" onClick={() => copyToClipboard(feed.httpsUrl)}>
              {copied ? (
                <Check className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>

          {/* URL display */}
          <div className="space-y-2">
            <Label>{t('calendar_link_label')}</Label>
            <div className="flex gap-2">
              <Input
                value={feed.httpsUrl}
                readOnly
                className="font-mono text-xs"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('calendar_link_help')}
            </p>
          </div>

          {/* Stats */}
          {feed.last_accessed_at && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>{t('last_fetched')}</span>
              <span>
                {new Date(feed.last_accessed_at).toLocaleDateString('sv-SE', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <span className="text-muted-foreground/30">·</span>
              <span className="tabular-nums">
                {t('times_count', { count: feed.access_count })}
              </span>
            </div>
          )}

          {/* Regenerate link */}
          <div className="pt-2 border-t">
            <Button
              variant="outline"
              size="sm"
              onClick={regenerateToken}
              disabled={isRegenerating}
            >
              {isRegenerating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('creating_new_link')}
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t('create_new_link')}
                </>
              )}
            </Button>
            <p className="text-xs text-muted-foreground mt-1">
              {t('regen_help')}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Content settings */}
      <Card>
        <CardHeader>
          <CardTitle>{t('content_title')}</CardTitle>
          <CardDescription>
            {t('content_description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="include-tax">{t('tax_deadlines_label')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('tax_deadlines_help')}
              </p>
            </div>
            <Switch
              id="include-tax"
              checked={feed.include_tax_deadlines}
              onCheckedChange={(checked) =>
                updateFeed('include_tax_deadlines', checked)
              }
              disabled={isSaving}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="include-invoices">{t('invoices_label')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('invoices_help')}
              </p>
            </div>
            <Switch
              id="include-invoices"
              checked={feed.include_invoices}
              onCheckedChange={(checked) =>
                updateFeed('include_invoices', checked)
              }
              disabled={isSaving}
            />
          </div>

        </CardContent>
      </Card>

      <DestructiveConfirmDialog {...confirmDialogProps} />
    </div>
  )
}

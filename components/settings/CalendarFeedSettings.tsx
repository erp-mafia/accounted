'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { Badge } from '@/components/ui/badge'
import { Calendar, Copy, RefreshCw, Loader2, ExternalLink, Check } from 'lucide-react'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import type { CalendarFeed } from '@/types'

interface CalendarFeedWithUrls extends CalendarFeed {
  webcalUrl: string
  httpsUrl: string
}

export function CalendarFeedSettings() {
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
        title: 'Kalenderfeed skapad',
        description: 'Du kan nu koppla kalendern till Apple Calendar eller Google Calendar.',
      })
    } catch (error) {
      toast({
        title: 'Fel',
        description: 'Kunde inte skapa kalenderfeed.',
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
    } catch (error) {
      toast({
        title: 'Fel',
        description: 'Kunde inte uppdatera inställning.',
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  const regenerateToken = async () => {
    const ok = await confirmAction({
      title: 'Skapa ny kalender-länk',
      description: 'Den gamla länken slutar fungera omedelbart. Du behöver uppdatera länken i alla kalenderappar som använder den.',
      confirmLabel: 'Skapa ny länk',
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
        title: 'Ny länk skapad',
        description: 'Den gamla länken fungerar inte längre.',
      })
    } catch (error) {
      toast({
        title: 'Fel',
        description: 'Kunde inte skapa ny länk.',
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
        title: 'Kopierad',
        description: 'Länken har kopierats till urklipp.',
      })
    } catch (error) {
      toast({
        title: 'Fel',
        description: 'Kunde inte kopiera länken.',
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
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <div className="h-5 w-5 bg-muted rounded animate-pulse" />
            <div className="h-5 bg-muted rounded w-48 animate-pulse" />
          </div>
          <div className="h-4 bg-muted rounded w-72 mt-1 animate-pulse" />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <div className="h-10 bg-muted rounded flex-1 animate-pulse" />
            <div className="h-10 w-10 bg-muted rounded animate-pulse" />
          </div>
          <div className="space-y-2">
            <div className="h-4 bg-muted rounded w-56 animate-pulse" />
            <div className="h-10 bg-muted rounded animate-pulse" />
            <div className="h-3 bg-muted rounded w-64 animate-pulse" />
          </div>
          <div className="pt-2 border-t">
            <div className="h-8 bg-muted rounded w-32 animate-pulse" />
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!feed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Kalendersynkronisering
          </CardTitle>
          <CardDescription>
            Synka dina deadlines med Apple Calendar, Google Calendar eller Outlook
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center space-y-4 py-4">
            <p className="text-muted-foreground">
              Skapa en kalenderfeed för att se dina deadlines i din vanliga kalenderapp.
            </p>
            <Button onClick={createFeed} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Skapar...
                </>
              ) : (
                <>
                  <Calendar className="mr-2 h-4 w-4" />
                  Aktivera kalendersynk
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
            Kalendersynkronisering
          </CardTitle>
          <CardDescription>
            Prenumerera på din kalender i Apple Calendar, Google Calendar eller Outlook
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Quick add for Apple Calendar */}
          <div className="flex gap-2">
            <Button onClick={openWebcal} className="flex-1">
              <Calendar className="mr-2 h-4 w-4" />
              Lägg till i Apple Calendar
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
            <Label>Kalenderlänk (för Google Calendar m.fl.)</Label>
            <div className="flex gap-2">
              <Input
                value={feed.httpsUrl}
                readOnly
                className="font-mono text-xs"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Kopiera denna länk och lägg till som URL-prenumeration i din kalenderapp.
            </p>
          </div>

          {/* Stats */}
          {feed.last_accessed_at && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Senast hämtad:</span>
              <span>
                {new Date(feed.last_accessed_at).toLocaleDateString('sv-SE', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <Badge variant="secondary" className="text-xs">
                {feed.access_count} gånger
              </Badge>
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
                  Skapar ny länk...
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Skapa ny länk
                </>
              )}
            </Button>
            <p className="text-xs text-muted-foreground mt-1">
              Ogiltigförklarar den gamla länken. Använd om någon obehörig fått tag i länken.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Content settings */}
      <Card>
        <CardHeader>
          <CardTitle>Innehåll i kalendern</CardTitle>
          <CardDescription>
            Välj vilka händelser som ska visas i din kalender
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="include-tax">Skattedeadlines</Label>
              <p className="text-sm text-muted-foreground">
                Moms, F-skatt, deklarationer
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
              <Label htmlFor="include-invoices">Fakturor</Label>
              <p className="text-sm text-muted-foreground">
                Förfallodatum för fakturor
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

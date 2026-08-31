'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { createClient } from '@/lib/supabase/client'
import { Bell, BellOff, Loader2, Mail, Moon } from 'lucide-react'
import type { NotificationSettings as NotificationSettingsType } from '@/types'

interface NotificationSettingsProps {
  onSettingsChange?: () => void
}

export function NotificationSettings({ onSettingsChange }: NotificationSettingsProps) {
  const { toast } = useToast()
  const supabase = createClient()

  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [settings, setSettings] = useState<NotificationSettingsType | null>(null)
  const [isPushSupported, setIsPushSupported] = useState(false)
  const [isPushSubscribed, setIsPushSubscribed] = useState(false)

  useEffect(() => {
    fetchSettings()
    checkPushSupport()
  }, [])

  const checkPushSupport = async () => {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      setIsPushSupported(true)

      try {
        const registration = await navigator.serviceWorker.ready
        const subscription = await registration.pushManager.getSubscription()
        setIsPushSubscribed(!!subscription)
      } catch (error) {
        console.error('Error checking push subscription:', error)
      }
    }
  }

  const fetchSettings = async () => {
    setIsLoading(true)

    // Notification settings are per user, not per company: quiet hours and the
    // per-category toggles belong to the person, and push_subscriptions are
    // keyed on a device endpoint. Neither table carries a company_id.
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setIsLoading(false)
      return
    }

    const { data, error } = await supabase
      .from('notification_settings')
      .select('*')
      .eq('user_id', user.id)
      .single()

    if (!error && data) {
      setSettings(data)
    } else {
      // Create default settings if not found
      const { data: newSettings, error: insertError } = await supabase
        .from('notification_settings')
        .insert({
          user_id: user.id,
          tax_deadlines_enabled: true,
          invoice_reminders_enabled: true,
          push_enabled: true,
          email_enabled: true,
          quiet_start: '21:00',
          quiet_end: '08:00',
        })
        .select()
        .single()

      if (!insertError && newSettings) {
        setSettings(newSettings)
      }
    }

    setIsLoading(false)
  }

  const updateSetting = async (key: keyof NotificationSettingsType, value: boolean | string) => {
    if (!settings) return

    setIsSaving(true)

    const { error } = await supabase
      .from('notification_settings')
      .update({ [key]: value })
      .eq('id', settings.id)

    if (error) {
      toast({
        title: 'Fel',
        description: 'Kunde inte spara inställning',
        variant: 'destructive',
      })
    } else {
      setSettings({ ...settings, [key]: value })
      onSettingsChange?.()
    }

    setIsSaving(false)
  }

  const subscribeToPush = async () => {
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        toast({
          title: 'Aviseringar avslagna',
          description: 'Du behöver ge tillåtelse för push-aviseringar i webbläsaren.',
        })
        return
      }

      const vapidResponse = await fetch('/api/extensions/ext/push-notifications/subscribe')
      const { vapidPublicKey } = await vapidResponse.json()

      if (!vapidPublicKey) {
        throw new Error('Push not configured')
      }

      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      })

      const response = await fetch('/api/extensions/ext/push-notifications/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      })

      if (!response.ok) {
        throw new Error('Failed to save subscription')
      }

      setIsPushSubscribed(true)
      toast({
        title: 'Push-aviseringar aktiverade',
        description: 'Du kommer nu få push-aviseringar.',
      })
    } catch (error) {
      toast({
        title: 'Fel',
        description: 'Kunde inte aktivera push-aviseringar.',
        variant: 'destructive',
      })
    }
  }

  const unsubscribeFromPush = async () => {
    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()

      if (subscription) {
        await subscription.unsubscribe()

        await fetch('/api/extensions/ext/push-notifications/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        })
      }

      setIsPushSubscribed(false)
      toast({
        title: 'Push-aviseringar inaktiverade',
        description: 'Du kommer inte längre få push-aviseringar.',
      })
    } catch (error) {
      toast({
        title: 'Fel',
        description: 'Kunde inte inaktivera push-aviseringar.',
        variant: 'destructive',
      })
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!settings) {
    return null
  }

  return (
    <div className="space-y-6">
      {/* Push notification status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            Push-aviseringar
          </CardTitle>
          <CardDescription>
            Få påminnelser direkt i din webbläsare
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isPushSupported ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">
                  {isPushSubscribed ? 'Aktiverade' : 'Inaktiverade'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {isPushSubscribed
                    ? 'Du får push-aviseringar på denna enhet'
                    : 'Aktivera för att få push-aviseringar'}
                </p>
              </div>
              <Button
                variant={isPushSubscribed ? 'outline' : 'default'}
                onClick={isPushSubscribed ? unsubscribeFromPush : subscribeToPush}
              >
                {isPushSubscribed ? (
                  <>
                    <BellOff className="mr-2 h-4 w-4" />
                    Inaktivera
                  </>
                ) : (
                  <>
                    <Bell className="mr-2 h-4 w-4" />
                    Aktivera
                  </>
                )}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Din webbläsare stöder inte push-aviseringar.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Category settings */}
      <Card>
        <CardHeader>
          <CardTitle>Aviseringskategorier</CardTitle>
          <CardDescription>
            Välj vilka typer av aviseringar du vill få
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="tax-deadlines">Skattedeadlines</Label>
              <p className="text-sm text-muted-foreground">
                Moms, F-skatt, inkomstdeklaration m.m.
              </p>
            </div>
            <Switch
              id="tax-deadlines"
              checked={settings.tax_deadlines_enabled}
              onCheckedChange={(checked) =>
                updateSetting('tax_deadlines_enabled', checked)
              }
              disabled={isSaving}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="invoice-reminders">Fakturapåminnelser</Label>
              <p className="text-sm text-muted-foreground">
                Fakturor som förfaller eller är försenade
              </p>
            </div>
            <Switch
              id="invoice-reminders"
              checked={settings.invoice_reminders_enabled}
              onCheckedChange={(checked) =>
                updateSetting('invoice_reminders_enabled', checked)
              }
              disabled={isSaving}
            />
          </div>

        </CardContent>
      </Card>

      {/* Email digest */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            E-post
          </CardTitle>
          <CardDescription>
            Sammanfattningar via e-post
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="email-digest">Nytt att bokföra</Label>
              <p className="text-sm text-muted-foreground">
                Dagligt mejl när nya banktransaktioner eller underlag har kommit in
              </p>
            </div>
            <Switch
              id="email-digest"
              checked={settings.email_digest_enabled}
              onCheckedChange={(checked) =>
                updateSetting('email_digest_enabled', checked)
              }
              disabled={isSaving}
            />
          </div>
        </CardContent>
      </Card>

      {/* Quiet hours */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Moon className="h-5 w-5" />
            Tysta timmar
          </CardTitle>
          <CardDescription>
            Inga aviseringar skickas under dessa timmar
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="quiet-start">Från</Label>
              <Input
                id="quiet-start"
                type="time"
                value={settings.quiet_start}
                onChange={(e) => updateSetting('quiet_start', e.target.value)}
                disabled={isSaving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="quiet-end">Till</Label>
              <Input
                id="quiet-end"
                type="time"
                value={settings.quiet_end}
                onChange={(e) => updateSetting('quiet_end', e.target.value)}
                disabled={isSaving}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Standard: 21:00 - 08:00 (Sveriges tid)
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }

  return outputArray.buffer
}

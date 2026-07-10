'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { AlertTriangle, Cloud, ExternalLink, Loader2, RefreshCw, Unplug } from 'lucide-react'
import type { CloudBackupStatus, GoogleDriveSchedule } from '../types'

const API_BASE = '/api/extensions/ext/cloud-backup'

export default function CloudBackupCard() {
  const { toast } = useToast()
  const t = useTranslations('extensions')
  const searchParams = useSearchParams()

  const [status, setStatus] = useState<CloudBackupStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/status`)
      if (!res.ok) throw new Error('Kunde inte hämta status')
      const { data } = (await res.json()) as { data: CloudBackupStatus }
      setStatus(data)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  // Handle OAuth callback redirect params.
  useEffect(() => {
    const result = searchParams.get('cloud_backup')
    if (!result) return
    if (result === 'connected') {
      toast({ title: 'Google Drive kopplat', description: 'Du kan nu synka till din Drive.' })
    } else if (result === 'error') {
      const reason = searchParams.get('reason') || 'Okänt fel'
      toast({
        title: 'Kunde inte koppla Google Drive',
        description: reason,
        variant: 'destructive',
      })
    }
    // Clean the URL so refresh doesn't re-fire the toast.
    const url = new URL(window.location.href)
    url.searchParams.delete('cloud_backup')
    url.searchParams.delete('reason')
    window.history.replaceState({}, '', url.toString())
  }, [searchParams, toast])

  const handleConnect = useCallback(async () => {
    setIsConnecting(true)
    try {
      const res = await fetch(`${API_BASE}/connect`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Kunde inte starta anslutning')
      }
      const { url } = (await res.json()) as { url: string }
      window.location.href = url
    } catch (err) {
      toast({
        title: 'Kunde inte koppla Google Drive',
        description: err instanceof Error ? err.message : 'Försök igen.',
        variant: 'destructive',
      })
      setIsConnecting(false)
    }
  }, [toast])

  const handleDisconnect = useCallback(async () => {
    setIsDisconnecting(true)
    try {
      const res = await fetch(`${API_BASE}/disconnect`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Kunde inte koppla bort')
      }
      toast({ title: 'Google Drive bortkopplat' })
      await loadStatus()
    } catch (err) {
      toast({
        title: 'Kunde inte koppla bort',
        description: err instanceof Error ? err.message : 'Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsDisconnecting(false)
    }
  }, [loadStatus, toast])

  const handleSync = useCallback(async () => {
    setIsSyncing(true)
    try {
      const res = await fetch(`${API_BASE}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ include_documents: true }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        if (res.status === 413) {
          const mb = body.size_bytes
            ? Math.round(body.size_bytes / (1024 * 1024))
            : null
          throw new Error(
            mb
              ? `Arkivet är ${mb} MB, större än nuvarande gräns. Minska omfattning eller avvakta bakgrundssynk.`
              : 'Arkivet är för stort för direktsynk.'
          )
        }
        if (body.error === 'needs_reauth') {
          // Refresh status so the card switches to the reconnect state.
          await loadStatus()
          throw new Error(t('ext_cloud_backup_reauth_description'))
        }
        throw new Error(body.error || 'Synkningen misslyckades')
      }
      const { data } = (await res.json()) as {
        data: { file_name: string; file_size_bytes: number; web_view_link: string }
      }
      toast({
        title: 'Uppladdad till Google Drive',
        description: `${data.file_name} (${formatMb(data.file_size_bytes)})`,
      })
      await loadStatus()
    } catch (err) {
      toast({
        title: 'Synkningen misslyckades',
        description: err instanceof Error ? err.message : 'Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsSyncing(false)
    }
  }, [loadStatus, t, toast])

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        {/* Identity */}
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06]">
            <Cloud className="h-[18px] w-[18px] text-foreground/60" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[15px] font-semibold leading-tight">Google Drive</h3>
            <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
              Säkerhetskopia till din egen Drive.
            </p>
          </div>
        </div>

        {/* Controls */}
        <div>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Laddar…</p>
          ) : status?.connected ? (
            <>
              {status.needs_reauth && (
                <div className="mb-6 flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-4">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {t('ext_cloud_backup_reauth_title')}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                      {t('ext_cloud_backup_reauth_description')}
                    </p>
                    <Button
                      onClick={handleConnect}
                      disabled={isConnecting}
                      className="mt-3 w-full sm:w-auto"
                    >
                      {isConnecting ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Omdirigerar…
                        </>
                      ) : (
                        <>
                          <Cloud className="mr-2 h-4 w-4" />
                          {t('ext_cloud_backup_reauth_action')}
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}
              <dl className="space-y-3 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">Konto</dt>
                  <dd className="min-w-0 truncate font-medium">{status.account_email}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">Senaste synk</dt>
                  <dd className="min-w-0 text-right">
                    {status.last_sync ? (
                      <>
                        <a
                          href={`https://drive.google.com/file/d/${status.last_sync.file_id}/view`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline tabular-nums"
                        >
                          {formatDate(status.last_sync.at)}
                          <ExternalLink className="h-3 w-3 text-muted-foreground" />
                        </a>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {formatMb(status.last_sync.file_size_bytes)}
                        </p>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Aldrig</span>
                    )}
                  </dd>
                </div>
              </dl>

              <div className="mt-6 pt-6 border-t border-border">
                <ScheduleSection
                  schedule={status.schedule}
                  needsReauth={status.needs_reauth}
                  onUpdated={loadStatus}
                />
              </div>

              <div className="mt-6 pt-6 border-t border-border flex flex-col gap-2 sm:flex-row sm:justify-between">
                <Button onClick={handleSync} disabled={isSyncing} className="w-full sm:w-auto">
                  {isSyncing ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Synkar…
                    </>
                  ) : (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Synka nu
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleDisconnect}
                  disabled={isDisconnecting}
                  className="w-full sm:w-auto"
                >
                  {isDisconnecting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Kopplar bort…
                    </>
                  ) : (
                    <>
                      <Unplug className="mr-2 h-4 w-4" />
                      Koppla bort
                    </>
                  )}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Koppla ditt Google-konto för att ladda upp säkerhetsbackupen till din egen Drive.
                Accounted får bara tillgång till filer som appen själv skapar (scope{' '}
                <span className="font-mono text-xs">drive.file</span>).
              </p>
              <div className="mt-4">
                <Button onClick={handleConnect} disabled={isConnecting} className="w-full sm:w-auto">
                  {isConnecting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Omdirigerar…
                    </>
                  ) : (
                    <>
                      <Cloud className="mr-2 h-4 w-4" />
                      Koppla Google Drive
                    </>
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(1)} MB`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface ScheduleSectionProps {
  schedule: GoogleDriveSchedule | null
  needsReauth: boolean
  onUpdated: () => Promise<void> | void
}

function ScheduleSection({ schedule, needsReauth, onUpdated }: ScheduleSectionProps) {
  const { toast } = useToast()
  const t = useTranslations('extensions')

  // Convert stored UTC hour to the user's local hour for display.
  const initialLocalHour =
    schedule && typeof schedule.hour_utc === 'number'
      ? utcHourToLocalHour(schedule.hour_utc)
      : utcHourToLocalHour(3)
  const [enabled, setEnabled] = useState(schedule?.enabled ?? false)
  const [localHour, setLocalHour] = useState(initialLocalHour)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setEnabled(schedule?.enabled ?? false)
    setLocalHour(
      schedule && typeof schedule.hour_utc === 'number'
        ? utcHourToLocalHour(schedule.hour_utc)
        : utcHourToLocalHour(3)
    )
  }, [schedule?.enabled, schedule?.hour_utc])

  const save = useCallback(
    async (nextEnabled: boolean, nextLocalHour: number) => {
      setIsSaving(true)
      try {
        const res = await fetch(`${API_BASE}/schedule`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: nextEnabled,
            hour_utc: localHourToUtcHour(nextLocalHour),
          }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || 'Kunde inte spara schema')
        }
        await onUpdated()
      } catch (err) {
        toast({
          title: 'Kunde inte spara schema',
          description: err instanceof Error ? err.message : 'Försök igen.',
          variant: 'destructive',
        })
      } finally {
        setIsSaving(false)
      }
    },
    [onUpdated, toast]
  )

  const handleToggle = useCallback(
    (checked: boolean) => {
      setEnabled(checked)
      save(checked, localHour)
    },
    [localHour, save]
  )

  const handleHourChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = Number(e.target.value)
      setLocalHour(next)
      if (enabled) save(enabled, next)
    },
    [enabled, save]
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor="auto-sync-toggle" className="text-sm font-medium">
            Automatisk synkronisering
          </Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Daglig säkerhetsbackup till din Drive.
          </p>
        </div>
        <Switch
          id="auto-sync-toggle"
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={isSaving}
        />
      </div>

      {enabled && (
        <div className="flex items-center gap-2">
          <Label htmlFor="auto-sync-hour" className="text-xs text-muted-foreground">
            Tid (lokal)
          </Label>
          <select
            id="auto-sync-hour"
            value={localHour}
            onChange={handleHourChange}
            disabled={isSaving}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {h.toString().padStart(2, '0')}:00
              </option>
            ))}
          </select>
          {isSaving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
      )}

      {schedule?.last_auto_sync_at && (
        <p className="text-xs text-muted-foreground">
          Senaste automatiska synk: {formatDate(schedule.last_auto_sync_at)}{' '}
          {schedule.last_auto_sync_status === 'success' ? (
            <span className="text-success">· lyckades</span>
          ) : schedule.last_auto_sync_status === 'error' ? (
            <span className="text-destructive">
              · misslyckades
              {needsReauth
                ? ` (${t('ext_cloud_backup_reauth_needed_short')})`
                : schedule.last_auto_sync_error
                  ? ` (${schedule.last_auto_sync_error})`
                  : ''}
            </span>
          ) : null}
        </p>
      )}
    </div>
  )
}

/** Convert a UTC hour (0-23) to the browser's local hour. */
function utcHourToLocalHour(hourUtc: number): number {
  const d = new Date()
  d.setUTCHours(hourUtc, 0, 0, 0)
  return d.getHours()
}

/** Convert a local hour (0-23) to UTC. */
function localHourToUtcHour(localHour: number): number {
  const d = new Date()
  d.setHours(localHour, 0, 0, 0)
  return d.getUTCHours()
}

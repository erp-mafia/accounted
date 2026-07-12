'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { AlertTriangle, Cloud, ExternalLink, Loader2, RefreshCw, Unplug } from 'lucide-react'
import type {
  CloudBackupStatus,
  GoogleDriveLastSync,
  GoogleDriveSchedule,
} from '../types'

const API_BASE = '/api/extensions/ext/cloud-backup'

export default function CloudBackupCard() {
  const { toast } = useToast()
  const t = useTranslations('extensions')
  const searchParams = useSearchParams()
  const { dialogProps, confirm } = useDestructiveConfirm()

  const [status, setStatus] = useState<CloudBackupStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/status`)
      if (!res.ok) throw new Error(t('ext_cloud_backup_status_failed'))
      const { data } = (await res.json()) as { data: CloudBackupStatus }
      setStatus(data)
    } finally {
      setIsLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  // After a connect redirect the first backup builds in the background: poll
  // the status a few times so the finished sync shows up without a reload.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  // Handle OAuth callback redirect params.
  useEffect(() => {
    const result = searchParams.get('cloud_backup')
    if (!result) return
    if (result === 'connected' || result === 'connected_first') {
      toast({
        title: t('ext_cloud_backup_connected_title'),
        description: t(
          result === 'connected_first'
            ? 'ext_cloud_backup_connected_first_description'
            : 'ext_cloud_backup_connected_description'
        ),
      })
      let attempts = 0
      pollRef.current = setInterval(() => {
        attempts += 1
        loadStatus()
        if (attempts >= 6 && pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      }, 10_000)
    } else if (result === 'error') {
      const reason = searchParams.get('reason') || t('ext_cloud_backup_unknown_error')
      toast({
        title: t('ext_cloud_backup_connect_failed'),
        description: reason,
        variant: 'destructive',
      })
    }
    // Clean the URL so refresh doesn't re-fire the toast.
    const url = new URL(window.location.href)
    url.searchParams.delete('cloud_backup')
    url.searchParams.delete('reason')
    window.history.replaceState({}, '', url.toString())
  }, [loadStatus, searchParams, t, toast])

  const handleConnect = useCallback(async () => {
    setIsConnecting(true)
    try {
      const res = await fetch(`${API_BASE}/connect`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || t('ext_cloud_backup_connect_start_failed'))
      }
      const { url } = (await res.json()) as { url: string }
      window.location.href = url
    } catch (err) {
      toast({
        title: t('ext_cloud_backup_connect_failed'),
        description: err instanceof Error ? err.message : t('ext_cloud_backup_try_again'),
        variant: 'destructive',
      })
      setIsConnecting(false)
    }
  }, [t, toast])

  const handleDisconnect = useCallback(async () => {
    setIsDisconnecting(true)
    try {
      const res = await fetch(`${API_BASE}/disconnect`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || t('ext_cloud_backup_disconnect_failed'))
      }
      toast({ title: t('ext_cloud_backup_disconnected') })
      await loadStatus()
    } catch (err) {
      toast({
        title: t('ext_cloud_backup_disconnect_failed'),
        description: err instanceof Error ? err.message : t('ext_cloud_backup_try_again'),
        variant: 'destructive',
      })
    } finally {
      setIsDisconnecting(false)
    }
  }, [loadStatus, t, toast])

  type SyncOutcome =
    | { result: 'ok' | 'error' }
    | { result: 'too_large'; sizeMb: number | null; limitMb: number | null }

  const syncOnce = useCallback(
    async (allowDocumentFallback: boolean): Promise<SyncOutcome> => {
      setIsSyncing(true)
      try {
        const res = await fetch(`${API_BASE}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            include_documents: true,
            allow_document_fallback: allowDocumentFallback,
          }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          if (res.status === 413 && !allowDocumentFallback) {
            // Handled by the caller: a dialog offers syncing the oversized
            // archives without their document blobs.
            return {
              result: 'too_large',
              sizeMb: body.size_bytes
                ? Math.round(body.size_bytes / (1024 * 1024))
                : null,
              limitMb: body.size_limit_bytes
                ? Math.round(body.size_limit_bytes / (1024 * 1024))
                : null,
            }
          }
          if (body.error === 'needs_reauth') {
            // Refresh status so the card switches to the reconnect state.
            await loadStatus()
            throw new Error(t('ext_cloud_backup_reauth_description'))
          }
          throw new Error(body.error || t('ext_cloud_backup_sync_failed'))
        }
        const { data } = (await res.json()) as {
          data: GoogleDriveLastSync & {
            web_view_link: string
            uploaded_count?: number
            skipped_count?: number
          }
        }
        if (data.uploaded_count === 0) {
          toast({
            title: t('ext_cloud_backup_up_to_date'),
            description: t('ext_cloud_backup_no_changes'),
          })
        } else {
          const anyNoDocs = (data.files ?? []).some(
            (f) => f.kind !== 'readme' && f.included_documents === false
          )
          toast({
            title: t('ext_cloud_backup_uploaded'),
            description: `${t('ext_cloud_backup_files_updated', {
              count: data.uploaded_count ?? 0,
            })} (${formatMb(data.total_size_bytes ?? data.file_size_bytes ?? 0)})${
              anyNoDocs ? ` · ${t('ext_cloud_backup_no_documents_note')}` : ''
            }`,
          })
        }
        await loadStatus()
        return { result: 'ok' }
      } catch (err) {
        toast({
          title: t('ext_cloud_backup_sync_failed'),
          description: err instanceof Error ? err.message : t('ext_cloud_backup_try_again'),
          variant: 'destructive',
        })
        return { result: 'error' }
      } finally {
        setIsSyncing(false)
      }
    },
    [loadStatus, t, toast]
  )

  const handleSync = useCallback(async () => {
    const first = await syncOnce(false)
    if (first.result !== 'too_large') return
    const ok = await confirm({
      title: t('ext_cloud_backup_too_large_title'),
      description: t('ext_cloud_backup_too_large_description', {
        size: first.sizeMb != null ? String(first.sizeMb) : '?',
        limit: first.limitMb != null ? String(first.limitMb) : '?',
      }),
      confirmLabel: t('ext_cloud_backup_too_large_confirm'),
      variant: 'warning',
    })
    if (ok) await syncOnce(true)
  }, [confirm, syncOnce, t])

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <DestructiveConfirmDialog {...dialogProps} />
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        {/* Identity */}
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06]">
            <Cloud className="h-[18px] w-[18px] text-foreground/60" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[15px] font-semibold leading-tight">Google Drive</h3>
            <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
              {t('ext_cloud_backup_card_tagline')}
            </p>
          </div>
        </div>

        {/* Controls */}
        <div>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t('ext_cloud_backup_loading')}</p>
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
                          {t('ext_cloud_backup_redirecting')}
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
                  <dt className="shrink-0 text-muted-foreground">
                    {t('ext_cloud_backup_account_label')}
                  </dt>
                  <dd className="min-w-0 truncate font-medium">{status.account_email}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">
                    {t('ext_cloud_backup_last_sync_label')}
                  </dt>
                  <dd className="min-w-0 text-right">
                    {status.last_sync ? (
                      <LastSyncSummary lastSync={status.last_sync} />
                    ) : (
                      <span className="text-muted-foreground">
                        {t('ext_cloud_backup_never')}
                      </span>
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
                      {t('ext_cloud_backup_syncing')}
                    </>
                  ) : (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      {t('ext_cloud_backup_sync_now')}
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
                      {t('ext_cloud_backup_disconnecting')}
                    </>
                  ) : (
                    <>
                      <Unplug className="mr-2 h-4 w-4" />
                      {t('ext_cloud_backup_disconnect')}
                    </>
                  )}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {t('ext_cloud_backup_connect_description')}
              </p>
              <div className="mt-4">
                <Button onClick={handleConnect} disabled={isConnecting} className="w-full sm:w-auto">
                  {isConnecting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t('ext_cloud_backup_redirecting')}
                    </>
                  ) : (
                    <>
                      <Cloud className="mr-2 h-4 w-4" />
                      {t('ext_cloud_backup_connect')}
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

/**
 * Last-sync cell. New records list the per-fiscal-year files and link to the
 * Drive folder; legacy single-ZIP records link to the file.
 */
function LastSyncSummary({ lastSync }: { lastSync: GoogleDriveLastSync }) {
  const t = useTranslations('extensions')
  const files = lastSync.files
  const href = files
    ? `https://drive.google.com/drive/folders/${lastSync.folder_id}`
    : `https://drive.google.com/file/d/${lastSync.file_id}/view`
  const sizeBytes = files
    ? lastSync.total_size_bytes ?? 0
    : lastSync.file_size_bytes ?? 0
  const anyNoDocs = files
    ? files.some((f) => f.kind !== 'readme' && f.included_documents === false)
    : lastSync.included_documents === false
  const archiveCount = files ? files.filter((f) => f.kind !== 'readme').length : null
  const verified = files ? files.every((f) => f.sha256) : Boolean(lastSync.sha256)

  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline tabular-nums"
      >
        {formatDateTime(lastSync.at)}
        <ExternalLink className="h-3 w-3 text-muted-foreground" />
      </a>
      <p className="text-xs text-muted-foreground tabular-nums">
        {formatMb(sizeBytes)}
        {archiveCount !== null &&
          ` · ${t('ext_cloud_backup_files_count', { count: archiveCount })}`}
        {verified && ` · ${t('ext_cloud_backup_verified')}`}
      </p>
      {anyNoDocs && (
        <p className="text-xs text-muted-foreground">
          {t('ext_cloud_backup_last_sync_no_documents')}
        </p>
      )}
    </>
  )
}

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(1)} MB`
}

function formatDateTime(iso: string): string {
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

  // Prefer the DST-stable Stockholm hour; fall back to converting the legacy
  // UTC hour through the browser's clock (Swedish users: same thing).
  const scheduleHour = (s: GoogleDriveSchedule | null): number =>
    typeof s?.hour_local === 'number'
      ? s.hour_local
      : utcHourToLocalHour(typeof s?.hour_utc === 'number' ? s.hour_utc : 3)

  const [enabled, setEnabled] = useState(schedule?.enabled ?? false)
  const [localHour, setLocalHour] = useState(scheduleHour(schedule))
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setEnabled(schedule?.enabled ?? false)
    setLocalHour(scheduleHour(schedule))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule?.enabled, schedule?.hour_utc, schedule?.hour_local])

  const save = useCallback(
    async (nextEnabled: boolean, nextLocalHour: number) => {
      setIsSaving(true)
      try {
        const res = await fetch(`${API_BASE}/schedule`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: nextEnabled,
            hour_local: nextLocalHour,
          }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || t('ext_cloud_backup_schedule_save_failed'))
        }
        await onUpdated()
      } catch (err) {
        toast({
          title: t('ext_cloud_backup_schedule_save_failed'),
          description: err instanceof Error ? err.message : t('ext_cloud_backup_try_again'),
          variant: 'destructive',
        })
      } finally {
        setIsSaving(false)
      }
    },
    [onUpdated, t, toast]
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
            {t('ext_cloud_backup_auto_sync_title')}
          </Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('ext_cloud_backup_auto_sync_description')}
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
            {t('ext_cloud_backup_time_label')}
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
          {t('ext_cloud_backup_last_auto_sync')} {formatDateTime(schedule.last_auto_sync_at)}{' '}
          {schedule.last_auto_sync_status === 'success' ? (
            <span className="text-success">· {t('ext_cloud_backup_auto_sync_success')}</span>
          ) : schedule.last_auto_sync_status === 'error' ? (
            <span className="text-destructive">
              · {t('ext_cloud_backup_auto_sync_error')}
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

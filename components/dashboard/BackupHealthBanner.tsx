'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'

// Local mirror of the cloud-backup status shape: core must not import from
// @/extensions/, so the fields we read are declared here.
interface BackupStatus {
  connected: boolean
  needs_reauth: boolean
  schedule: { last_auto_sync_status: 'success' | 'error' | null } | null
}

/**
 * Warning shown on the dashboard ONLY when the Google Drive backup is failing
 * (dead token or errored auto-sync). A backup that silently stops is worse
 * than none; this makes the failure visible where the user actually is.
 * Renders nothing when the extension is off, disconnected, or healthy.
 */
export default function BackupHealthBanner() {
  const t = useTranslations('extensions')
  const [status, setStatus] = useState<BackupStatus | null>(null)

  useEffect(() => {
    if (!ENABLED_EXTENSION_IDS.has('cloud-backup')) return
    let cancelled = false
    fetch('/api/extensions/ext/cloud-backup/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body?.data) setStatus(body.data as BackupStatus)
      })
      .catch(() => {
        // Fail silent: the dashboard must not degrade over a status probe.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!status?.connected) return null
  const failing =
    status.needs_reauth || status.schedule?.last_auto_sync_status === 'error'
  if (!failing) return null

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-4">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
      <div className="flex-1 text-sm">
        <p className="font-medium">
          {status.needs_reauth
            ? t('ext_cloud_backup_banner_reauth')
            : t('ext_cloud_backup_banner_failing')}
        </p>
        <Link
          href="/import#cloud-backup"
          className="mt-1 inline-block text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          {t('ext_cloud_backup_banner_action')}
        </Link>
      </div>
    </div>
  )
}

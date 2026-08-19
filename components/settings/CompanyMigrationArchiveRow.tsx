'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { FullArchiveDialog } from '@/components/import/FullArchiveDialog'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'
import type { ApiResponse, ArchiveEstimate } from '@/types'

const ESTIMATE_RETRY_DELAY_MS = 1_000
const ESTIMATE_MAX_ATTEMPTS = 3

export function CompanyMigrationArchiveRow({ companyId }: { companyId: string }) {
  const t = useTranslations('settings_company')
  const [loadedEstimate, setLoadedEstimate] = useState<{
    companyId: string
    value: ArchiveEstimate
  } | null>(null)
  const [open, setOpen] = useState(false)
  const estimate = loadedEstimate?.companyId === companyId
    ? loadedEstimate.value
    : null

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const scheduleRetry = (attempt: number) => {
      if (cancelled || attempt >= ESTIMATE_MAX_ATTEMPTS) return
      retryTimer = setTimeout(() => {
        void loadEstimate(attempt + 1)
      }, ESTIMATE_RETRY_DELAY_MS)
    }

    const loadEstimate = async (attempt: number) => {
      try {
        const response = await fetch(
          `/api/company/${companyId}/migration-reset/archive?estimate=1`,
          { signal: controller.signal },
        )
        if (!response.ok) {
          if (response.status >= 500 || response.status === 429) scheduleRetry(attempt)
          return
        }
        const body = await response.json() as ApiResponse<ArchiveEstimate>
        if (!cancelled && body.data) {
          setLoadedEstimate({ companyId, value: body.data })
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        scheduleRetry(attempt)
      }
    }

    void loadEstimate(1)
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      controller.abort()
    }
  }, [companyId])

  if (!estimate) return null

  return (
    <>
      <SettingsGroup label={t('reset_archive_group_label')}>
        <SettingsRow label={t('reset_archive_row_label')} borderless>
          <SettingsRowNote>
            {t('reset_archive_row_note', { count: estimate.document_count })}
          </SettingsRowNote>
          <SettingsRowEnd>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="text-sm font-medium text-foreground underline underline-offset-2 transition-colors duration-150 hover:text-foreground/70"
            >
              {t('reset_archive_row_action')}
            </button>
          </SettingsRowEnd>
        </SettingsRow>
      </SettingsGroup>

      <FullArchiveDialog
        open={open}
        onOpenChange={setOpen}
        mode="migration-reset-source"
        companyId={companyId}
      />
    </>
  )
}

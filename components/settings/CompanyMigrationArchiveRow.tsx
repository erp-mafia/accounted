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

interface ArchiveEstimate {
  document_count: number
}

export function CompanyMigrationArchiveRow({ companyId }: { companyId: string }) {
  const t = useTranslations('settings_company')
  const [estimate, setEstimate] = useState<ArchiveEstimate | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    ;(async () => {
      try {
        const response = await fetch(
          `/api/company/${companyId}/migration-reset/archive?estimate=1`,
          { signal: controller.signal },
        )
        if (!response.ok) return
        const body = await response.json() as { data?: ArchiveEstimate }
        if (body.data) setEstimate(body.data)
      } catch {
        // A transient lookup failure must not expose or guess an archive link.
        // The row appears after a later settings load once authorization works.
      }
    })()
    return () => controller.abort()
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
      />
    </>
  )
}

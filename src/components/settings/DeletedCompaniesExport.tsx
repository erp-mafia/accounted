'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowDownTrayIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'
import { formatDate } from '@/lib/utils'

interface DeletedCompanyExport {
  id: string
  name: string
  archivedAt: string
  exportUntil: string
}

/**
 * Du → Säkerhet: deleted companies whose full archive can still be
 * downloaded, read only, for 18 months after the deletion (terms 9.3,
 * lib/company/deleted-company-export). Renders nothing when there are none.
 * A list that cannot be read says so in one row with a retry: silence there
 * would read as "nothing to fetch" right before the account is deleted.
 *
 * It sits on the delete-account page on purpose: a person who deleted their
 * last company is sent here, and this is the last place to fetch the
 * archives before deleting the account ends their access.
 */
export function DeletedCompaniesExport() {
  const t = useTranslations('settings_deleted_companies')
  const tCommon = useTranslations('common')
  const [companies, setCompanies] = useState<DeletedCompanyExport[]>([])
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/account/deleted-companies')
        if (!res.ok) {
          if (!cancelled) setFailed(true)
          return
        }
        const body = (await res.json()) as { data?: DeletedCompanyExport[] }
        if (!cancelled) {
          setCompanies(body.data ?? [])
          setFailed(false)
        }
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  if (failed && companies.length === 0) {
    return (
      <SettingsGroup label={t('heading')} help={t('help')}>
        <SettingsRow label={t('load_failed')}>
          <SettingsRowEnd>
            <Button
              variant="outline"
              onClick={() => {
                setFailed(false)
                setReloadKey((key) => key + 1)
              }}
            >
              {tCommon('retry')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
      </SettingsGroup>
    )
  }

  if (companies.length === 0) return null

  return (
    <SettingsGroup label={t('heading')} help={t('help')}>
      {companies.map((company) => (
        <SettingsRow key={company.id} label={<span data-ph-mask="">{company.name}</span>}>
          <SettingsRowNote className="min-w-0">
            {t('row_note', {
              deletedOn: formatDate(company.archivedAt),
              exportUntil: formatDate(company.exportUntil),
            })}
          </SettingsRowNote>
          <SettingsRowEnd>
            <Button variant="outline" asChild>
              <a href={`/api/account/deleted-companies/${company.id}/archive`} download>
                <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                {t('download')}
              </a>
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
      ))}
    </SettingsGroup>
  )
}

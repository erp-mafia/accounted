'use client'

import { useId, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { HelpPopover } from '@/components/ui/help-popover'
import { useToast } from '@/components/ui/use-toast'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { failureDescription } from '@/lib/browser/action-failure'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { zettleRequest } from '../lib/settings-actions'
import {
  ZETTLE_ORGANIZATION_NAME_MAX_LEN,
  normalizeZettleOrganizationName,
  zettleStoreDisplayName,
} from '../lib/organization-name'

interface StoreNameRowProps {
  /** zettle_connections.organization_name as stored; null before anyone named the store. */
  storedName: string | null
  /** The name the server saved, so the card's heading follows without a reload. */
  onSaved: (name: string) => void
}

/**
 * The store name row on the Zettle card. Zettle's users/self carries no name,
 * so the merchant names the store here; it is shown as Butik on the Orders
 * page. The field is seeded with the display name (never the organization
 * UUID), and the draft is this row's own state, so a status reload after
 * "Synka nu" does not overwrite what the person is typing.
 */
export function StoreNameRow({ storedName, onSaved }: StoreNameRowProps) {
  const t = useTranslations('zettle')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite, lockedTitle } = useViewerLock()
  const inputId = useId()
  const [stored, setStored] = useState(storedName)
  const [draft, setDraft] = useState(() => zettleStoreDisplayName(storedName))
  const [saving, setSaving] = useState(false)

  const next = normalizeZettleOrganizationName(draft)
  // Compared with the stored value, not the display fallback: a store never
  // named still saves the default, which backfills its existing orders.
  const unchanged = next === normalizeZettleOrganizationName(stored ?? '')
  const canSave = canWrite && !saving && next.length > 0 && !unchanged

  async function save() {
    if (!canSave) return
    setSaving(true)
    try {
      const result = await zettleRequest<{ organization_name?: string; warning?: string }>({
        url: '/api/extensions/ext/zettle/organization-name',
        body: { organization_name: next },
        locale,
      })
      if (!result.ok) {
        toast({
          title: t('store_name_save_failed'),
          description: failureDescription(result, {
            timeout: t('action_timeout'),
            network: t('action_network'),
          }),
          variant: 'destructive',
        })
        return
      }
      const saved = result.data?.organization_name ?? next
      setStored(saved)
      setDraft(saved)
      onSaved(saved)
      toast({
        title: t('store_name_saved_toast'),
        description: result.data?.warning ? t('store_name_saved_orders_warning') : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t-hairline pt-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <label htmlFor={inputId}>{t('store_name_label')}</label>
        <HelpPopover className="shrink-0">
          <p>{t('store_name_help')}</p>
        </HelpPopover>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          id={inputId}
          className="w-48"
          value={draft}
          maxLength={ZETTLE_ORGANIZATION_NAME_MAX_LEN}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void save()
            }
          }}
          disabled={saving || !canWrite}
        />
        <Button variant="outline" onClick={() => void save()} disabled={!canSave} loading={saving} title={lockedTitle}>
          {saving ? t('store_name_saving') : t('store_name_save')}
        </Button>
      </div>
    </div>
  )
}

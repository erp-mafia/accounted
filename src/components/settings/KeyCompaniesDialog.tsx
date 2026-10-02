'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import {
  CompanyPickerList,
  orderedSelection,
  readOnlySelection,
  setAccessInSet,
  toggleInSet,
  type PickerCompany,
} from '@/components/settings/CompanyPickerList'
import type { ApiKeyRow } from '@/components/settings/useApiKeys'

/**
 * Per-key company allowlist and access editor, opened from a connection row.
 * Mount it with `key={keyRow.id}` so the selection initialises from the row
 * each time it opens. Saving PATCHes both fields explicitly, so the server
 * sets exactly what the dialog shows: every company selected at read and
 * write is sent as `company_ids: null` (unrestricted, follows future
 * memberships); otherwise the list, with `read_only_company_ids` (empty when
 * none). The company the key is listed under stays selected: the route
 * refuses an allowlist without it.
 */
export function KeyCompaniesDialog({
  keyRow,
  name,
  companies,
  onClose,
  onSaved,
}: {
  keyRow: ApiKeyRow
  /** The connection's display name, as the list shows it. */
  name: string
  companies: PickerCompany[]
  onClose: () => void
  onSaved: () => void
}) {
  const t = useTranslations('settings_api_keys')
  const { toast } = useToast()
  const activeCompanyId = companies.find((company) => company.is_active)?.company_id ?? null
  const [selected, setSelected] = useState<Set<string>>(() => {
    const current =
      keyRow.company_ids && keyRow.company_ids.length > 0
        ? new Set(keyRow.company_ids)
        : new Set(companies.map((company) => company.company_id))
    if (activeCompanyId) current.add(activeCompanyId)
    return current
  })
  const [readOnly, setReadOnly] = useState<Set<string>>(() => new Set(keyRow.read_only_company_ids ?? []))
  const [isSaving, setIsSaving] = useState(false)

  async function handleSave() {
    setIsSaving(true)
    try {
      const res = await fetch(`/api/settings/api-keys/${keyRow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_ids:
            selected.size >= companies.length && readOnlySelection(companies, selected, readOnly).length === 0
              ? null
              : orderedSelection(companies, selected),
          read_only_company_ids: readOnlySelection(companies, selected, readOnly),
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        const message =
          typeof json.error === 'string'
            ? json.error
            : json.error?.message ?? t('toast_companies_failed')
        toast({ title: message, variant: 'destructive' })
        return
      }
      toast({ title: t('toast_companies_saved') })
      onSaved()
      onClose()
    } catch {
      toast({ title: t('toast_companies_failed'), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('companies_dialog_title')}</DialogTitle>
          <DialogDescription>{t('companies_dialog_description', { name })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <Label>{t('companies_section_title')}</Label>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {t('selected_count', { selected: selected.size, total: companies.length })}
            </span>
          </div>
          <CompanyPickerList
            companies={companies}
            selected={selected}
            readOnly={readOnly}
            lockedId={activeCompanyId}
            onToggle={toggleInSet(setSelected)}
            onAccessChange={setAccessInSet(setReadOnly)}
          />
          <p className="text-xs text-muted-foreground">{t('companies_help')}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={selected.size === 0} loading={isSaving}>
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

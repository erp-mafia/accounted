'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

/** One of the byrå's client companies, as GET /api/team/members lists them. */
export interface TeamCompany {
  id: string
  name: string
}

/**
 * Which of the byrå's client companies a member reaches: every company
 * (including new ones) or the chosen ones. Shared by the invite form and the
 * member rows of TeamPanel. `value` null means every company. `lockedIds` are
 * memberships added directly on a company: the team choice cannot remove
 * them, so they show checked and disabled, and they are sent along so a
 * choice of only those is still a choice.
 */
export function TeamCompanyAccessDialog({
  open,
  onOpenChange,
  description,
  companies,
  value,
  lockedIds = [],
  saving = false,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  description: string
  companies: TeamCompany[]
  value: string[] | null
  lockedIds?: string[]
  saving?: boolean
  onSave: (value: string[] | null) => void
}) {
  const t = useTranslations('settings_team_panel')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('access_dialog_title')}</DialogTitle>
          <DialogDescription data-ph-mask="">{description}</DialogDescription>
        </DialogHeader>
        {/* Mounted per opening, so every opening starts from the saved value. */}
        {open && (
          <AccessForm
            companies={companies}
            value={value}
            lockedIds={lockedIds}
            saving={saving}
            onCancel={() => onOpenChange(false)}
            onSave={onSave}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function AccessForm({
  companies,
  value,
  lockedIds,
  saving,
  onCancel,
  onSave,
}: {
  companies: TeamCompany[]
  value: string[] | null
  lockedIds: string[]
  saving: boolean
  onCancel: () => void
  onSave: (value: string[] | null) => void
}) {
  const t = useTranslations('settings_team_panel')
  const tCommon = useTranslations('common')
  const [all, setAll] = useState(value === null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(value ?? []))
  const locked = new Set(lockedIds)

  // Chosen ids in list order, locked ones included.
  const chosen = companies
    .filter((company) => locked.has(company.id) || selected.has(company.id))
    .map((company) => company.id)
  const canSave = all || chosen.length > 0

  const toggle = (companyId: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(companyId)
      else next.delete(companyId)
      return next
    })

  return (
    <>
      <div className="flex items-center justify-between gap-4 border-b border-border px-1 pb-3">
        <label htmlFor="team-access-all" className="cursor-pointer text-sm">
          {t('access_all_switch')}
        </label>
        <Switch id="team-access-all" checked={all} onCheckedChange={setAll} />
      </div>

      {!all && (
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {companies.map((company) => {
            const isLocked = locked.has(company.id)
            const checked = isLocked || selected.has(company.id)
            return (
              <label
                key={company.id}
                className={cn(
                  'flex items-center gap-2 rounded-lg border border-border p-2 transition-colors duration-150',
                  checked ? 'bg-secondary' : 'hover:bg-secondary/60',
                  isLocked ? 'cursor-default' : 'cursor-pointer',
                )}
              >
                <Checkbox
                  checked={checked}
                  disabled={isLocked}
                  onCheckedChange={(next) => toggle(company.id, next === true)}
                />
                <span className="min-w-0 flex-1 truncate text-sm" data-ph-mask="">
                  {company.name}
                </span>
                {isLocked && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t('access_direct_hint')}
                  </span>
                )}
              </label>
            )
          })}
          {chosen.length === 0 && (
            <p className="px-1 text-xs text-muted-foreground">{t('access_none_selected')}</p>
          )}
        </div>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          {tCommon('cancel')}
        </Button>
        <Button onClick={() => onSave(all ? null : chosen)} disabled={!canSave} loading={saving}>
          {tCommon('save')}
        </Button>
      </DialogFooter>
    </>
  )
}

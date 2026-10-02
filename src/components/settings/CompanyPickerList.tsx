'use client'

import { useTranslations } from 'next-intl'
import { Checkbox } from '@/components/ui/checkbox'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { cn } from '@/lib/utils'

/** One of the caller's companies, as GET /api/settings/api-keys lists them in `meta.companies`. */
export interface PickerCompany {
  company_id: string
  name: string
  is_active: boolean
}

/** What a key may do in one company: its scopes as granted, or only read. */
export type CompanyAccess = 'read' | 'write'

/**
 * Checkbox list of the caller's companies, shared by the create dialog and
 * the per-key edit dialog. A ticked company also gets a read-and-write /
 * read-only switch: read only blocks every change the key could make in that
 * company, whatever its permissions say. `lockedId` keeps one row checked
 * and disabled: the company a key is created in stays inside its allowlist
 * (its access level can still change).
 */
export function CompanyPickerList({
  companies,
  selected,
  readOnly,
  lockedId,
  onToggle,
  onAccessChange,
}: {
  companies: PickerCompany[]
  selected: Set<string>
  /** The ticked companies switched to "Bara läsa". */
  readOnly: Set<string>
  lockedId: string | null
  onToggle: (companyId: string, checked: boolean) => void
  onAccessChange: (companyId: string, access: CompanyAccess) => void
}) {
  const t = useTranslations('settings_api_keys')
  return (
    <div className="space-y-2">
      {companies.map((company) => {
        const checked = selected.has(company.company_id)
        const locked = company.company_id === lockedId
        return (
          <div
            key={company.company_id}
            className={cn(
              'flex items-center gap-2 rounded-lg border border-border p-2 transition-colors duration-150',
              checked ? 'bg-secondary' : 'hover:bg-secondary/60',
            )}
          >
            <label
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2',
                locked ? 'cursor-default' : 'cursor-pointer',
              )}
            >
              <Checkbox
                checked={checked}
                disabled={locked}
                onCheckedChange={(value) => onToggle(company.company_id, value === true)}
                className="shrink-0"
              />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                {company.name}
              </span>
              {company.is_active && (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {t('active_company_tag')}
                </span>
              )}
            </label>
            {checked && (
              <SegmentedControl<CompanyAccess>
                value={readOnly.has(company.company_id) ? 'read' : 'write'}
                onChange={(access) => onAccessChange(company.company_id, access)}
                options={[
                  { value: 'write', label: t('access_write') },
                  { value: 'read', label: t('access_read') },
                ]}
                aria-label={t('access_label', { name: company.name })}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Toggle one id in a Set held in React state. */
export function toggleInSet(setter: (update: (prev: Set<string>) => Set<string>) => void) {
  return (companyId: string, checked: boolean) =>
    setter((prev) => {
      const next = new Set(prev)
      if (checked) next.add(companyId)
      else next.delete(companyId)
      return next
    })
}

/** Keep the read-only Set in step with an access switch. */
export function setAccessInSet(setter: (update: (prev: Set<string>) => Set<string>) => void) {
  return (companyId: string, access: CompanyAccess) =>
    setter((prev) => {
      const next = new Set(prev)
      if (access === 'read') next.add(companyId)
      else next.delete(companyId)
      return next
    })
}

/** Selected ids in picker order (active first), never in click order. */
export function orderedSelection(companies: PickerCompany[], selected: Set<string>): string[] {
  return companies.filter((company) => selected.has(company.company_id)).map((company) => company.company_id)
}

/** Read-only companies that are also ticked, in picker order. */
export function readOnlySelection(
  companies: PickerCompany[],
  selected: Set<string>,
  readOnly: Set<string>,
): string[] {
  return companies
    .filter((company) => selected.has(company.company_id) && readOnly.has(company.company_id))
    .map((company) => company.company_id)
}

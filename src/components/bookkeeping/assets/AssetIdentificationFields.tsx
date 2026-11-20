'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsSelect } from '@/components/settings/SettingsRows'
import { parseAmountInput } from '@/lib/money'
import { formatDate } from '@/lib/utils'
import type { Asset, AssetCategory } from '@/types'

/**
 * What identifies a building or a vehicle in the asset register: a
 * building's fastighetsbeteckning and taxeringsvärde, a vehicle's
 * registration number and the bilförmån it is used for. Saved beside the
 * asset through PATCH /api/assets/:id/identification, never as part of the
 * depreciation basis. Shown only for the companies in the Bolaget rollout:
 * the car-benefits read answers 404 elsewhere, and the fields stay hidden.
 */
export interface IdentificationState {
  fastighetsbeteckning: string
  taxeringsvarde: string
  registration_number: string
  employee_benefit_id: string
}

interface CarBenefitOption {
  employee_benefit_id: string
  description: string
  employee_name: string | null
  valid_from: string
  valid_to: string | null
}

const RELEVANT: Partial<Record<AssetCategory, ReadonlyArray<keyof IdentificationState>>> = {
  building: ['fastighetsbeteckning', 'taxeringsvarde'],
  vehicle: ['registration_number', 'employee_benefit_id'],
}

export function identificationFrom(asset?: Partial<Asset> | null): IdentificationState {
  return {
    fastighetsbeteckning: asset?.fastighetsbeteckning ?? '',
    taxeringsvarde: asset?.taxeringsvarde == null ? '' : String(asset.taxeringsvarde),
    registration_number: asset?.registration_number ?? '',
    employee_benefit_id: asset?.employee_benefit_id ?? '',
  }
}

/**
 * The changes to send for the category, or null when nothing changed. An
 * unparseable taxeringsvärde answers 'invalid'.
 */
export function identificationPayload(
  category: AssetCategory,
  value: IdentificationState,
  initial: IdentificationState,
): Record<string, string | number | null> | null | 'invalid' {
  const fields = RELEVANT[category] ?? []
  const out: Record<string, string | number | null> = {}
  for (const field of fields) {
    if (value[field].trim() === initial[field].trim()) continue
    if (field === 'taxeringsvarde') {
      if (value.taxeringsvarde.trim() === '') {
        out.taxeringsvarde = null
        continue
      }
      const amount = parseAmountInput(value.taxeringsvarde)
      if (amount === null || amount < 0) return 'invalid'
      out.taxeringsvarde = amount
      continue
    }
    out[field] = value[field].trim() || null
  }
  return Object.keys(out).length > 0 ? out : null
}

export async function saveAssetIdentification(assetId: string, payload: Record<string, unknown>): Promise<{ ok: true } | { ok: false; body: unknown }> {
  const res = await fetch(`/api/assets/${assetId}/identification`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (res.ok) return { ok: true }
  return { ok: false, body: await res.json().catch(() => ({})) }
}

/** Whether the fields are offered for this category and company, and the bilförmåner a vehicle can be linked to. */
export function useAssetIdentification(category: AssetCategory): { available: boolean; benefits: CarBenefitOption[] } {
  const [available, setAvailable] = useState(false)
  const [benefits, setBenefits] = useState<CarBenefitOption[]>([])
  const relevant = RELEVANT[category] !== undefined
  useEffect(() => {
    if (!relevant) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/assets/car-benefits')
        if (!res.ok || cancelled) return
        const body = await res.json().catch(() => ({}))
        if (cancelled) return
        setAvailable(true)
        setBenefits(body.data?.benefits ?? [])
      } catch {
        // Offline or refused: the fields stay hidden.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [relevant])
  return { available: available && relevant, benefits }
}

export function AssetIdentificationFields({
  category,
  value,
  onChange,
  available,
  benefits,
  idPrefix,
  disabled = false,
}: {
  category: AssetCategory
  value: IdentificationState
  onChange: (next: IdentificationState) => void
  available: boolean
  benefits: CarBenefitOption[]
  idPrefix: string
  disabled?: boolean
}) {
  const t = useTranslations('bolaget_commitments.asset')
  if (!available) return null
  const set = (field: keyof IdentificationState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    onChange({ ...value, [field]: e.target.value })

  if (category === 'building') {
    return (
      <div className="space-y-3 rounded-lg p-4 bg-control shadow-raised">
        <p className="text-sm font-medium">{t('building_title')}</p>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-fastighetsbeteckning`}>{t('fastighetsbeteckning')}</Label>
            <Input
              id={`${idPrefix}-fastighetsbeteckning`}
              value={value.fastighetsbeteckning}
              onChange={set('fastighetsbeteckning')}
              maxLength={120}
              placeholder={t('fastighetsbeteckning_placeholder')}
              disabled={disabled}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-taxeringsvarde`}>{t('taxeringsvarde')}</Label>
            <Input
              id={`${idPrefix}-taxeringsvarde`}
              value={value.taxeringsvarde}
              onChange={set('taxeringsvarde')}
              inputMode="decimal"
              className="tabular-nums"
              disabled={disabled}
            />
          </div>
        </div>
      </div>
    )
  }
  if (category === 'vehicle') {
    return (
      <div className="space-y-3 rounded-lg p-4 bg-control shadow-raised">
        <p className="text-sm font-medium">{t('vehicle_title')}</p>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-registration_number`}>{t('registration_number')}</Label>
            <Input
              id={`${idPrefix}-registration_number`}
              value={value.registration_number}
              onChange={set('registration_number')}
              maxLength={20}
              className="uppercase"
              disabled={disabled}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-employee_benefit_id`}>{t('car_benefit')}</Label>
            <SettingsSelect id={`${idPrefix}-employee_benefit_id`} value={value.employee_benefit_id} onChange={set('employee_benefit_id')} disabled={disabled}>
              <option value="">{t('car_benefit_none')}</option>
              {benefits.map((b) => (
                <option key={b.employee_benefit_id} value={b.employee_benefit_id}>
                  {[b.employee_name, b.description, t('car_benefit_from', { date: formatDate(b.valid_from) })].filter(Boolean).join(', ')}
                </option>
              ))}
            </SettingsSelect>
          </div>
        </div>
        {benefits.length === 0 && <p className="text-xs text-muted-foreground">{t('car_benefit_empty')}</p>}
      </div>
    )
  }
  return null
}

'use client'

import { useEffect, useMemo, useState } from 'react'
import { Label } from '@/components/ui/label'
import DimensionCombobox from '@/components/dimensions/DimensionCombobox'
import {
  fetchDimensionsCached,
  type DimensionDto,
} from '@/components/dimensions/types'

interface LineDimensionFieldsProps {
  /** Current dimensions map ({sie_dim_no: object_code}), a line's map or the header default. */
  dimensions: Record<string, string> | undefined
  /** Fired per dimension; `code === null` clears the value. */
  onChange: (sieDimNo: string, code: string | null) => void
  disabled?: boolean
  /** Vertical layout for narrow containers (row popover); default is a 2-col grid. */
  stacked?: boolean
  /** Extra classes merged into the combobox inputs (pass 'h-8' for dense contexts). */
  inputClassName?: string
}

/**
 * While the registry loads (or if the fetch fails) we render the seeded
 * system pair (SIE dims 1/6) so the tagging affordance never disappears:
 * the registry always contains at least these two.
 */
const FALLBACK_FIELDS: { sieDimNo: string; label: string }[] = [
  { sieDimNo: '1', label: 'Kostnadsställe' },
  { sieDimNo: '6', label: 'Projekt' },
]

/**
 * Registry-driven dimension comboboxes used by the voucher form's header
 * default, the per-row tag popover, and the mobile line cards. One combobox
 * per active registry dimension, ordered by sort_order then sie_dim_no (the
 * seeded 1/6 pair sorts first). Labels are the registry dimension names and
 * hardcoded-Swedish fallbacks: the component mounts on the voucher editor,
 * a stays-Swedish surface per .claude/rules/i18n.md (same convention as
 * DimensionCombobox).
 */
export default function LineDimensionFields({
  dimensions,
  onChange,
  disabled,
  stacked,
  inputClassName,
}: LineDimensionFieldsProps) {
  const [registry, setRegistry] = useState<DimensionDto[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchDimensionsCached()
      .then((dims) => {
        if (!cancelled) setRegistry(dims)
      })
      .catch(() => {
        /* keep the hardcoded 1/6 fallback */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const fields = useMemo(() => {
    const active = registry?.filter((d) => d.is_active) ?? []
    if (active.length === 0) return FALLBACK_FIELDS
    return [...active]
      .sort((a, b) => a.sort_order - b.sort_order || a.sie_dim_no - b.sie_dim_no)
      .map((d) => ({ sieDimNo: String(d.sie_dim_no), label: d.name }))
  }, [registry])

  return (
    <div className={stacked ? 'space-y-3' : 'grid grid-cols-2 gap-3'}>
      {fields.map((field) => (
        <div key={field.sieDimNo}>
          <Label className="text-xs text-muted-foreground">{field.label}</Label>
          <div className="mt-1">
            <DimensionCombobox
              sieDimNo={field.sieDimNo}
              value={dimensions?.[field.sieDimNo] ?? null}
              onChange={(code) => onChange(field.sieDimNo, code)}
              disabled={disabled}
              className={inputClassName}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

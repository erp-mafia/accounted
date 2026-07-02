'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import DimensionCombobox from '@/components/dimensions/DimensionCombobox'
import { useCompanySettings } from '@/components/settings/useSettings'
import { fetchDimensions, type DimensionDto } from '@/components/dimensions/types'

export type DimensionFilterValue = {
  /** SIE dimension number as a string ('1' kostnadsställe, '6' projekt). */
  dimNo: string
  /** Selected object code. */
  code: string
}

interface Props {
  value: DimensionFilterValue | null
  onChange: (next: DimensionFilterValue | null) => void
}

/**
 * Per-dimension value filter for the P&L-safe reports (resultatrapport,
 * resultaträkning, huvudbok, KPI). Mounted by FocusedReport next to
 * ReportDateRange, only for catalog entries flagged `dimensions: true`.
 *
 * Renders nothing unless company_settings.dimensions_enabled — companies
 * that never activated dimensions see literally nothing changed.
 *
 * When active it shows a persistent "Filtrerad … — ej fullständig rapport"
 * chip: a dimension-scoped view is a partial view and must never be read as
 * the complete report. Strings are hardcoded Swedish per the report-surface
 * convention (same as DimensionCombobox).
 */
export function DimensionFilter({ value, onChange }: Props) {
  const { settings } = useCompanySettings()
  const [dims, setDims] = useState<DimensionDto[]>([])
  // Which dimension the picker targets while no value is selected yet;
  // once a value is picked, `value.dimNo` is the source of truth.
  const [pendingDimNo, setPendingDimNo] = useState('6')
  const enabled = settings?.dimensions_enabled === true

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetchDimensions()
      .then((rows) => {
        if (!cancelled) setDims(rows)
      })
      .catch(() => {
        // Best-effort: without the registry the filter simply doesn't render.
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  if (!enabled || dims.length === 0) return null

  const activeDimNo = value?.dimNo ?? pendingDimNo
  const activeDim = dims.find((d) => String(d.sie_dim_no) === activeDimNo)

  return (
    <div className="flex flex-col gap-2">
      <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Dimension
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={activeDimNo}
          onValueChange={(dimNo) => {
            // Switching dimension clears the picked value — codes are
            // namespaced per dimension.
            if (value) onChange(null)
            setPendingDimNo(dimNo)
          }}
        >
          <SelectTrigger className="h-10 w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {dims.map((d) => (
              <SelectItem key={d.sie_dim_no} value={String(d.sie_dim_no)}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="w-[200px]">
          <DimensionCombobox
            sieDimNo={activeDimNo}
            value={value?.code ?? null}
            onChange={(code) =>
              onChange(code ? { dimNo: activeDimNo, code } : null)
            }
          />
        </div>
        {value && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onChange(null)}
            aria-label="Rensa dimensionsfilter"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      {value && (
        <Badge variant="warning" className="w-fit">
          Filtrerad: {activeDim?.name ?? `Dim ${value.dimNo}`} {value.code} — ej fullständig rapport
        </Badge>
      )}
    </div>
  )
}

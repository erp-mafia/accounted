'use client'

import { Label } from '@/components/ui/label'
import DimensionCombobox from '@/components/dimensions/DimensionCombobox'

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
 * The Kostnadsställe + Projekt combobox pair (SIE dims 1/6) used by the
 * voucher form's header default, the per-row tag popover, and the mobile line
 * cards. Labels are the seeded system-dimension names and hardcoded Swedish:
 * the component mounts on the voucher editor, a stays-Swedish surface per
 * .claude/rules/i18n.md (same convention as DimensionCombobox).
 */
export default function LineDimensionFields({
  dimensions,
  onChange,
  disabled,
  stacked,
  inputClassName,
}: LineDimensionFieldsProps) {
  return (
    <div className={stacked ? 'space-y-3' : 'grid grid-cols-2 gap-3'}>
      <div>
        <Label className="text-xs text-muted-foreground">Kostnadsställe</Label>
        <div className="mt-1">
          <DimensionCombobox
            sieDimNo="1"
            value={dimensions?.['1'] ?? null}
            onChange={(code) => onChange('1', code)}
            disabled={disabled}
            className={inputClassName}
          />
        </div>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Projekt</Label>
        <div className="mt-1">
          <DimensionCombobox
            sieDimNo="6"
            value={dimensions?.['6'] ?? null}
            onChange={(code) => onChange('6', code)}
            disabled={disabled}
            className={inputClassName}
          />
        </div>
      </div>
    </div>
  )
}

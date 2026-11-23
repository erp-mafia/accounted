'use client'

import { useTranslations } from 'next-intl'
import { Label } from '@/components/ui/label'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ASSET_ACQUISITION_TYPES } from '@/lib/bokslut/assets/acquisition-type'
import type { AssetAcquisitionType } from '@/types'

interface AssetAcquisitionTypeFieldProps {
  id: string
  value: AssetAcquisitionType
  onChange: (value: AssetAcquisitionType) => void
  disabled?: boolean
}

/**
 * How the asset came onto the books: the row it gets in the årsredovisning
 * note on anläggningstillgångar. Shared by the create and the edit dialog.
 */
export function AssetAcquisitionTypeField({ id, value, onChange, disabled }: AssetAcquisitionTypeFieldProps) {
  const t = useTranslations('assets.acquisition')
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{t('label')}</Label>
        <HelpPopover>{t('help')}</HelpPopover>
      </div>
      <Select value={value} onValueChange={(next) => onChange(next as AssetAcquisitionType)} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ASSET_ACQUISITION_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {t(type)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

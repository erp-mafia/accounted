'use client'

import { CalendarViewMode } from '@/types'
import { VIEW_MODE_LABELS } from '@/lib/calendar/utils'
import { SegmentedControl } from '@/components/ui/segmented-control'

interface ViewModeSelectorProps {
  viewMode: CalendarViewMode
  onViewModeChange: (mode: CalendarViewMode) => void
}

export function ViewModeSelector({ viewMode, onViewModeChange }: ViewModeSelectorProps) {
  const modes: CalendarViewMode[] = ['month', 'week', 'day']

  return (
    <SegmentedControl
      value={viewMode}
      onChange={onViewModeChange}
      options={modes.map((mode) => ({ value: mode, label: VIEW_MODE_LABELS[mode] }))}
      aria-label="Kalendervy"
    />
  )
}

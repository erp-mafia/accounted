'use client'

import type { KeyboardEvent } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PALETTE_VALUES, type Palette } from '@/lib/theme/palettes'

interface PalettePickerProps {
  value: Palette
  onChange: (palette: Palette) => void
  labels: Record<Palette, string>
  'aria-label': string
}

export function PalettePicker({
  value,
  onChange,
  labels,
  'aria-label': ariaLabel,
}: PalettePickerProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const direction =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0

    if (direction === 0) return

    event.preventDefault()
    const currentIndex = PALETTE_VALUES.indexOf(value)
    const nextIndex =
      (currentIndex + direction + PALETTE_VALUES.length) % PALETTE_VALUES.length
    const nextPalette = PALETTE_VALUES[nextIndex]
    onChange(nextPalette)
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-palette-option="${nextPalette}"]`)
      ?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4"
    >
      {PALETTE_VALUES.map((palette) => {
        const selected = palette === value
        return (
          <button
            key={palette}
            data-palette-option={palette}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(palette)}
            className={cn(
              'flex min-h-10 items-center gap-1 rounded-lg border px-2 py-2 text-left text-xs transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              selected
                ? 'border-foreground bg-secondary/60 text-foreground'
                : 'border-border text-muted-foreground hover:bg-secondary/35 hover:text-foreground',
            )}
          >
            <span
              data-palette-preview={palette}
              aria-hidden="true"
              className="flex h-6 w-8 shrink-0 items-center gap-1 rounded-full border border-border bg-background px-1"
            >
              <span className="h-2 w-2 rounded-full bg-primary" />
              <span className="h-2 w-2 rounded-full border border-border bg-secondary" />
            </span>
            <span className="min-w-0 truncate">{labels[palette]}</span>
            <Check
              aria-hidden="true"
              className={cn('ml-auto h-3 w-3 shrink-0', selected ? 'opacity-100' : 'opacity-0')}
            />
          </button>
        )
      })}
    </div>
  )
}

'use client'

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { POPOVER_SURFACE_CLASS, POPOVER_ENTER_CLASS } from '@/components/ui/popover-surface'
import { useComboboxNavigation } from '@/lib/hooks/use-combobox-navigation'

export interface KommunRate {
  kommun: string
  totalRate: number
  tableNumber: number
}

interface MunicipalityComboboxProps {
  value: string
  /** Fired when a municipality is committed from the list (with its derived table). */
  onSelect: (kommun: string, tableNumber: number, totalRate: number) => void
  /** Fired on free-text edits that don't match a known municipality. */
  onChange?: (kommun: string) => void
  /** Income year: drives which year's municipal rates are fetched. */
  year: number
  disabled?: boolean
  id?: string
  className?: string
}

const MAX_RESULTS = 50

/**
 * Searchable folkbokföringskommun picker. Loads the kommun → skattetabell map
 * from /api/salary/tax-tables/kommuner once, so picking a town auto-fills the
 * tax table. Degrades to a plain free-text field if the list can't be fetched.
 */
export default function MunicipalityCombobox({
  value,
  onSelect,
  onChange,
  year,
  disabled,
  id,
  className,
}: MunicipalityComboboxProps) {
  const t = useTranslations('salary_employee')
  const [search, setSearch] = useState(value)
  const [isOpen, setIsOpen] = useState(false)
  const [kommuner, setKommuner] = useState<KommunRate[]>([])
  const [loadFailed, setLoadFailed] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Sync external value changes into the search field
  useEffect(() => {
    setSearch(value)
  }, [value])

  // Load the municipality list once per year
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/salary/tax-tables/kommuner?year=${year}`)
        if (!res.ok) throw new Error(`status ${res.status}`)
        const { data } = await res.json()
        if (!cancelled) setKommuner(data.kommuner ?? [])
      } catch {
        if (!cancelled) setLoadFailed(true)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [year])

  const filtered = useMemo(() => {
    const trimmed = search.trim().toLowerCase()
    if (!trimmed) return kommuner.slice(0, MAX_RESULTS)
    return kommuner.filter((k) => k.kommun.toLowerCase().includes(trimmed)).slice(0, MAX_RESULTS)
  }, [kommuner, search])

  const select = useCallback(
    (k: KommunRate) => {
      setSearch(k.kommun)
      setIsOpen(false)
      onSelect(k.kommun, k.tableNumber, k.totalRate)
    },
    [onSelect]
  )

  const close = useCallback(() => setIsOpen(false), [])
  const insideRefs = useMemo(() => [containerRef], [])
  const { highlightedIndex, setHighlightedIndex, handleKeyDown } = useComboboxNavigation({
    count: filtered.length,
    isOpen,
    open: () => setIsOpen(true),
    close,
    activate: (index) => {
      // No match: the Enter belongs to the form.
      if (!filtered[index]) return false
      select(filtered[index])
    },
    listRef,
    insideRefs,
  })

  useEffect(() => {
    setHighlightedIndex(0)
  }, [filtered, setHighlightedIndex])

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value
    setSearch(next)
    onChange?.(next)
    if (!isOpen) setIsOpen(true)
  }

  return (
    <div ref={containerRef} className="relative">
      <Input
        id={id}
        value={search}
        onChange={handleInputChange}
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={t('kommun_search_placeholder')}
        autoComplete="off"
        disabled={disabled}
        className={className}
      />

      {isOpen && filtered.length > 0 && (
        <div
          ref={listRef}
          className={`absolute z-50 top-full left-0 mt-1 w-full max-h-[300px] overflow-y-auto ${POPOVER_SURFACE_CLASS} ${POPOVER_ENTER_CLASS}`}
        >
          {filtered.map((k, i) => {
            const isHighlighted = i === highlightedIndex
            return (
              <button
                key={k.kommun}
                type="button"
                data-highlighted={isHighlighted}
                className={`w-full text-left px-3 py-1.5 text-sm cursor-pointer flex items-baseline justify-between gap-2 ${
                  isHighlighted ? 'bg-primary/10 text-primary' : 'hover:bg-secondary/60'
                }`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  select(k)
                }}
                onMouseEnter={() => setHighlightedIndex(i)}
              >
                <span className="min-w-0 break-words">{k.kommun}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {t('kommun_table_number', { number: k.tableNumber })}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {loadFailed && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('kommun_load_failed')}
        </p>
      )}
    </div>
  )
}

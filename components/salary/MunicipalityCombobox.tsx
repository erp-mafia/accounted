'use client'

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Input } from '@/components/ui/input'

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
  const [search, setSearch] = useState(value)
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
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

  useEffect(() => {
    setHighlightedIndex(0)
  }, [filtered])

  useEffect(() => {
    if (!isOpen || !listRef.current) return
    const el = listRef.current.querySelector('[data-highlighted="true"]')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex, isOpen])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent | TouchEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
    }
  }, [])

  const select = useCallback(
    (k: KommunRate) => {
      setSearch(k.kommun)
      setIsOpen(false)
      onSelect(k.kommun, k.tableNumber, k.totalRate)
    },
    [onSelect]
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setIsOpen(true)
        e.preventDefault()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightedIndex((p) => Math.min(p + 1, filtered.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightedIndex((p) => Math.max(p - 1, 0))
        break
      case 'Enter':
        if (filtered[highlightedIndex]) {
          e.preventDefault()
          select(filtered[highlightedIndex])
        }
        break
      case 'Escape':
        e.preventDefault()
        setIsOpen(false)
        break
    }
  }

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
        placeholder="Sök kommun…"
        autoComplete="off"
        disabled={disabled}
        className={className}
      />

      {isOpen && filtered.length > 0 && (
        <div
          ref={listRef}
          className="absolute z-50 top-full left-0 mt-1 w-full max-h-[300px] overflow-y-auto rounded-md border border-input bg-card shadow-md"
        >
          {filtered.map((k, i) => {
            const isHighlighted = i === highlightedIndex
            return (
              <button
                key={k.kommun}
                type="button"
                data-highlighted={isHighlighted}
                className={`w-full text-left px-3 py-1.5 text-sm cursor-pointer flex items-baseline justify-between gap-2 ${
                  isHighlighted ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50'
                }`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  select(k)
                }}
                onMouseEnter={() => setHighlightedIndex(i)}
              >
                <span className="min-w-0 break-words">{k.kommun}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  Tabell {k.tableNumber}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {loadFailed && (
        <p className="mt-1 text-xs text-muted-foreground">
          Kunde inte hämta kommunlistan: skriv kommunnamnet och ange skattetabellen manuellt.
        </p>
      )}
    </div>
  )
}

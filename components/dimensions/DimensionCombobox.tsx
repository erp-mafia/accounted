'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  DIMENSION_CODE_PATTERN,
  fetchDimensions,
  type DimensionValueDto,
} from '@/components/dimensions/types'

interface DimensionComboboxProps {
  /** SIE dimension number as a string ('1' = kostnadsställe, '6' = projekt). */
  sieDimNo: string
  /** Selected object code, or null when the line carries no value for this dim. */
  value: string | null
  onChange: (code: string | null) => void
  disabled?: boolean
  /** Extra classes merged into the trigger Input (callers pass `h-8` for dense rows). */
  className?: string
}

/**
 * Searchable picker for dimension values — sibling of
 * components/bookkeeping/AccountCombobox.tsx and deliberately mirrors its
 * interaction model: plain Input trigger, keyboard-first dropdown
 * (arrows/Enter/Escape), close-on-outside-click, and an inline "Skapa ny…"
 * affordance that creates the value via POST /api/dimensions/[id]/values and
 * selects it.
 *
 * Fetches the registry lazily on first open and filters client-side (value
 * lists are small). Only active values are offered — archived codes stay
 * pickable in history but are never suggested.
 *
 * Strings are hardcoded Swedish per the AccountCombobox convention: the
 * component mounts on the voucher editor (PR3), a stays-Swedish surface per
 * .claude/rules/i18n.md.
 */
export default function DimensionCombobox({
  sieDimNo,
  value,
  onChange,
  disabled,
  className,
}: DimensionComboboxProps) {
  const [search, setSearch] = useState(value ?? '')
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const [dimensionId, setDimensionId] = useState<string | null>(null)
  const [values, setValues] = useState<DimensionValueDto[]>([])
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Refs mirroring the committed `value` prop and the fetched values. The
  // blur timeout below runs 150ms after render, so reading `value`/`values`
  // directly would act on a stale snapshot — a selection landing during that
  // window (updating the prop via onChange) must win over the revert.
  const committedRef = useRef(value)
  const valuesRef = useRef(values)

  // Sync external value changes into the search field
  useEffect(() => {
    committedRef.current = value
    setSearch(value ?? '')
  }, [value])

  useEffect(() => {
    valuesRef.current = values
  }, [values])

  const loadValues = useCallback(async () => {
    setLoadState('loading')
    try {
      const dims = await fetchDimensions()
      const dim = dims.find((d) => String(d.sie_dim_no) === sieDimNo)
      setDimensionId(dim?.id ?? null)
      setValues(dim?.values.filter((v) => v.is_active) ?? [])
      setLoadState('loaded')
    } catch {
      setLoadState('error')
    }
  }, [sieDimNo])

  const openDropdown = useCallback(() => {
    setIsOpen(true)
    setCreateError(null)
    if (loadState === 'idle') void loadValues()
  }, [loadState, loadValues])

  const filteredValues = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return values
    return values.filter(
      (v) =>
        v.code.toLowerCase().includes(term) || v.name.toLowerCase().includes(term),
    )
  }, [values, search])

  // Inline create is offered when the typed text is a valid new code.
  const createCandidate = useMemo(() => {
    const term = search.trim()
    if (!term || !dimensionId) return null
    if (!DIMENSION_CODE_PATTERN.test(term)) return null
    if (values.some((v) => v.code.toLowerCase() === term.toLowerCase())) return null
    return term
  }, [search, values, dimensionId])

  // Keyboard list: matching values first, the create affordance last.
  const optionCount = filteredValues.length + (createCandidate ? 1 : 0)

  useEffect(() => {
    setHighlightedIndex(0)
  }, [filteredValues, createCandidate])

  useEffect(() => {
    if (!isOpen || !listRef.current) return
    const highlighted = listRef.current.querySelector('[data-highlighted="true"]')
    if (highlighted) highlighted.scrollIntoView({ block: 'nearest' })
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

  const selectValue = useCallback(
    (code: string) => {
      onChange(code)
      setSearch(code)
      setIsOpen(false)
    },
    [onChange],
  )

  const createValue = useCallback(
    async (code: string) => {
      if (!dimensionId || isCreating) return
      setIsCreating(true)
      setCreateError(null)
      try {
        const res = await fetch(`/api/dimensions/${dimensionId}/values`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, name: code }),
        })
        const json = await res.json().catch(() => null)
        if (!res.ok) {
          setCreateError(getErrorMessage(json, { locale: 'sv' }))
          return
        }
        const created: DimensionValueDto = json?.data ?? {
          id: code,
          code,
          name: code,
          is_active: true,
          start_date: null,
          end_date: null,
        }
        setValues((prev) => [...prev, created].sort((a, b) => a.code.localeCompare(b.code, 'sv')))
        selectValue(created.code)
      } finally {
        setIsCreating(false)
      }
    },
    [dimensionId, isCreating, selectValue],
  )

  const activateOption = useCallback(
    (index: number) => {
      if (index < filteredValues.length) {
        selectValue(filteredValues[index].code)
      } else if (createCandidate) {
        void createValue(createCandidate)
      }
    },
    [filteredValues, createCandidate, selectValue, createValue],
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        openDropdown()
        e.preventDefault()
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightedIndex((prev) => Math.min(prev + 1, optionCount - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightedIndex((prev) => Math.max(prev - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (optionCount > 0) activateOption(highlightedIndex)
        break
      case 'Escape':
        e.preventDefault()
        setIsOpen(false)
        break
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value)
    setCreateError(null)
    if (!isOpen) openDropdown()
  }

  const handleBlur = () => {
    setIsOpen(false)
    // Small delay so a dropdown mousedown fires first (same trick as
    // AccountCombobox — option clicks preventDefault, so they never blur).
    // An emptied field clears the dimension; anything that isn't a known
    // code reverts to the committed value. Committed value and values are
    // read through refs so a selection that lands during the 150ms window
    // wins over the revert (the closure's render snapshot would be stale).
    const snapshot = search
    setTimeout(() => {
      const committed = committedRef.current
      const trimmed = snapshot.trim()
      if (!trimmed) {
        setSearch('')
        if (committed !== null) onChange(null)
        return
      }
      if (trimmed !== committed && !valuesRef.current.some((v) => v.code === trimmed)) {
        setSearch(committed ?? '')
      }
    }, 150)
  }

  return (
    <div ref={containerRef} className="relative">
      <Input
        value={search}
        onChange={handleInputChange}
        onFocus={openDropdown}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder="Sök värde…"
        disabled={disabled}
        className={`font-mono ${className ?? ''}`.trim()}
        autoComplete="off"
      />

      {/* Dropdown */}
      {isOpen && !disabled && (
        <div
          ref={listRef}
          className="absolute z-50 top-full left-0 mt-1 min-w-[16rem] w-[max(100%,20rem)] max-h-[300px] overflow-y-auto rounded-md border border-input bg-card shadow-md"
        >
          {loadState === 'loading' && (
            <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Laddar…
            </div>
          )}
          {loadState === 'error' && (
            <p className="px-2 py-2 text-sm text-muted-foreground">
              Kunde inte hämta värden.
            </p>
          )}
          {loadState === 'loaded' && optionCount === 0 && (
            <p className="px-2 py-2 text-sm text-muted-foreground">
              Hittade inget värde som matchar.
            </p>
          )}
          {loadState === 'loaded' &&
            filteredValues.map((item, index) => {
              const isHighlighted = index === highlightedIndex
              return (
                <button
                  key={item.id}
                  type="button"
                  data-highlighted={isHighlighted}
                  className={`w-full text-left px-2 py-1.5 text-sm cursor-pointer flex items-baseline gap-2 ${
                    isHighlighted ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50'
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    selectValue(item.code)
                  }}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <span className="font-mono shrink-0">{item.code}</span>
                  <span className="flex-1 min-w-0 break-words text-muted-foreground">
                    {item.name !== item.code ? item.name : ''}
                  </span>
                </button>
              )
            })}
          {loadState === 'loaded' && createCandidate && (
            <button
              type="button"
              data-highlighted={highlightedIndex === filteredValues.length}
              className={`w-full text-left px-2 py-1.5 text-sm cursor-pointer flex items-center gap-2 border-t border-input ${
                highlightedIndex === filteredValues.length
                  ? 'bg-primary/10 text-primary'
                  : 'hover:bg-muted/50'
              }`}
              onMouseDown={(e) => {
                e.preventDefault()
                void createValue(createCandidate)
              }}
              onMouseEnter={() => setHighlightedIndex(filteredValues.length)}
            >
              {isCreating ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate">Skapa ny &quot;{createCandidate}&quot;</span>
            </button>
          )}
          {createError && (
            <p className="px-2 py-1.5 text-xs text-destructive border-t border-input">
              {createError}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

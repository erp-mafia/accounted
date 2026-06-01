'use client'

import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { SSYK_CODES, findSsykLabel } from '@/lib/salary/ssyk-codes'

interface SsykComboboxProps {
  /** Form field name for the submitted 4-digit code. */
  name?: string
  /** Initial 4-digit code. */
  defaultValue?: string
  disabled?: boolean
  id?: string
}

const MAX_RESULTS = 60

function displayFor(code: string): string {
  const label = findSsykLabel(code)
  return label ? `${code} — ${label}` : code
}

/**
 * Searchable picker for SSYK 2012 occupation codes (the SLP yrkeskod field).
 * Type a code or part of an occupation title; the submitted value is always the
 * 4-digit code. Modeled on BankNameCombobox (no external combobox dependency).
 */
export function SsykCombobox({ name = 'ssyk_code', defaultValue = '', disabled, id }: SsykComboboxProps) {
  const initial = defaultValue.trim()
  const [code, setCode] = useState(initial)
  const [query, setQuery] = useState(initial ? displayFor(initial) : '')
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const raw = query.trim().toLowerCase()
  const digits = raw.replace(/\D/g, '')
  const filtered = (raw
    ? SSYK_CODES.filter((c) => (digits ? c.code.includes(digits) : false) || c.label.toLowerCase().includes(raw))
    : SSYK_CODES
  ).slice(0, MAX_RESULTS)

  useEffect(() => {
    if (!isOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        // Snap the field back to the canonical label when a code is committed.
        if (code) setQuery(displayFor(code))
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen, code])

  useEffect(() => {
    if (highlightedIndex < 0 || !listRef.current) return
    const item = listRef.current.children[highlightedIndex] as HTMLElement
    item?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex])

  function select(c: { code: string; label: string }) {
    setCode(c.code)
    setQuery(displayFor(c.code))
    setIsOpen(false)
    inputRef.current?.focus()
  }

  function handleInputChange(v: string) {
    setQuery(v)
    setHighlightedIndex(-1)
    if (!isOpen) setIsOpen(true)
    // A leading 4-digit token counts as a direct code entry; otherwise the code
    // is only set by picking from the list.
    const match = v.trim().match(/^(\d{4})\b/)
    setCode(match ? match[1] : '')
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setIsOpen(true)
      e.preventDefault()
      return
    }
    if (!isOpen) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightedIndex((i) => (i < filtered.length - 1 ? i + 1 : 0))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightedIndex((i) => (i > 0 ? i - 1 : filtered.length - 1))
        break
      case 'Enter':
        if (highlightedIndex >= 0 && filtered[highlightedIndex]) {
          e.preventDefault()
          select(filtered[highlightedIndex])
        }
        break
      case 'Escape':
        setIsOpen(false)
        if (code) setQuery(displayFor(code))
        break
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <input type="hidden" name={name} value={code} />
      <Input
        ref={inputRef}
        id={id}
        type="text"
        placeholder="Sök kod eller yrke, t.ex. 2611 eller revisor"
        value={query}
        disabled={disabled}
        onChange={(e) => handleInputChange(e.target.value)}
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-expanded={isOpen}
        aria-autocomplete="list"
        aria-controls="ssyk-listbox"
        autoComplete="off"
      />
      {isOpen && !disabled && (
        <ul
          ref={listRef}
          id="ssyk-listbox"
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-popover shadow-md"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">Inga träffar</li>
          ) : (
            filtered.map((c, i) => (
              <li
                key={c.code}
                role="option"
                aria-selected={highlightedIndex === i}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer transition-colors',
                  highlightedIndex === i && 'bg-accent text-accent-foreground',
                )}
                onMouseEnter={() => setHighlightedIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  select(c)
                }}
              >
                <span className="tabular-nums text-muted-foreground">{c.code}</span>
                <span className="truncate">{c.label}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}

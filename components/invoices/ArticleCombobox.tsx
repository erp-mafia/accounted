'use client'

import { useState, useRef, useEffect, useMemo, useCallback, useId } from 'react'
import { Input } from '@/components/ui/input'
import { foldText } from '@/lib/bookkeeping/account-search'

export interface ArticleComboboxItem {
  id: string
  article_number: string | null
  name: string
}

interface ArticleComboboxProps {
  /** Selected article id, or null for a free-text line. */
  value: string | null
  /** Already sorted by the caller (sortArticles). */
  articles: ArticleComboboxItem[]
  /** Receives the picked article id, or 'none' for the free-text option. */
  onChange: (value: string) => void
  /** Label for the pinned free-text option ("Egen rad"). */
  freeTextLabel: string
  /** Trigger placeholder when nothing is selected. */
  placeholder: string
  /** Empty-state text when the search matches nothing. */
  emptyLabel: string
  disabled?: boolean
  ariaLabel?: string
}

function articleLabel(a: ArticleComboboxItem): string {
  return a.article_number ? `${a.article_number}: ${a.name}` : a.name
}

/**
 * Searchable article picker for invoice lines. Replaces the plain Select whose
 * only matching was Radix's label-prefix typeahead: for numbered articles that
 * meant number-only lookup, and typing "skruv" found nothing. Free-text search
 * here matches both name and article number, diacritics-folded (foldText), on
 * the already-loaded article list. Same input-trigger dropdown pattern as
 * AccountCombobox.
 */
export default function ArticleCombobox({
  value,
  articles,
  onChange,
  freeTextLabel,
  placeholder,
  emptyLabel,
  disabled = false,
  ariaLabel,
}: ArticleComboboxProps) {
  const selected = value ? articles.find((a) => a.id === value) ?? null : null
  // Free-text lines display the "Egen rad" label, matching the Select this
  // replaces (which pinned value 'none' and never showed a placeholder).
  const selectedLabel = selected ? articleLabel(selected) : freeTextLabel

  const [search, setSearch] = useState(selectedLabel)
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  // aria-activedescendant is only announced once the user has explicitly
  // arrowed into the list: before that, the visual highlight is a hint for
  // Enter behavior, not a selection a screen reader should read out.
  const [hasArrowNavigated, setHasArrowNavigated] = useState(false)
  const listboxId = useId()
  // Typing narrows the list; a fresh focus shows everything so the field also
  // works as a browse dropdown, exactly like the Select it replaces.
  const [hasTyped, setHasTyped] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // True while a pointer interaction is what is about to focus the field.
  // Keyboard focus (Tab) must NOT auto-open: with the list open a bare Enter
  // would select the highlighted row, and the old Select treated Tab+Enter as
  // a no-op. Pointer focus keeps the click-to-browse behavior.
  const pointerDownRef = useRef(false)

  // Sync external value changes (applyArticle, draft restore) into the field.
  useEffect(() => {
    setSearch(selectedLabel)
    // selectedLabel is derived from value + articles; both belong here.
  }, [selectedLabel])

  const filtered = useMemo(() => {
    const q = foldText(search.trim())
    // A committed selection sits in the field as its full label; treating it
    // as a filter would show exactly one row. Browse instead.
    if (!q || !hasTyped) return articles
    return articles.filter((a) =>
      foldText(`${a.article_number ?? ''} ${a.name}`).includes(q),
    )
  }, [articles, search, hasTyped])

  // Options list: the free-text "Egen rad" choice stays pinned on top.
  type Option = { key: string; label: string; muted: boolean }
  const options = useMemo<Option[]>(
    () => [
      { key: 'none', label: freeTextLabel, muted: true },
      ...filtered.map((a) => ({ key: a.id, label: articleLabel(a), muted: false })),
    ],
    [filtered, freeTextLabel],
  )

  // While typing, highlight the first actual match (index 1: index 0 is the
  // pinned "Egen rad"), so type-and-Enter picks the searched article instead
  // of silently detaching the line to free text.
  useEffect(() => {
    setHighlightedIndex(hasTyped && filtered.length > 0 ? 1 : 0)
  }, [options.length, search, hasTyped, filtered.length])

  // Opening on a committed selection starts the highlight ON that selection,
  // like the Select this replaces, so Enter re-confirms instead of switching.
  const openList = useCallback(() => {
    const currentKey = value ?? 'none'
    const idx = options.findIndex((o) => o.key === currentKey)
    setHighlightedIndex(idx >= 0 ? idx : 0)
    setHasArrowNavigated(false)
    setIsOpen(true)
  }, [options, value])

  useEffect(() => {
    if (!isOpen || !listRef.current) return
    listRef.current
      .querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: 'nearest' })
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
    (option: Option) => {
      // Re-selecting the committed value is a no-op close: applyArticle
      // re-applies the article's description/price/unit, which would clobber
      // per-line edits, and re-selecting "Egen rad" on a free-text line would
      // needlessly null the article link. The old Radix Select behaved the
      // same (onValueChange only fires on an actual change).
      if (option.key !== (value ?? 'none')) {
        onChange(option.key)
      }
      setSearch(option.label)
      setHasTyped(false)
      setIsOpen(false)
    },
    [onChange, value],
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
        e.preventDefault()
        openList()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHasArrowNavigated(true)
        setHighlightedIndex((prev) => Math.min(prev + 1, options.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHasArrowNavigated(true)
        setHighlightedIndex((prev) => Math.max(prev - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (options[highlightedIndex]) select(options[highlightedIndex])
        break
      case 'Escape':
        e.preventDefault()
        setIsOpen(false)
        break
    }
  }

  const handleBlur = () => {
    setIsOpen(false)
    // Delay so a dropdown mousedown wins, then snap the field back to the
    // committed selection: a half-typed search must not linger as a label.
    setTimeout(() => {
      setSearch(selectedLabel)
      setHasTyped(false)
    }, 150)
  }

  return (
    <div ref={containerRef} className="relative">
      <Input
        value={search}
        onChange={(e) => {
          setSearch(e.target.value)
          setHasTyped(true)
          setHasArrowNavigated(false)
          if (!isOpen) setIsOpen(true)
        }}
        onPointerDown={() => {
          pointerDownRef.current = true
        }}
        onClick={() => {
          // Clicking an already-focused field reopens the list (onFocus will
          // not fire again in that case).
          if (!isOpen) openList()
        }}
        onFocus={(e) => {
          setHasTyped(false)
          if (pointerDownRef.current) openList()
          pointerDownRef.current = false
          // Typing should replace the committed label, not append to it.
          e.currentTarget.select()
        }}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        disabled={disabled}
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          isOpen && hasArrowNavigated && options[highlightedIndex]
            ? `${listboxId}-opt-${highlightedIndex}`
            : undefined
        }
        aria-label={ariaLabel}
      />

      {isOpen && !disabled && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          className="absolute z-50 top-full left-0 mt-1 w-full min-w-[16rem] max-h-[300px] overflow-y-auto rounded-lg border border-input bg-card shadow-md"
        >
          {options.map((option, index) => (
            <button
              key={option.key}
              id={`${listboxId}-opt-${index}`}
              type="button"
              role="option"
              aria-selected={option.key === (value ?? 'none')}
              tabIndex={-1}
              data-highlighted={index === highlightedIndex}
              className={`w-full text-left px-2 py-1.5 text-sm cursor-pointer ${
                index === highlightedIndex ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50'
              } ${option.muted ? 'text-muted-foreground' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                select(option)
              }}
              onMouseEnter={() => setHighlightedIndex(index)}
            >
              {option.label}
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">{emptyLabel}</p>
          )}
        </div>
      )}
    </div>
  )
}

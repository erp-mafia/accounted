'use client'

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { useTranslations } from 'next-intl'
import { CheckIcon, MagnifyingGlassIcon } from '@/components/icons'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  PURCHASE_CATEGORIES,
  PURCHASE_CATEGORY_GROUPS,
  portCategoryFor,
  purchaseCategoryGroupNameKey,
  purchaseCategoryNameKey,
  type PurchaseCategoryCode,
} from '@/lib/categories/purchase-categories'
import { buildPurchaseCategorySearchIndex, searchPurchaseCategories } from '@/lib/categories/purchase-category-search'

/** A row of the "Förslag" section: a category and why it is there (a level or a source, in words). */
export interface PurchaseCategorySuggestion {
  code: PurchaseCategoryCode
  hint: string
}

interface Option {
  /** Unique within the listbox: a code can sit in Förslag and in its group at once. */
  key: string
  code: PurchaseCategoryCode
  hint?: string
}

/**
 * The category list of "Vad köptes?": a search field over an always-open
 * listbox. Empty, it shows Förslag (the proposal, then what the evidence
 * also points to) above every category under its group; typed into, the
 * matches best first (lib/categories/purchase-category-search.ts).
 *
 * The field keeps focus: arrow keys move the active option
 * (aria-activedescendant), Enter picks it, and Enter on the option already
 * picked submits. Escape is the dialog's. Picking only marks the choice;
 * saving stays the dialog's button.
 */
export function PurchaseCategoryPicker({
  value,
  onPick,
  onSubmit,
  suggestions,
  inputRef,
}: {
  /** The picked code, or '' before anything is picked. */
  value: PurchaseCategoryCode | ''
  onPick: (code: PurchaseCategoryCode) => void
  /** Enter on the option already picked: save. */
  onSubmit: () => void
  suggestions: readonly PurchaseCategorySuggestion[]
  inputRef?: Ref<HTMLInputElement>
}) {
  const t = useTranslations('purchase_category_picker')
  const tc = useTranslations('purchaseCategories')
  const listId = useId()
  const [query, setQuery] = useState('')
  const searching = query.trim().length > 0

  const index = useMemo(
    () =>
      buildPurchaseCategorySearchIndex({
        category: (code) => tc(purchaseCategoryNameKey(code)),
        group: (group) => tc(purchaseCategoryGroupNameKey(group)),
      }),
    [tc],
  )

  // Every selectable row in display order: what the arrow keys walk.
  const options = useMemo<Option[]>(() => {
    if (searching) {
      return searchPurchaseCategories(index, query).map((code) => ({
        key: `r-${code}`,
        code,
        hint: tc(purchaseCategoryGroupNameKey(portCategoryFor(code))),
      }))
    }
    return [
      ...suggestions.map((s) => ({ key: `s-${s.code}`, code: s.code, hint: s.hint })),
      ...PURCHASE_CATEGORIES.map((c) => ({ key: `a-${c.code}`, code: c.code })),
    ]
  }, [searching, index, query, suggestions, tc])
  const position = useMemo(() => new Map(options.map((o, i) => [o.key, i])), [options])

  // Opening lands on the picked category (Förslag first), else the top row.
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.code === value)))
  const activeIndex = Math.min(active, options.length - 1)
  const activeOption = options[activeIndex] ?? null
  const optionId = (key: string) => `${listId}-${key}`
  const activeId = activeOption ? optionId(activeOption.key) : undefined

  // Keyboard moves scroll the active row into view; the pointer never does,
  // or the list would slide under a resting mouse.
  const scrollToActive = useRef(true)
  useEffect(() => {
    if (!scrollToActive.current || !activeId) return
    scrollToActive.current = false
    document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  function move(next: number) {
    scrollToActive.current = true
    setActive(Math.max(0, Math.min(options.length - 1, next)))
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(activeIndex + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(activeIndex - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!activeOption) return
      if (activeOption.code === value) onSubmit()
      else onPick(activeOption.code)
    }
  }

  const renderOption = (option: Option) => {
    const i = position.get(option.key) ?? 0
    const picked = option.code === value
    return (
      <div
        key={option.key}
        id={optionId(option.key)}
        role="option"
        aria-selected={picked}
        // The field keeps focus; a click only picks.
        onMouseDown={(e) => e.preventDefault()}
        onMouseMove={() => {
          if (i !== activeIndex) setActive(i)
        }}
        onClick={() => {
          setActive(i)
          onPick(option.code)
        }}
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-[13px] transition-colors pointer-coarse:py-3',
          i === activeIndex && 'bg-secondary',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{tc(purchaseCategoryNameKey(option.code))}</span>
        {option.hint && <span className="max-w-[50%] shrink-0 truncate text-xs text-muted-foreground">{option.hint}</span>}
        <CheckIcon aria-hidden className={cn('h-4 w-4 shrink-0', picked ? 'opacity-100' : 'opacity-0')} />
      </div>
    )
  }

  const heading = (id: string, label: string, first: boolean) => (
    <div
      id={id}
      role="presentation"
      className={cn('px-2 pb-1 text-xs font-medium text-muted-foreground', first ? 'pt-1' : 'pt-3')}
    >
      {label}
    </div>
  )

  return (
    <div className="space-y-2">
      <div className="relative">
        <MagnifyingGlassIcon aria-hidden className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            scrollToActive.current = true
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          placeholder={t('search_placeholder')}
          aria-label={t('pick')}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          autoComplete="off"
          spellCheck={false}
          className="pl-10"
        />
      </div>

      <div
        id={listId}
        role="listbox"
        aria-label={t('pick')}
        // A fixed height: the dialog is centred, so a list that shrank with the
        // matches would make it jump while typing.
        className="h-[min(20rem,45dvh)] overflow-y-auto p-1 scrollbar-visible"
      >
        {searching ? (
          options.length > 0 ? (
            options.map(renderOption)
          ) : (
            <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">{t('no_match', { query: query.trim() })}</p>
          )
        ) : (
          <>
            {suggestions.length > 0 && (
              <>
                <div role="group" aria-labelledby={`${listId}-suggestions`}>
                  {heading(`${listId}-suggestions`, t('suggestions'), true)}
                  {options.filter((o) => o.key.startsWith('s-')).map(renderOption)}
                </div>
                <div role="presentation" className="-mx-1 my-1 h-px bg-border" />
              </>
            )}
            {PURCHASE_CATEGORY_GROUPS.map((group, g) => (
              <div key={group} role="group" aria-labelledby={`${listId}-${group}`}>
                {heading(`${listId}-${group}`, tc(purchaseCategoryGroupNameKey(group)), g === 0 && suggestions.length === 0)}
                {PURCHASE_CATEGORIES.filter((c) => c.group === group).map((c) =>
                  renderOption({ key: `a-${c.code}`, code: c.code }),
                )}
              </div>
            ))}
          </>
        )}
      </div>

      {/* Screen readers hear how far a search narrowed the list. */}
      <span className="sr-only" aria-live="polite">
        {searching ? t('results_count', { count: options.length }) : ''}
      </span>
      <p className="hidden text-xs text-muted-foreground sm:block pointer-coarse:hidden">{t('keyboard_hint')}</p>
    </div>
  )
}

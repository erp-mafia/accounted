'use client'

import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, useId } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  buildCustomerIndex,
  searchCustomers,
  customerPickerSecondary,
  type SearchableCustomer,
} from '@/lib/customers/search'
import {
  computeDropdownPosition,
  isSameDropdownPosition,
  type DropdownPosition,
} from '@/components/bookkeeping/account-combobox-position'

/**
 * The one customer picker every form uses (invoice editor, recurring
 * schedule, sales order, deadline). Modelled on AccountCombobox: a text input
 * that filters the cached customer list as you type (lib/customers/search),
 * with a portaled, viewport-clamped dropdown that renders only the matches,
 * capped at 50, so opening it costs the same with ten customers or ten
 * thousand (issue #2684).
 *
 * Value contract is the Radix Select it replaces: `value` is a customer id or
 * '', `onChange` fires with the picked id (or '' via the optional "no
 * customer" row). The text in the field is display state only: the selected
 * customer's name until the user types, then the query.
 */

// Shared by every portaled panel instance: only stops propagation so the
// browser's default scrolling still runs on the panel itself.
function stopScrollPropagation(e: Event) {
  e.stopPropagation()
}

/** Keyboard-row sentinel for the optional "no customer" row. */
const NONE_ROW = '__none__'

interface CustomerComboboxProps<T extends SearchableCustomer> {
  value: string
  customers: readonly T[]
  onChange: (customerId: string) => void
  /** Forwarded to the trigger input, for a Label's htmlFor. */
  id?: string
  placeholder?: string
  /** Extra classes merged into the trigger Input (e.g. `h-12 font-display text-base`). */
  className?: string
  /** Ref to the underlying input, so a host can focus the field on a validation error. */
  inputRef?: React.Ref<HTMLInputElement>
  disabled?: boolean
  /** The list is still being fetched: the empty panel says so instead of "no customers". */
  loading?: boolean
  loadingLabel?: string
  /** Shown when the host has no customers at all (not when a search finds none). */
  emptyLabel?: string
  /**
   * When provided, a "Skapa kund" affordance appears in the no-match state,
   * with the current search string so the host can prefill the create form.
   */
  onCreateCustomer?: (prefill: string) => void
  /** When provided, a first row with this label clears the selection (optional pickers). */
  noneLabel?: string
  /**
   * An id that stays selectable even when archived: the customer already on
   * the draft or schedule being edited. The current `value` is always kept.
   */
  keepId?: string | null
  'aria-required'?: boolean
  'aria-invalid'?: boolean
}

export default function CustomerCombobox<T extends SearchableCustomer>({
  value,
  customers,
  onChange,
  id,
  placeholder,
  className,
  inputRef,
  disabled = false,
  loading = false,
  loadingLabel,
  emptyLabel,
  onCreateCustomer,
  noneLabel,
  keepId,
  'aria-required': ariaRequired,
  'aria-invalid': ariaInvalid,
}: CustomerComboboxProps<T>) {
  const t = useTranslations('customer_picker')
  // What the user has typed since the list opened. While `queryActive` is
  // false the field shows the selected customer's name and the list shows
  // everyone, so focusing a field that already holds "Anna Andersson" browses
  // the register instead of filtering it down to that one row.
  const [typed, setTyped] = useState('')
  const [queryActive, setQueryActive] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  // The portaled dropdown panel. It is not a DOM descendant of containerRef,
  // so outside-click detection must check it separately.
  const portalPanelRef = useRef<HTMLDivElement | null>(null)
  const [dropdownPos, setDropdownPos] = useState<DropdownPosition | null>(null)
  const listId = useId()
  // Whether the user has typed or arrow-navigated since the field was focused.
  // Enter only selects the highlighted row after an actual interaction: a
  // bare Enter on a freshly-focused field must not grab the first customer.
  const hasInteractedRef = useRef(false)

  const index = useMemo(
    () => buildCustomerIndex(customers, { keepIds: [keepId, value] }),
    [customers, keepId, value],
  )
  const selectedName = useMemo(
    () => index.find((e) => e.item.id === value)?.item.name ?? '',
    [index, value],
  )
  const text = queryActive ? typed : selectedName

  const result = useMemo(
    () => searchCustomers(index, queryActive ? typed : ''),
    [index, typed, queryActive],
  )
  const items = result.items
  const capped = result.total > items.length
  const showNoneRow = Boolean(noneLabel) && !queryActive
  // Keyboard order: the optional "no customer" row first, then the matches.
  const rowCount = items.length + (showNoneRow ? 1 : 0)

  // Reset the highlight when the rows change: onto the current selection when
  // browsing (so it scrolls into view), onto the best match when searching.
  useEffect(() => {
    if (queryActive) {
      setHighlightedIndex(0)
      return
    }
    const selectedAt = items.findIndex((c) => c.id === value)
    setHighlightedIndex(selectedAt >= 0 ? selectedAt + (showNoneRow ? 1 : 0) : 0)
  }, [items, value, queryActive, showNoneRow])

  useEffect(() => {
    if (!isOpen || !portalPanelRef.current) return
    const highlighted = portalPanelRef.current.querySelector('[data-highlighted="true"]')
    if (highlighted) highlighted.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex, isOpen])

  // Keep the portaled dropdown glued to the trigger: measure off containerRef
  // when it opens and re-measure while anything scrolls or the window resizes
  // underneath it. Flush with the trigger (preferredWidth 0): a customer row
  // fits the field's own width, and a wider panel would hang out of a dialog.
  const updateDropdownPosition = useCallback(() => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const next = computeDropdownPosition(
      { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
      { width: window.innerWidth, height: window.innerHeight },
      { preferredWidth: 0 },
    )
    setDropdownPos((prev) => (isSameDropdownPosition(prev, next) ? prev : next))
  }, [])

  useLayoutEffect(() => {
    if (!isOpen) return
    updateDropdownPosition()
    const handleScroll = (e: Event) => {
      if (e.target instanceof Node && portalPanelRef.current?.contains(e.target)) return
      updateDropdownPosition()
    }
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', updateDropdownPosition)
    return () => {
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', updateDropdownPosition)
    }
  }, [isOpen, updateDropdownPosition])

  // react-remove-scroll (active inside every modal dialog) preventDefaults
  // wheel/touchmove events that reach document from outside the dialog's DOM
  // tree, and the portaled panel lives outside that tree. Stopping the events
  // at the panel lets the browser scroll it natively.
  const attachPortalPanel = useCallback((el: HTMLDivElement | null) => {
    const prev = portalPanelRef.current
    if (prev) {
      prev.removeEventListener('wheel', stopScrollPropagation)
      prev.removeEventListener('touchmove', stopScrollPropagation)
    }
    portalPanelRef.current = el
    if (el) {
      el.addEventListener('wheel', stopScrollPropagation)
      el.addEventListener('touchmove', stopScrollPropagation)
    }
  }, [])

  // Close when clicking/tapping outside both the trigger and the portaled panel.
  useEffect(() => {
    function handleClickOutside(e: MouseEvent | TouchEvent) {
      const target = e.target as Node
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        !(portalPanelRef.current && portalPanelRef.current.contains(target))
      ) {
        setIsOpen(false)
        setQueryActive(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
    }
  }, [])

  // Closing also abandons the query, so the field shows the selection again.
  const close = useCallback(() => {
    setIsOpen(false)
    setQueryActive(false)
  }, [])

  const select = useCallback(
    (customerId: string) => {
      onChange(customerId)
      close()
    },
    [onChange, close],
  )

  /** The row at a keyboard position: the none sentinel or a customer id. */
  const rowIdAt = (position: number): string | null => {
    if (showNoneRow) {
      if (position === 0) return NONE_ROW
      return items[position - 1]?.id ?? null
    }
    return items[position]?.id ?? null
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        hasInteractedRef.current = true
        setIsOpen(true)
      } else if (e.key === 'Enter') {
        // A text input inside a form submits on Enter; the Select this
        // replaces opened its list instead. Keep that.
        e.preventDefault()
        setIsOpen(true)
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        hasInteractedRef.current = true
        setHighlightedIndex((prev) => Math.min(prev + 1, Math.max(rowCount - 1, 0)))
        break
      case 'ArrowUp':
        e.preventDefault()
        hasInteractedRef.current = true
        setHighlightedIndex((prev) => Math.max(prev - 1, 0))
        break
      case 'Enter': {
        e.preventDefault()
        const rowId = hasInteractedRef.current ? rowIdAt(highlightedIndex) : null
        if (rowId === NONE_ROW) select('')
        else if (rowId) select(rowId)
        else close()
        break
      }
      case 'Escape':
        e.preventDefault()
        close()
        break
      case 'Tab':
        close()
        break
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    hasInteractedRef.current = true
    setTyped(e.target.value)
    setQueryActive(true)
    if (!isOpen) setIsOpen(true)
  }

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    hasInteractedRef.current = false
    setQueryActive(false)
    setIsOpen(true)
    // Typing replaces the current name instead of appending to it.
    e.currentTarget.select()
  }

  // Rows keep focus in the field (mousedown preventDefault), so blur only
  // means the user left: close, and the field falls back to the selection.
  const handleBlur = () => {
    close()
  }

  const trimmedQuery = queryActive ? typed.trim() : ''
  const hasNoCustomers = index.length === 0
  const noMatch = !hasNoCustomers && queryActive && items.length === 0
  const showList = isOpen && !disabled && rowCount > 0
  const showEmpty = isOpen && !disabled && rowCount === 0 && (hasNoCustomers || noMatch)

  const portalPanelStyle: React.CSSProperties | undefined = dropdownPos
    ? {
        left: dropdownPos.left,
        width: dropdownPos.width,
        maxHeight: dropdownPos.maxHeight,
        ...(dropdownPos.top !== undefined ? { top: dropdownPos.top } : { bottom: dropdownPos.bottom }),
      }
    : undefined

  // min-h-10: a 40px touch target per row, the picker's main use is a phone.
  const rowClass = (highlighted: boolean) =>
    cn(
      'flex min-h-10 w-full cursor-pointer flex-col justify-center px-3 py-2 text-left text-sm',
      highlighted ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50',
    )

  const createRow = onCreateCustomer ? (
    <button
      type="button"
      className="mt-2 flex w-full items-center gap-2 rounded-sm border border-input bg-card px-2 py-2 text-left text-sm hover:bg-muted/50"
      onMouseDown={(e) => {
        e.preventDefault()
        close()
        onCreateCustomer(trimmedQuery)
      }}
    >
      <Plus className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        {trimmedQuery ? t('create_customer_named', { query: trimmedQuery }) : t('create_customer')}
      </span>
    </button>
  ) : null

  // data-dialog-companion: DialogContent treats a pointerdown inside a node
  // carrying this attribute as an inside interaction, so clicking the
  // portaled panel never dismisses the dialog hosting it. data-ph-mask keeps
  // names, emails and identifiers out of session replays.
  const listPanel = (
    <div
      ref={attachPortalPanel}
      id={listId}
      role="listbox"
      data-dialog-companion=""
      data-ph-mask=""
      className="fixed z-50 overflow-y-auto overscroll-contain pointer-events-auto rounded-lg border border-input bg-card shadow-md"
      style={portalPanelStyle}
    >
      {showNoneRow && (
        <button
          type="button"
          role="option"
          aria-selected={!value}
          data-highlighted={highlightedIndex === 0}
          className={cn(rowClass(highlightedIndex === 0), 'text-muted-foreground')}
          onMouseDown={(e) => {
            e.preventDefault()
            select('')
          }}
          onMouseEnter={() => setHighlightedIndex(0)}
        >
          {noneLabel}
        </button>
      )}
      {items.map((customer, i) => {
        const position = i + (showNoneRow ? 1 : 0)
        const highlighted = position === highlightedIndex
        const secondary = customerPickerSecondary(customer)
        return (
          <button
            key={customer.id}
            type="button"
            role="option"
            aria-selected={customer.id === value}
            data-highlighted={highlighted}
            className={rowClass(highlighted)}
            onMouseDown={(e) => {
              e.preventDefault()
              select(customer.id)
            }}
            onMouseEnter={() => setHighlightedIndex(position)}
          >
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{customer.name}</span>
              {customer.archived_at && (
                <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
                  {t('archived')}
                </span>
              )}
            </span>
            {secondary && (
              <span className="truncate text-xs text-muted-foreground">{secondary}</span>
            )}
          </button>
        )
      })}
      {capped && (
        <div className="sticky bottom-0 border-t border-input bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t('capped', { shown: items.length, total: result.total })}
        </div>
      )}
    </div>
  )

  const emptyPanel = (
    <div
      ref={attachPortalPanel}
      data-dialog-companion=""
      className="fixed z-50 overflow-y-auto overscroll-contain pointer-events-auto rounded-lg border border-input bg-card p-3 shadow-md"
      style={portalPanelStyle}
    >
      <p className="text-sm text-muted-foreground">
        {hasNoCustomers
          ? loading
            ? (loadingLabel ?? t('loading'))
            : (emptyLabel ?? t('empty'))
          : t('no_match')}
      </p>
      {!loading && createRow}
    </div>
  )

  return (
    <div ref={containerRef} className="relative">
      <Input
        ref={inputRef}
        id={id}
        value={text}
        onChange={handleInputChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? t('search_placeholder')}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        role="combobox"
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-autocomplete="list"
        aria-required={ariaRequired}
        aria-invalid={ariaInvalid}
        className={className}
      />

      {showList && dropdownPos && createPortal(listPanel, document.body)}
      {showEmpty && dropdownPos && createPortal(emptyPanel, document.body)}
    </div>
  )
}

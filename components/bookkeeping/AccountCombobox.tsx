'use client'

import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, useId } from 'react'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { getAccountClassName } from '@/lib/bookkeeping/account-descriptions'
import {
  buildAccountIndex,
  searchAccounts,
  type SearchableAccount,
  type AccountSearchItem,
} from '@/lib/bookkeeping/account-search'
import {
  computeDropdownPosition,
  isSameDropdownPosition,
  type DropdownPosition,
} from '@/components/bookkeeping/account-combobox-position'
import type { BASAccount } from '@/types'

// Shared by every portaled panel instance: only stops propagation so the
// browser's default scrolling still runs on the panel itself.
function stopScrollPropagation(e: Event) {
  e.stopPropagation()
}

interface AccountComboboxProps {
  value: string
  accounts: BASAccount[]
  onChange: (accountNumber: string) => void
  // Fired when the user definitively commits an account: selecting from the
  // dropdown (Enter or click) or typing a full 4-digit number. Distinct from
  // onChange, which also fires on intermediate edits. Callers use this to
  // auto-advance focus (e.g. to the amount field).
  onCommit?: (accountNumber: string) => void
  // When provided, an inline "Skapa nytt konto" affordance appears in the
  // dropdown's empty state. The current search string is passed so the caller
  // can prefill the create dialog.
  onCreateAccount?: (prefill: string) => void
  // The full BAS catalogue. When provided, accounts not yet in `accounts`
  // (the company's active chart) become searchable by name and are surfaced
  // with the `notActivatedLabel` marker; picking one activates it at commit
  // via the existing ACCOUNTS_NOT_IN_CHART rail.
  catalog?: SearchableAccount[]
  // Label shown next to catalogue-only (not-yet-activated) accounts. Defaults
  // to Swedish; bilingual hosts pass a localized string.
  notActivatedLabel?: string
  // Extra classes merged into the trigger Input: callers pass `h-8` for dense
  // table rows, omit it to use the default Input height.
  className?: string
  // Optional callback ref to the underlying <input>, invoked alongside the
  // internal one. Lets a parent imperatively focus the field (e.g. auto-advance
  // to the next konteringsrad's account on Enter: see JournalEntryForm.focusAccount).
  inputRef?: React.RefCallback<HTMLInputElement>
  disabled?: boolean
  // Optional always-visible label for compact editors where the selected
  // account name must remain readable after the dropdown closes.
  selectedName?: string
  // Renders the trigger in the flat row language (SettingsRows): no box, a
  // dashed underline on hover, solid on focus. For hosts that compose
  // SettingsRow, where a bordered Input would be the only box in the form.
  // The dropdown also narrows to the row's width so it cannot overflow a
  // dialog. Default (false) keeps the boxed Input every existing caller uses.
  flat?: boolean
}

export default function AccountCombobox({ value, accounts, onChange, onCommit, onCreateAccount, catalog, notActivatedLabel = 'Aktiveras vid bokföring', className, inputRef, disabled = false, selectedName, flat = false }: AccountComboboxProps) {
  const [search, setSearch] = useState(value)
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const internalInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  // The portaled (non-flat) dropdown panel. It is not a DOM descendant of
  // containerRef, so outside-click detection must check it separately.
  const portalPanelRef = useRef<HTMLDivElement | null>(null)
  const [dropdownPos, setDropdownPos] = useState<DropdownPosition | null>(null)
  const selectedNameId = useId()
  // Whether the user has typed or arrow-navigated since the field was focused.
  // Enter only selects the highlighted item after an actual interaction: a
  // bare Enter on a freshly-focused field must not grab the first account in
  // the list (it either re-commits the current value or bubbles to the form).
  const hasInteractedRef = useRef(false)

  // Attach the internal ref (used for focus bookkeeping) and forward the element
  // to any external callback ref the parent passed.
  const setInputRef = useCallback((el: HTMLInputElement | null) => {
    internalInputRef.current = el
    inputRef?.(el)
  }, [inputRef])

  // Sync external value changes into the search field
  useEffect(() => {
    setSearch(value)
  }, [value])

  // Index the active chart + the full BAS catalogue once per source change.
  // Searching it per keystroke is then just substring checks over pre-folded
  // haystacks (number + name + description, diacritics stripped).
  const accountIndex = useMemo(
    () => buildAccountIndex({ active: accounts, catalog }),
    [accounts, catalog]
  )

  const filteredAccounts = useMemo(
    () => searchAccounts(accountIndex, search),
    [accountIndex, search]
  )

  // Group filtered accounts by class
  const groupedAccounts = useMemo(() => {
    const groups: { className: string; accounts: AccountSearchItem[] }[] = []
    const groupMap = new Map<string, AccountSearchItem[]>()

    for (const account of filteredAccounts) {
      const className = getAccountClassName(account.account_class)
      if (!groupMap.has(className)) {
        groupMap.set(className, [])
      }
      groupMap.get(className)!.push(account)
    }

    for (const [className, accts] of groupMap) {
      groups.push({ className, accounts: accts })
    }

    return groups
  }, [filteredAccounts])

  // Flat list for keyboard navigation
  const flatList = useMemo(() => filteredAccounts, [filteredAccounts])

  // Reset highlight when filtered results change
  useEffect(() => {
    setHighlightedIndex(0)
  }, [filteredAccounts])

  // Scroll highlighted item into view
  useEffect(() => {
    if (!isOpen || !listRef.current) return
    const highlighted = listRef.current.querySelector('[data-highlighted="true"]')
    if (highlighted) {
      highlighted.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightedIndex, isOpen])

  // Keep the portaled (non-flat) dropdown glued to the trigger: measure off
  // containerRef when it opens, and re-measure while anything scrolls or the
  // window resizes underneath it. The capture-phase scroll listener also
  // catches scrolling ancestors such as DialogContent's overflow-y-auto body.
  const updateDropdownPosition = useCallback(() => {
    if (flat || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const next = computeDropdownPosition(
      { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
      { width: window.innerWidth, height: window.innerHeight },
    )
    // Bail out when nothing moved (e.g. scroll ticks that did not shift the
    // anchor): returning the previous reference lets React skip the re-render.
    setDropdownPos((prev) => (isSameDropdownPosition(prev, next) ? prev : next))
  }, [flat])

  useLayoutEffect(() => {
    if (!isOpen || flat) return
    updateDropdownPosition()
    const handleScroll = (e: Event) => {
      // Scrolling the portaled panel's own list never moves the anchor (the
      // panel is position: fixed): repositioning on it would just churn state
      // while the user scrolls the account list.
      if (e.target instanceof Node && portalPanelRef.current?.contains(e.target)) return
      updateDropdownPosition()
    }
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', updateDropdownPosition)
    return () => {
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', updateDropdownPosition)
    }
  }, [isOpen, flat, updateDropdownPosition])

  // react-remove-scroll (active inside every modal dialog) preventDefaults
  // wheel/touchmove events that reach document from outside the dialog's DOM
  // tree, and the portaled panel lives outside that tree. Stopping the events
  // at the panel lets the browser scroll it natively; overscroll-contain on
  // the panel stops chained page scrolling at the list's edges.
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

  const attachPortalListPanel = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el
    attachPortalPanel(el)
  }, [attachPortalPanel])

  // Close dropdown when clicking/tapping outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent | TouchEvent) {
      const target = e.target as Node
      // The non-flat dropdown is portaled to document.body, so it is not a
      // DOM descendant of containerRef: check the portaled panel too.
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        !(portalPanelRef.current && portalPanelRef.current.contains(target))
      ) {
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

  const selectAccount = useCallback(
    (accountNumber: string) => {
      onChange(accountNumber)
      setSearch(accountNumber)
      setIsOpen(false)
      onCommit?.(accountNumber)
    },
    [onChange, onCommit]
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        hasInteractedRef.current = true
        setIsOpen(true)
        e.preventDefault()
      } else if (e.key === 'Enter' && /^\d{4}$/.test(search)) {
        // Dropdown closed but a full account number sits in the field: treat
        // Enter as a re-commit so focus advances to the amount field.
        e.preventDefault()
        onCommit?.(search)
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        hasInteractedRef.current = true
        setHighlightedIndex((prev) => Math.min(prev + 1, flatList.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        hasInteractedRef.current = true
        setHighlightedIndex((prev) => Math.max(prev - 1, 0))
        break
      case 'Enter':
        if (hasInteractedRef.current && flatList[highlightedIndex]) {
          e.preventDefault()
          selectAccount(flatList[highlightedIndex].account_number)
        } else if (/^\d{4}$/.test(search)) {
          // Committed number, no new interaction: advance without re-selecting.
          e.preventDefault()
          setIsOpen(false)
          onCommit?.(search)
        } else {
          // Nothing actively chosen: close the list and let the event bubble
          // so the form-level Enter (open review when balanced) can take over.
          setIsOpen(false)
        }
        break
      case 'Escape':
        e.preventDefault()
        setIsOpen(false)
        break
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    hasInteractedRef.current = true
    setSearch(newValue)
    // Emit any 4-digit numeric value to the parent. Unknown BAS numbers are
    // accepted optimistically: the submit-time ActivateAccountsDialog lets
    // the user activate missing accounts without leaving the form. A complete
    // 4-digit number is treated as a commit so focus can advance to the amount.
    if (/^\d{4}$/.test(newValue)) {
      onChange(newValue)
      // Only treat as a commit when the value newly becomes this account, so
      // editing an already-committed number doesn't keep stealing focus. On
      // commit, close the dropdown too: focus advances to the amount field, so
      // a lingering open list would just cover the rows below.
      //
      // Unless the number matches nothing. Then the dropdown is showing the
      // empty state, which carries the only way forward for a number outside
      // BAS (a retired account such as 8022, or a company-specific
      // underkonto): the "Skapa konto" affordance. Closing on the fourth
      // keystroke used to hide it before it was ever painted, which made the
      // affordance unreachable for exactly the numbers that need it.
      if (newValue !== value) {
        onCommit?.(newValue)
        if (searchAccounts(accountIndex, newValue).length > 0) {
          setIsOpen(false)
          return
        }
        setIsOpen(true)
        return
      }
    }
    if (!isOpen) {
      setIsOpen(true)
    }
  }

  const handleFocus = () => {
    hasInteractedRef.current = false
    setIsOpen(true)
  }

  const handleBlur = () => {
    // Close the dropdown as soon as focus leaves, so it never lingers open over
    // the rows below when focus advances via keyboard (Enter/Tab).
    setIsOpen(false)
    // Small delay to allow dropdown click to fire first. Keep any 4-digit
    // numeric value even if it's not in the currently-active chart: the
    // submit handler will prompt to activate it.
    setTimeout(() => {
      const isFourDigit = /^\d{4}$/.test(search)
      if (!isFourDigit && !accounts.some(a => a.account_number === search)) {
        setSearch(value)
      }
    }, 150)
  }

  const showSelectedName = Boolean(selectedName && value && search === value)

  // Flat mode keeps the dropdown as an absolute child that follows the
  // trigger's width: inside a SettingsRow a fixed width would overflow the
  // dialog. The non-flat dropdown is portaled to document.body with an
  // explicit viewport-clamped geometry (computeDropdownPosition) instead, so
  // a scrollable DialogContent can never clip it or grow a horizontal
  // scrollbar around it (the fix info-tooltip.tsx already applies to
  // TooltipContent, extended to this dropdown).
  const flatListWidthClass = 'w-full min-w-0'

  const portalPanelStyle: React.CSSProperties | undefined = dropdownPos
    ? {
        left: dropdownPos.left,
        width: dropdownPos.width,
        maxHeight: dropdownPos.maxHeight,
        ...(dropdownPos.top !== undefined
          ? { top: dropdownPos.top }
          : { bottom: dropdownPos.bottom }),
      }
    : undefined

  // data-dialog-companion: DialogContent/SheetContent treat a pointerdown
  // inside a node carrying this attribute as an inside interaction, so
  // clicking the portaled panel never dismisses the dialog hosting it.
  const listPanelContent = groupedAccounts.map((group) => (
    <div key={group.className}>
      <div className="sticky top-0 px-2 py-1.5 text-xs font-semibold text-muted-foreground bg-muted border-b border-input">
        {group.className}
      </div>
      {group.accounts.map((item) => {
        const flatIndex = flatList.indexOf(item)
        const isHighlighted = flatIndex === highlightedIndex
        return (
          <button
            key={item.account_number}
            type="button"
            data-highlighted={isHighlighted}
            className={`w-full text-left px-2 py-1.5 text-sm cursor-pointer flex items-baseline gap-2 ${
              isHighlighted ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50'
            }`}
            onMouseDown={(e) => {
              e.preventDefault()
              selectAccount(item.account_number)
            }}
            onMouseEnter={() => setHighlightedIndex(flatIndex)}
          >
            <span className={`font-mono shrink-0 ${item.isActive ? '' : 'text-muted-foreground'}`}>
              {item.account_number}
            </span>
            <span className="flex-1 min-w-0 break-words">{item.account_name}</span>
            {!item.isActive && (
              <span className="shrink-0 self-center text-[11px] text-muted-foreground whitespace-nowrap">
                {notActivatedLabel}
              </span>
            )}
          </button>
        )
      })}
    </div>
  ))

  const emptyPanelContent = (
    <>
      <p className="text-sm text-muted-foreground">
        Hittade inget konto som matchar.
      </p>
      {/^\d{4}$/.test(search.trim()) ? (
        <p className="text-xs text-muted-foreground mt-1">
          Om det är ett giltigt BAS-konto aktiveras det när du bokför.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground mt-1">
          Kontot kan behöva aktiveras i din kontoplan.
        </p>
      )}
      {onCreateAccount && (
        <button
          type="button"
          className="mt-2 flex w-full items-center gap-2 rounded-sm border border-input bg-card px-2 py-1.5 text-left text-sm hover:bg-muted/50"
          onMouseDown={(e) => {
            e.preventDefault()
            setIsOpen(false)
            onCreateAccount(search.trim())
          }}
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Skapa konto &quot;{search.trim()}&quot;</span>
        </button>
      )}
    </>
  )

  const triggerProps = {
    ref: setInputRef,
    value: search,
    onChange: handleInputChange,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onKeyDown: handleKeyDown,
    placeholder: 'Sök konto…',
    autoComplete: 'off',
    disabled,
    'aria-describedby': showSelectedName ? selectedNameId : undefined,
    className: flat
      ? cn(
          'min-w-0 flex-1 rounded-none border-0 border-b border-dashed border-transparent bg-transparent px-0 py-1 font-mono text-sm text-foreground',
          'placeholder:text-muted-foreground/60 hover:border-border',
          'focus:border-solid focus:border-foreground/50 focus:outline-none',
          'disabled:cursor-not-allowed disabled:border-transparent disabled:opacity-60',
          className,
        )
      : `font-mono ${className ?? ''}`.trim(),
  }

  return (
    <div ref={containerRef} className="relative">
      {flat ? <input {...triggerProps} /> : <Input {...triggerProps} />}

      {showSelectedName ? (
        <p id={selectedNameId} className="mt-1 break-words px-1 text-sm leading-snug text-foreground">
          {selectedName}
        </p>
      ) : null}

      {/* Dropdown */}
      {isOpen && !disabled && flatList.length > 0 && (flat ? (
        <div
          ref={listRef}
          className={cn(
            'absolute z-50 top-full left-0 mt-1 max-h-[300px] overflow-y-auto rounded-lg border border-input bg-card shadow-md',
            flatListWidthClass,
          )}
        >
          {listPanelContent}
        </div>
      ) : (
        dropdownPos &&
        createPortal(
          <div
            ref={attachPortalListPanel}
            data-dialog-companion=""
            className="fixed z-50 overflow-y-auto overscroll-contain pointer-events-auto rounded-lg border border-input bg-card shadow-md"
            style={portalPanelStyle}
          >
            {listPanelContent}
          </div>,
          document.body,
        )
      ))}

      {/* Empty state */}
      {isOpen && !disabled && search.trim() && flatList.length === 0 && (flat ? (
        <div
          className={cn(
            'absolute z-50 top-full left-0 mt-1 rounded-lg border border-input bg-card shadow-md p-3',
            flatListWidthClass,
          )}
        >
          {emptyPanelContent}
        </div>
      ) : (
        dropdownPos &&
        createPortal(
          <div
            ref={attachPortalPanel}
            data-dialog-companion=""
            className="fixed z-50 overflow-y-auto overscroll-contain pointer-events-auto rounded-lg border border-input bg-card p-3 shadow-md"
            style={portalPanelStyle}
          >
            {emptyPanelContent}
          </div>,
          document.body,
        )
      ))}
    </div>
  )
}

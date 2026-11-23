'use client'

import { useState, useRef, useEffect, useMemo, useCallback, useId } from 'react'
import { createPortal } from 'react-dom'
import { PlusIcon } from '@/components/icons'
import { Input } from '@/components/ui/input'
import {
  POPOVER_ENTER_CLASS,
  POPOVER_ENTER_UP_CLASS,
  POPOVER_SURFACE_CLASS,
} from '@/components/ui/popover-surface'
import { cn } from '@/lib/utils'
import { useComboboxNavigation } from '@/lib/hooks/use-combobox-navigation'
import { getAccountClassName } from '@/lib/bookkeeping/account-descriptions'
import {
  buildAccountIndex,
  searchAccounts,
  type SearchableAccount,
  type AccountSearchItem,
} from '@/lib/bookkeeping/account-search'
import { useAnchoredDropdown } from '@/components/bookkeeping/use-anchored-dropdown'
import type { BASAccount } from '@/types'

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
  // The picked account's name inside the field, after the number, for rows
  // that must keep one height (the kontering grid). Hidden while the person
  // types, like selectedName; the full name is the field's title.
  inlineName?: string
  // Renders the trigger in the flat row language (SettingsRows): no box, a
  // dashed underline on hover, solid on focus. For hosts that compose
  // SettingsRow, where a bordered Input would be the only box in the form.
  // The dropdown also narrows to the row's width so it cannot overflow a
  // dialog. Default (false) keeps the boxed Input every existing caller uses.
  flat?: boolean
  // Text shown while the field is empty. Hosts where empty means "use the
  // default" show that default here instead of the search prompt.
  placeholder?: string
  // id of the <input>, for a host <Label htmlFor>.
  id?: string
}

export default function AccountCombobox({ value, accounts, onChange, onCommit, onCreateAccount, catalog, notActivatedLabel = 'Aktiveras vid bokföring', className, inputRef, disabled = false, selectedName, inlineName, flat = false, placeholder = 'Sök konto…', id }: AccountComboboxProps) {
  const [search, setSearch] = useState(value)
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const internalInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  // The portaled (non-flat) dropdown panel, glued to the trigger. It is not a
  // DOM descendant of containerRef, so outside-click detection must check it
  // separately.
  const {
    pos: dropdownPos,
    style: portalPanelStyle,
    panelRef: portalPanelRef,
    attachPanel: attachPortalPanel,
  } = useAnchoredDropdown(containerRef, isOpen && !flat)
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

  const attachPortalListPanel = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el
    attachPortalPanel(el)
  }, [attachPortalPanel])

  const selectAccount = useCallback(
    (accountNumber: string) => {
      onChange(accountNumber)
      setSearch(accountNumber)
      setIsOpen(false)
      onCommit?.(accountNumber)
    },
    [onChange, onCommit]
  )

  const close = useCallback(() => setIsOpen(false), [])
  // The non-flat dropdown is portaled to document.body, so it is not a DOM
  // descendant of containerRef: a press inside the panel is inside too.
  const insideRefs = useMemo(() => [containerRef, portalPanelRef], [])
  const navigation = useComboboxNavigation({
    count: flatList.length,
    isOpen,
    open: () => {
      hasInteractedRef.current = true
      setIsOpen(true)
    },
    close,
    activate: (index) => {
      if (hasInteractedRef.current && flatList[index]) {
        selectAccount(flatList[index].account_number)
        return
      }
      if (/^\d{4}$/.test(search)) {
        // Committed number, no new interaction: advance without re-selecting.
        setIsOpen(false)
        onCommit?.(search)
        return
      }
      // Nothing actively chosen: close the list and let the event bubble so
      // the host form decides (the verifikat form opens the review from an
      // empty row's empty account field).
      setIsOpen(false)
      return false
    },
    onNavigate: () => {
      hasInteractedRef.current = true
    },
    listRef,
    insideRefs,
  })
  const { highlightedIndex, setHighlightedIndex, resetHighlight } = navigation

  // Reset highlight when filtered results change. Through resetHighlight:
  // this runs after every keystroke in the search.
  useEffect(() => {
    resetHighlight(0)
  }, [filteredAccounts, resetHighlight])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen && e.key === 'Enter' && /^\d{4}$/.test(search)) {
      // Dropdown closed but a full account number sits in the field: treat
      // Enter as a re-commit so focus advances to the amount field.
      e.preventDefault()
      onCommit?.(search)
      return
    }
    navigation.handleKeyDown(e)
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
  const showInlineName = Boolean(!flat && inlineName && value && search === value)

  // Flat mode keeps the dropdown as an absolute child that follows the
  // trigger's width: inside a SettingsRow a fixed width would overflow the
  // dialog. The non-flat dropdown is portaled to document.body with an
  // explicit viewport-clamped geometry (computeDropdownPosition) instead, so
  // a scrollable DialogContent can never clip it or grow a horizontal
  // scrollbar around it (the fix info-tooltip.tsx already applies to
  // TooltipContent, extended to this dropdown).
  const flatListWidthClass = 'w-full min-w-0'

  // A portal panel flips above the input when there is no room below.
  const portalEnterClass =
    dropdownPos?.top !== undefined ? POPOVER_ENTER_CLASS : POPOVER_ENTER_UP_CLASS

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
              isHighlighted ? 'bg-primary/10 text-primary' : 'hover:bg-secondary/60'
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
              <span className="shrink-0 self-center text-xs text-muted-foreground whitespace-nowrap">
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
          className="mt-2 flex w-full items-center gap-2 rounded-sm border border-input bg-card px-2 py-1.5 text-left text-sm hover:bg-secondary/60"
          onMouseDown={(e) => {
            e.preventDefault()
            setIsOpen(false)
            onCreateAccount(search.trim())
          }}
        >
          <PlusIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Skapa konto &quot;{search.trim()}&quot;</span>
        </button>
      )}
    </>
  )

  const triggerProps = {
    id,
    ref: setInputRef,
    value: search,
    onChange: handleInputChange,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onKeyDown: handleKeyDown,
    placeholder,
    autoComplete: 'off',
    disabled,
    'aria-describedby': showSelectedName || showInlineName ? selectedNameId : undefined,
    title: showInlineName ? inlineName : undefined,
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

      {/* The name sits after the number on the field's own line: an
          invisible copy of the number in the field's font keeps it aligned. */}
      {showInlineName ? (
        <span className="pointer-events-none absolute inset-x-0 top-0 flex h-8 items-center overflow-hidden px-2.5 text-[13px] pointer-coarse:h-10">
          <span aria-hidden="true" className="invisible shrink-0 whitespace-pre font-mono">
            {search}
          </span>
          <span id={selectedNameId} className="ml-2 min-w-0 truncate text-muted-foreground">
            {inlineName}
          </span>
        </span>
      ) : null}

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
            'absolute z-50 top-full left-0 mt-1 max-h-[300px] overflow-y-auto',
            POPOVER_SURFACE_CLASS,
            POPOVER_ENTER_CLASS,
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
            className={cn(
              'fixed z-50 overflow-y-auto overscroll-contain pointer-events-auto',
              POPOVER_SURFACE_CLASS,
              portalEnterClass,
            )}
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
            'absolute z-50 top-full left-0 mt-1 p-3',
            POPOVER_SURFACE_CLASS,
            POPOVER_ENTER_CLASS,
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
            className={cn(
              'fixed z-50 overflow-y-auto overscroll-contain pointer-events-auto p-3',
              POPOVER_SURFACE_CLASS,
              portalEnterClass,
            )}
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

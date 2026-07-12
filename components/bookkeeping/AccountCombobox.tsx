'use client'

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { getAccountClassName } from '@/lib/bookkeeping/account-descriptions'
import {
  buildAccountIndex,
  searchAccounts,
  type SearchableAccount,
  type AccountSearchItem,
} from '@/lib/bookkeeping/account-search'
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
}

export default function AccountCombobox({ value, accounts, onChange, onCommit, onCreateAccount, catalog, notActivatedLabel = 'Aktiveras vid bokföring', className, inputRef }: AccountComboboxProps) {
  const [search, setSearch] = useState(value)
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const internalInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
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

  // Close dropdown when clicking/tapping outside
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
      if (newValue !== value) {
        onCommit?.(newValue)
        setIsOpen(false)
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

  return (
    <div ref={containerRef} className="relative">
      <Input
        ref={setInputRef}
        value={search}
        onChange={handleInputChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder="Sök konto…"
        className={`font-mono ${className ?? ''}`.trim()}
        autoComplete="off"
      />


      {/* Dropdown */}
      {isOpen && flatList.length > 0 && (
        <div
          ref={listRef}
          className="absolute z-50 top-full left-0 mt-1 min-w-[24rem] w-[max(100%,34rem)] max-h-[300px] overflow-y-auto rounded-md border border-input bg-card shadow-md"
        >
          {groupedAccounts.map((group) => (
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
          ))}
        </div>
      )}

      {/* Empty state */}
      {isOpen && search.trim() && flatList.length === 0 && (
        <div className="absolute z-50 top-full left-0 mt-1 min-w-[24rem] w-[max(100%,34rem)] rounded-md border border-input bg-card shadow-md p-3">
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
              className="mt-2 flex w-full items-center gap-2 rounded-md border border-input bg-card px-2 py-1.5 text-left text-sm hover:bg-muted/50"
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
        </div>
      )}
    </div>
  )
}

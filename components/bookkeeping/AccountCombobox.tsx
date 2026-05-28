'use client'

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { getAccountClassName } from '@/lib/bookkeeping/account-descriptions'
import type { BASAccount } from '@/types'

interface AccountComboboxProps {
  value: string
  accounts: BASAccount[]
  onChange: (accountNumber: string) => void
  // When provided, an inline "Skapa nytt konto" affordance appears in the
  // dropdown's empty state. The current search string is passed so the caller
  // can prefill the create dialog.
  onCreateAccount?: (prefill: string) => void
  // Extra classes merged into the trigger Input — callers pass `h-8` for dense
  // table rows, omit it to use the default Input height.
  className?: string
}

const MAX_RESULTS = 50

export default function AccountCombobox({ value, accounts, onChange, onCreateAccount, className }: AccountComboboxProps) {
  const [search, setSearch] = useState(value)
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Sync external value changes into the search field
  useEffect(() => {
    setSearch(value)
  }, [value])

  // Filter accounts based on search input
  const filteredAccounts = useMemo(() => {
    if (!search) return accounts.slice(0, MAX_RESULTS)

    const trimmed = search.trim()
    if (!trimmed) return accounts.slice(0, MAX_RESULTS)

    const startsWithDigit = /^\d/.test(trimmed)

    if (startsWithDigit) {
      return accounts
        .filter((a) => a.account_number.startsWith(trimmed))
        .slice(0, MAX_RESULTS)
    }

    const lowerSearch = trimmed.toLowerCase()
    return accounts
      .filter((a) => a.account_name.toLowerCase().includes(lowerSearch))
      .slice(0, MAX_RESULTS)
  }, [accounts, search])

  // Group filtered accounts by class
  const groupedAccounts = useMemo(() => {
    const groups: { className: string; accounts: BASAccount[] }[] = []
    const groupMap = new Map<string, BASAccount[]>()

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
    },
    [onChange]
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
        setHighlightedIndex((prev) => Math.min(prev + 1, flatList.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightedIndex((prev) => Math.max(prev - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (flatList[highlightedIndex]) {
          selectAccount(flatList[highlightedIndex].account_number)
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
    setSearch(newValue)
    // Emit any 4-digit numeric value to the parent. Unknown BAS numbers are
    // accepted optimistically — the submit-time ActivateAccountsDialog lets
    // the user activate missing accounts without leaving the form.
    if (/^\d{4}$/.test(newValue)) {
      onChange(newValue)
    }
    if (!isOpen) {
      setIsOpen(true)
    }
  }

  const handleFocus = () => {
    setIsOpen(true)
  }

  const handleBlur = () => {
    // Small delay to allow dropdown click to fire first. Keep any 4-digit
    // numeric value even if it's not in the currently-active chart — the
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
        ref={inputRef}
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
          className="absolute z-50 top-full left-0 mt-1 w-64 max-h-[300px] overflow-y-auto rounded-md border border-input bg-card shadow-md"
        >
          {groupedAccounts.map((group) => (
            <div key={group.className}>
              <div className="sticky top-0 px-2 py-1.5 text-xs font-semibold text-muted-foreground bg-muted border-b border-input">
                {group.className}
              </div>
              {group.accounts.map((account) => {
                const flatIndex = flatList.indexOf(account)
                const isHighlighted = flatIndex === highlightedIndex
                return (
                  <button
                    key={account.account_number}
                    type="button"
                    data-highlighted={isHighlighted}
                    className={`w-full text-left px-2 py-1.5 text-sm cursor-pointer flex items-baseline gap-2 ${
                      isHighlighted ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50'
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      selectAccount(account.account_number)
                    }}
                    onMouseEnter={() => setHighlightedIndex(flatIndex)}
                  >
                    <span className="font-mono shrink-0">{account.account_number}</span>
                    <span className="truncate">{account.account_name}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {isOpen && search.trim() && flatList.length === 0 && (
        <div className="absolute z-50 top-full left-0 mt-1 w-64 rounded-md border border-input bg-card shadow-md p-3">
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

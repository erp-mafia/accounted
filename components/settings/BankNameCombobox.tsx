'use client'

import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface BankOption {
  name: string
  logo?: string
  bic?: string
}

const FALLBACK_BANKS: BankOption[] = [
  { name: 'Nordea', bic: 'NDEASESS' },
  { name: 'SEB', bic: 'ESSESESS' },
  { name: 'Swedbank', bic: 'SWEDSESS' },
  { name: 'Handelsbanken', bic: 'HANDSESS' },
  { name: 'Danske Bank', bic: 'DABASES' },
  { name: 'Länsförsäkringar', bic: 'ELLFSESS' },
  { name: 'Skandiabanken', bic: 'SKIASESS' },
  { name: 'ICA Banken' },
  { name: 'Avanza Bank' },
  { name: 'Sparbanken' },
]

interface BankNameComboboxProps {
  defaultValue?: string
  value?: string
  onChange?: (value: string) => void
  enableBankingEnabled?: boolean
}

export function BankNameCombobox({ defaultValue = '', value: controlledValue, onChange, enableBankingEnabled = false }: BankNameComboboxProps) {
  const isControlled = controlledValue !== undefined
  const [internalValue, setInternalValue] = useState(defaultValue)
  const value = isControlled ? controlledValue : internalValue
  const setValue = (v: string) => {
    if (!isControlled) setInternalValue(v)
    onChange?.(v)
  }
  const [banks, setBanks] = useState<BankOption[]>(FALLBACK_BANKS)
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (!enableBankingEnabled) return

    let cancelled = false
    async function fetchBanks() {
      try {
        const res = await fetch('/api/extensions/ext/enable-banking/banks')
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled && data.banks?.length > 0) {
          setBanks(data.banks)
        }
      } catch {
        // Keep fallback list
      }
    }
    fetchBanks()
    return () => { cancelled = true }
  }, [enableBankingEnabled])

  const filtered = value.trim()
    ? banks.filter((b) => b.name.toLowerCase().includes(value.toLowerCase()))
    : banks

  useEffect(() => {
    setHighlightedIndex(-1)
  }, [value])

  useEffect(() => {
    if (!isOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex < 0 || !listRef.current) return
    const item = listRef.current.children[highlightedIndex] as HTMLElement
    item?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex])

  function selectBank(bank: BankOption) {
    setValue(bank.name)
    setIsOpen(false)
    inputRef.current?.focus()
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
        e.preventDefault()
        if (highlightedIndex >= 0 && filtered[highlightedIndex]) {
          selectBank(filtered[highlightedIndex])
        }
        break
      case 'Escape':
        setIsOpen(false)
        break
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <input type="hidden" name="bank_name" value={value} />
      <Input
        ref={inputRef}
        type="text"
        placeholder="t.ex. Nordea"
        maxLength={100}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          if (!isOpen) setIsOpen(true)
        }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-expanded={isOpen}
        aria-autocomplete="list"
        aria-controls="bank-name-listbox"
        autoComplete="off"
      />
      {isOpen && filtered.length > 0 && (
        <ul
          ref={listRef}
          id="bank-name-listbox"
          role="listbox"
          className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-popover shadow-md"
        >
          {filtered.map((bank, i) => (
            <li
              key={bank.name}
              role="option"
              aria-selected={highlightedIndex === i}
              className={cn(
                'flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors',
                highlightedIndex === i && 'bg-accent text-accent-foreground',
              )}
              onMouseEnter={() => setHighlightedIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault() // prevent blur before click registers
                selectBank(bank)
              }}
            >
              {bank.logo ? (
                <img
                  src={bank.logo}
                  alt=""
                  className="h-5 w-5 flex-shrink-0 rounded object-contain"
                />
              ) : (
                <svg
                  className="h-5 w-5 flex-shrink-0 text-muted-foreground"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v4M12 14v4M16 14v4" />
                </svg>
              )}
              <span className="truncate">{bank.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

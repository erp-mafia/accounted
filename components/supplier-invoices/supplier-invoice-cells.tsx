'use client'

import { useState, useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { LEGAL_VAT_RATES } from '@/lib/vat/supplier-invoice-line-checks'
import { rateToPctString } from '@/lib/supplier-invoices/form-payload'
import { ChevronDown } from 'lucide-react'

export function VatRateCell({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const t = useTranslations('supplier_invoice_editor')
  const inputRef = useRef<HTMLInputElement>(null)
  // Local draft so the user can type "12," or "12." mid-keystroke without the
  // controlled input snapping back to a parsed integer.
  const [draft, setDraft] = useState(() => rateToPctString(value))

  // Re-sync from form value only when the field isn't focused: keeps AI
  // prefill / supplier defaults / dropdown picks flowing in without clobbering
  // active typing.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(rateToPctString(value))
    }
  }, [value])

  return (
    <div className="flex items-center gap-1">
      <div className="relative flex-1">
        <Input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={draft}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setDraft(rateToPctString(value))}
          onChange={(e) => {
            const raw = e.target.value
            // Strict whitelist: digits with at most one decimal separator.
            // Blocks "2-22", "100-2", "1.2.3", letters, signs: the keystroke
            // is dropped before reaching the draft.
            if (raw !== '' && !/^\d*[.,]?\d*$/.test(raw)) return
            const normalized = raw.replace(',', '.')
            if (normalized === '' || normalized === '.') {
              setDraft(raw)
              onChange(0)
              return
            }
            const parsed = parseFloat(normalized)
            if (!Number.isFinite(parsed)) {
              setDraft(raw)
              return
            }
            const clamped = Math.min(100, Math.max(0, parsed))
            // Snap the draft back when the parsed value falls outside [0, 100]
            // so the input can never display a rate the form won't apply.
            setDraft(clamped === parsed ? raw : String(clamped))
            onChange(clamped / 100)
          }}
          className="h-8 px-2 pr-6 text-right text-[13px] tabular-nums"
          aria-label={t('col_vat_rate')}
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
          %
        </span>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label={t('vat_rate_presets_aria')}
          >
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[6rem]">
          {LEGAL_VAT_RATES.map((preset) => (
            <DropdownMenuItem
              key={preset}
              onSelect={() => onChange(preset)}
              className="justify-end tabular-nums"
            >
              {Math.round(preset * 100)} %
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// Self-assessment rate picker shown in place of the Momssats cell when an
// invoice is reverse charge. The supplier charges no VAT (the line vat_rate is
// 0); this is the Swedish statutory rate the buyer self-assesses at: 25%
// huvudregeln for EU services, 12%/6% for reduced-rated services (ML 6 kap 34 §).
/**
 * Money amount cell: text input with decimal inputMode so Swedish comma
 * decimals work (type=number rejects them and adds spinner arrows that
 * decrement money on ArrowDown). Enter commits via blur instead of
 * triggering the form's implicit submit.
 */
export function AmountCell({
  value,
  onChange,
  inputRef,
  className,
}: {
  value: number
  onChange: (v: number) => void
  inputRef?: (el: HTMLInputElement | null) => void
  className?: string
}) {
  const innerRef = useRef<HTMLInputElement | null>(null)
  // Display Swedish comma decimals; parsing accepts both comma and dot.
  const toDisplay = (v: number) => (v ? String(v).replace('.', ',') : '')
  const [draft, setDraft] = useState(() => toDisplay(value))

  useEffect(() => {
    if (document.activeElement !== innerRef.current) {
      setDraft(toDisplay(value))
    }
  }, [value])

  return (
    <Input
      ref={(el) => {
        innerRef.current = el
        inputRef?.(el)
      }}
      type="text"
      inputMode="decimal"
      placeholder="0,00"
      className={className}
      value={draft}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => setDraft(toDisplay(value))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
      onChange={(e) => {
        const raw = e.target.value
        if (raw !== '' && !/^-?\d*[.,]?\d*$/.test(raw)) return
        setDraft(raw)
        const normalized = raw.replace(',', '.')
        if (normalized === '' || normalized === '.' || normalized === '-') {
          onChange(0)
          return
        }
        const parsed = parseFloat(normalized)
        onChange(Number.isFinite(parsed) ? parsed : 0)
      }}
    />
  )
}

export function RcRateSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const t = useTranslations('supplier_invoice_editor')
  return (
    <Select value={String(value ?? 0.25)} onValueChange={(v) => onChange(parseFloat(v))}>
      <SelectTrigger className="h-8 tabular-nums" aria-label={t('col_rc_vat_rate')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="0.25" className="tabular-nums">25 %</SelectItem>
        <SelectItem value="0.12" className="tabular-nums">12 %</SelectItem>
        <SelectItem value="0.06" className="tabular-nums">6 %</SelectItem>
      </SelectContent>
    </Select>
  )
}

'use client'

import { forwardRef, useCallback, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  UNIT_MAX_LENGTH,
  isUnitSuggestion,
  normalizeCustomUnit,
  unitName,
  unitPickerOptions,
} from '@/lib/invoices/units'
import { cn } from '@/lib/utils'

// In-table trigger: borderless like the cell inputs around it, 28px tall
// (40px on touch), the chevron always visible so it reads as a picker.
const CELL_TRIGGER_CLASS =
  'inline-flex h-7 min-w-0 shrink-0 items-center gap-1 rounded-sm px-1 text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:text-foreground data-[invalid=true]:text-destructive pointer-coarse:min-h-10'

// Form-field trigger: the same box as Input and the Select trigger.
const FIELD_TRIGGER_CLASS =
  'flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-input bg-card px-4 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary/20 data-[invalid=true]:border-destructive disabled:cursor-not-allowed disabled:opacity-50'

const ITEM_SELECTOR = '[role="menuitemradio"]'

export interface UnitPickerProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange' | 'type'> {
  /** The stored unit: free text, so it may be one we do not suggest. */
  value: string | null | undefined
  onChange: (unit: string) => void
  /** `cell` sits inside a table cell (beside Antal); `field` is a boxed form field. */
  variant?: 'cell' | 'field'
  invalid?: boolean
  /**
   * Mount with the list open: the editor's ghost "st" births its row with the
   * picker already open, so the chevron it shows opens the list on one click.
   */
  defaultOpen?: boolean
}

/**
 * The one unit control behind every unit field (invoice rows, articles,
 * recurring invoices, sales orders). It replaced a native <datalist>, which
 * Chrome filters by the input's current value: a row holding "st" only ever
 * suggested "st", so picking "tim" or "l" meant first erasing the field.
 *
 * Opening it always shows the whole list, each code beside its plain name
 * ("st  styck"), the current unit checked. Below the list, "Annan enhet"
 * takes any free text up to the API's limit, committed with Enter, so a unit
 * we do not list is typed rather than blocked; a stored unit we do not list
 * shows as itself and stays pickable.
 *
 * Keyboard (Radix menu): Enter, Space or ArrowDown on the trigger opens it on
 * the current unit, arrows move, Enter picks, a letter jumps to the first
 * code that starts with it, Escape closes, and focus returns to the trigger.
 * The ref lands on the trigger, so react-hook-form's setFocus reaches it.
 */
const UnitPicker = forwardRef<HTMLButtonElement, UnitPickerProps>(function UnitPicker(
  {
    value,
    onChange,
    variant = 'cell',
    invalid,
    defaultOpen = false,
    className,
    'aria-label': ariaLabel,
    ...triggerProps
  },
  ref,
) {
  const t = useTranslations('unit_picker')
  const locale = useLocale()
  const [open, setOpen] = useState(defaultOpen)
  const [draft, setDraft] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)
  const customRef = useRef<HTMLInputElement>(null)
  // Custom units this field has held, so one stays pickable after the user
  // tries a suggested unit instead.
  const [earlier, setEarlier] = useState<string[]>([])

  const current = (value ?? '').trim()
  const options = unitPickerOptions(current, earlier)

  function rememberCustom(unit: string) {
    if (unit === '' || isUnitSuggestion(unit)) return
    setEarlier((prev) => (prev.includes(unit) ? prev : [unit, ...prev]))
  }

  function pick(unit: string) {
    rememberCustom(current)
    if (unit !== current) onChange(unit)
  }

  function commitDraft() {
    const unit = normalizeCustomUnit(draft)
    if (unit === '') return
    pick(unit)
    setOpen(false)
  }

  // Open on the current unit rather than the top of the list, so arrows move
  // from where the user is. The content mounts through a portal after Radix
  // has placed its own focus, hence the frame's delay.
  const contentRefCallback = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node
    if (!node) return
    requestAnimationFrame(() => {
      node.querySelector<HTMLElement>(`${ITEM_SELECTOR}[data-state="checked"]`)?.focus()
    })
  }, [])

  function items(): HTMLElement[] {
    return Array.from(contentRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setDraft('')
      }}
    >
      <DropdownMenuTrigger asChild disabled={triggerProps.disabled}>
        <button
          ref={ref}
          type="button"
          // A button cannot carry aria-invalid (jsx-a11y); the row's or the
          // field's error text says what is wrong, this only colors it.
          data-invalid={invalid ? true : undefined}
          {...triggerProps}
          // The label alone ("Enhet") would hide the value the button shows:
          // unlike the input it replaced, a menu button announces no value of
          // its own, so the name carries it ("Enhet: st").
          aria-label={
            ariaLabel && current !== '' ? t('trigger_aria', { label: ariaLabel, unit: current }) : ariaLabel
          }
          className={cn(variant === 'cell' ? CELL_TRIGGER_CLASS : FIELD_TRIGGER_CLASS, className)}
        >
          <span className={cn('truncate', current === '' && 'text-muted-foreground/60')}>
            {current === '' ? t('empty') : current}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn('shrink-0 opacity-60', variant === 'cell' ? 'h-3 w-3' : 'h-4 w-4')}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={contentRefCallback}
        align={variant === 'cell' ? 'end' : 'start'}
        className="flex w-56 max-h-[var(--radix-dropdown-menu-content-available-height)] flex-col"
      >
        <div className="min-h-0 overflow-y-auto">
          <DropdownMenuRadioGroup value={current} onValueChange={pick}>
            {options.map((unit, index) => {
              const name = unitName(unit, locale)
              const isLast = index === options.length - 1
              return (
                <DropdownMenuRadioItem
                  key={unit}
                  value={unit}
                  // Typeahead matches the code, not "st styck".
                  textValue={unit}
                  className="gap-3 text-[13px]"
                  // ArrowDown from the last unit continues into "Annan enhet"
                  // instead of wrapping to the top.
                  onKeyDown={
                    isLast
                      ? (event) => {
                          if (event.key !== 'ArrowDown') return
                          event.preventDefault()
                          customRef.current?.focus()
                        }
                      : undefined
                  }
                >
                  <span className={cn('truncate', name ? 'w-12 shrink-0' : 'min-w-0')}>{unit}</span>
                  {name && <span className="truncate text-muted-foreground">{name}</span>}
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
        </div>
        <DropdownMenuSeparator />
        <div className="px-1 pb-1">
          <input
            ref={customRef}
            value={draft}
            maxLength={UNIT_MAX_LENGTH}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('custom_placeholder')}
            aria-label={t('custom_label')}
            className="h-8 w-full rounded-sm border border-border bg-background px-2 text-[13px] placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitDraft()
              } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault()
                const list = items()
                const target = event.key === 'ArrowUp' ? list[list.length - 1] : list[0]
                target?.focus()
              }
              // Escape still closes the menu (Radix listens on the document);
              // every other key stays in the field instead of driving the
              // menu's typeahead.
              if (event.key !== 'Escape') event.stopPropagation()
            }}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

export default UnitPicker

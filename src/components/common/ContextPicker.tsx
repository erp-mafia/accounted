'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { POPOVER_ENTER_CLASS, POPOVER_SURFACE_CLASS } from '@/components/ui/popover-surface'
import { CheckIcon, ChevronDownIcon } from '@/components/icons'

export interface ContextPickerItem {
  id: string
  label: string
  /** Muted right-side note on the row, e.g. "stängt" for a closed fiscal year. */
  annotation?: string
  disabled?: boolean
}

interface ContextPickerProps {
  items: ContextPickerItem[]
  /** Selected item id. */
  value: string | null
  onChange: (id: string) => void
  /** Chip text, e.g. "Räkenskapsår 2026" or "Alla källor: 24 300 kr" (a colon before an amount: a middle dot there reads as a minus sign). */
  triggerLabel: string
  disabled?: boolean
  ariaLabel?: string
  /**
   * toolbar (default): the 32px raised button far right in a page toolbar.
   * quiet: a 22px text chip for app-wide context in the sidebar (the fiscal
   * year beside the company name); its list opens under it, left-aligned.
   */
  variant?: 'toolbar' | 'quiet'
  /** Quiet variant inside a row that carries its own chevron (the sidebar's company row): the label alone. */
  hideChevron?: boolean
  className?: string
}

/**
 * The context picker (convention 8): a button with a chevron that scopes the
 * page to an account or source, or (variant quiet) the app to a fiscal
 * year. A control that looks like a picker must be a picker; this is that
 * picker.
 */
export function ContextPicker({
  items,
  value,
  onChange,
  triggerLabel,
  disabled = false,
  ariaLabel,
  variant = 'toolbar',
  hideChevron = false,
  className,
}: ContextPickerProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !listRef.current) return
    const t = triggerRef.current.getBoundingClientRect()
    const l = listRef.current.getBoundingClientRect()
    const margin = 8
    // Right-aligned under a toolbar picker (it lives far right in the
    // toolbar), left-aligned under the quiet sidebar chip; clamped to the
    // viewport either way.
    const anchor = variant === 'quiet' ? t.left - 8 : t.right - l.width
    const left = Math.max(margin, Math.min(anchor, window.innerWidth - l.width - margin))
    const top = Math.min(t.bottom + 4, window.innerHeight - l.height - margin)
    setPos({ top, left })
  }, [variant])

  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => updatePosition())
    return () => cancelAnimationFrame(raf)
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.isConnected) return
      if (
        (!triggerRef.current || !triggerRef.current.contains(target)) &&
        (!listRef.current || !listRef.current.contains(target))
      ) {
        setOpen(false)
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className={cn(
          variant === 'quiet'
            ? // A 22px text chip: the year beside the company name.
              'inline-flex h-5.5 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[12px] tabular-nums text-muted-foreground transition-colors duration-150'
            : // Stil v3: a context picker is the raised toolbar button with a
              // chevron (the same 32px as the buttons and search beside it).
              'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md bg-control px-3 text-[13px] font-medium text-strong shadow-raised transition-[box-shadow,transform] duration-150 active:scale-[0.97] active:duration-100',
          disabled
            ? 'opacity-40 cursor-not-allowed'
            : variant === 'quiet'
              ? 'cursor-pointer hover:bg-secondary/60 hover:text-foreground'
              : 'cursor-pointer hover:shadow-raised-hover',
          className,
        )}
      >
        <span className="truncate max-w-[220px]">{triggerLabel}</span>
        {!hideChevron && (
          <ChevronDownIcon className={cn('flex-shrink-0 text-muted-foreground', variant === 'quiet' ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5')} />
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            // Portaled to document.body, so inside a modal dialog the list is
            // DOM-wise outside DialogContent: data-dialog-companion keeps a
            // click in it from dismissing the dialog, and pointer-events-auto
            // undoes the modal body lock that would swallow item clicks.
            data-dialog-companion=""
            className={cn(
              'pointer-events-auto fixed z-[60] min-w-[220px] max-w-[320px] p-1',
              POPOVER_SURFACE_CLASS,
              POPOVER_ENTER_CLASS,
            )}
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="max-h-72 overflow-y-auto">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={item.id === value}
                  disabled={item.disabled}
                  onClick={() => {
                    onChange(item.id)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex min-h-7.5 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors duration-150',
                    item.disabled
                      ? 'text-muted-foreground/60 cursor-not-allowed'
                      : item.id === value
                        ? 'font-medium text-strong hover:bg-secondary/60'
                        : 'text-foreground hover:bg-secondary/60',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.annotation && (
                    <span className="flex-shrink-0 text-[12px] text-muted-foreground">
                      {item.annotation}
                    </span>
                  )}
                  {item.id === value && (
                    <CheckIcon className="h-3.5 w-3.5 flex-shrink-0 text-strong" />
                  )}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { Check, ChevronDown } from 'lucide-react'

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
  /** Chip text, e.g. "Räkenskapsår 2026" or "Alla källor · 24 300 kr". */
  triggerLabel: string
  disabled?: boolean
  ariaLabel?: string
  className?: string
}

/**
 * The page context picker (UI-migration convention 8): a chip-dropdown that
 * scopes the page to a fiscal year, account or source. One per page, far
 * right in the toolbar. A chip that looks like a picker must be a picker;
 * this is that picker.
 */
export function ContextPicker({
  items,
  value,
  onChange,
  triggerLabel,
  disabled = false,
  ariaLabel,
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
    // Right-aligned under the chip (the picker lives far right in the
    // toolbar), clamped to the viewport.
    const left = Math.max(margin, Math.min(t.right - l.width, window.innerWidth - l.width - margin))
    const top = Math.min(t.bottom + 4, window.innerHeight - l.height - margin)
    setPos({ top, left })
  }, [])

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
          'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-3 text-[13px]',
          'text-foreground transition-colors duration-150',
          disabled
            ? 'opacity-50 cursor-not-allowed'
            : 'hover:bg-secondary/60 cursor-pointer',
          className,
        )}
      >
        <span className="truncate max-w-[220px]">{triggerLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
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
            className="pointer-events-auto fixed z-[60] min-w-[220px] max-w-[320px] rounded-lg border border-border bg-popover py-1 shadow-lg animate-in fade-in slide-in-from-top-1 duration-150"
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="max-h-72 overflow-y-auto px-1">
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
                    'flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-[13px] leading-snug transition-colors',
                    item.disabled
                      ? 'text-muted-foreground/40 cursor-not-allowed'
                      : item.id === value
                        ? 'bg-secondary/60 text-foreground'
                        : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.annotation && (
                    <span className="flex-shrink-0 text-[11px] text-muted-foreground/70">
                      {item.annotation}
                    </span>
                  )}
                  {item.id === value && (
                    <Check className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
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

'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { Button, type ButtonProps } from '@/components/ui/button'
import { rememberCreateMode } from '@/lib/ui-state/client'
import { Check, ChevronDown, Loader2, type LucideIcon } from 'lucide-react'

export interface SplitButtonOption {
  key: string
  label: string
  icon?: LucideIcon
  /** Muted second line in the menu describing what the mode does. */
  description?: string
  /** Disable the option (e.g. viewers): renders inert with disabledTitle
   *  as the tooltip instead of silently no-opping. */
  disabled?: boolean
  disabledTitle?: string
  /** In-flight async action (e.g. bank sync): spinner replaces the icon and
   *  the option is inert until it resolves. */
  busy?: boolean
  /** Label shown on the primary face while busy (e.g. "Synkar…"). */
  busyLabel?: string
  onSelect: () => void
}

interface SplitButtonProps {
  options: SplitButtonOption[]
  /**
   * ui_state.create_mode key for last-used persistence (e.g. 'bookkeeping').
   * Omit to keep the split button stateless.
   */
  persistKey?: string
  /**
   * Which option renders as the primary action on first paint: the
   * server-read last-used mode (resolveInitialMode) or the first option.
   */
  initialModeKey?: string
  variant?: ButtonProps['variant']
  className?: string
}

/**
 * Primary action + caret menu (UI-migration convention 9): multiple create
 * paths collapse into one button whose primary face is the last-used mode,
 * persisted per user in user_preferences.ui_state.create_mode.
 */
export function SplitButton({
  options,
  persistKey,
  initialModeKey,
  variant = 'default',
  className,
}: SplitButtonProps) {
  const tCommon = useTranslations('common')
  const [activeKey, setActiveKey] = useState(
    () => options.find((o) => o.key === initialModeKey)?.key ?? options[0]?.key,
  )
  const [open, setOpen] = useState(false)
  const caretRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  const active = options.find((o) => o.key === activeKey) ?? options[0]

  const updatePosition = useCallback(() => {
    if (!caretRef.current || !menuRef.current) return
    const t = caretRef.current.getBoundingClientRect()
    const m = menuRef.current.getBoundingClientRect()
    const margin = 8
    const left = Math.max(margin, Math.min(t.right - m.width, window.innerWidth - m.width - margin))
    const top = Math.min(t.bottom + 4, window.innerHeight - m.height - margin)
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
        (!caretRef.current || !caretRef.current.contains(target)) &&
        (!menuRef.current || !menuRef.current.contains(target))
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

  if (!active) return null

  const runOption = (option: SplitButtonOption) => {
    if (option.disabled || option.busy) return
    setActiveKey(option.key)
    if (persistKey) rememberCreateMode(persistKey, option.key)
    option.onSelect()
  }

  return (
    <div className={cn('inline-flex items-stretch', className)}>
      <Button
        variant={variant}
        className="rounded-r-none"
        disabled={active.disabled || active.busy}
        aria-busy={active.busy || undefined}
        title={active.disabled ? active.disabledTitle : undefined}
        onClick={() => runOption(active)}
      >
        {active.busy ? (
          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
        ) : (
          active.icon && <active.icon className="mr-1.5 h-4 w-4" />
        )}
        {active.busy ? (active.busyLabel ?? active.label) : active.label}
      </Button>
      <Button
        ref={caretRef}
        variant={variant}
        aria-label={tCommon('more_options')}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          'rounded-l-none px-2',
          variant === 'default' && 'border-l border-primary-foreground/20',
          variant === 'outline' && 'border-l-0',
          variant === 'secondary' && 'border-l border-foreground/10',
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown className="h-4 w-4" />
      </Button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-[60] min-w-[240px] rounded-lg border border-border bg-popover py-1 shadow-lg animate-in fade-in slide-in-from-top-1 duration-150"
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="px-1">
              {options.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role="menuitem"
                  disabled={option.disabled || option.busy}
                  title={option.disabled ? option.disabledTitle : undefined}
                  onClick={() => {
                    setOpen(false)
                    runOption(option)
                  }}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors',
                    option.disabled
                      ? 'cursor-not-allowed text-muted-foreground/40'
                      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                  )}
                >
                  {option.busy ? (
                    <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin" />
                  ) : (
                    option.icon && (
                      <option.icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
                    )
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] text-foreground">{option.label}</span>
                    {option.description && (
                      <span className="block text-[11px] leading-snug text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                  {option.key === activeKey && (
                    <Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary" />
                  )}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}

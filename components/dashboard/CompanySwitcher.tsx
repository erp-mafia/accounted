'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { useCompany } from '@/contexts/CompanyContext'
import { switchCompany } from '@/lib/company/actions'
import { useToast } from '@/components/ui/use-toast'
import { Check, ChevronsUpDown, Plus, Loader2 } from 'lucide-react'

export default function CompanySwitcher() {
  const { company, companies, isSandbox } = useCompany()
  const t = useTranslations('company_switcher')
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [isPending, setIsPending] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 })

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !dropdownRef.current) return
    const triggerRect = triggerRef.current.getBoundingClientRect()
    const dropdownRect = dropdownRef.current.getBoundingClientRect()
    const margin = 8

    let top = triggerRect.bottom + 4
    let left = triggerRect.left

    // Clamp right edge to viewport
    if (left + dropdownRect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - dropdownRect.width - margin)
    }

    // If dropdown would go below viewport, show above trigger
    if (top + dropdownRect.height > window.innerHeight - margin) {
      top = Math.max(margin, triggerRect.top - dropdownRect.height - 4)
    }

    setDropdownPos({ top, left })
  }, [])

  // Update position when opening (run twice: once to render, once to measure)
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => updatePosition())
    return () => cancelAnimationFrame(raf)
  }, [open, updatePosition])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      if (
        (!triggerRef.current || !triggerRef.current.contains(target)) &&
        (!dropdownRef.current || !dropdownRef.current.contains(target))
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  const handleSwitch = async (companyId: string) => {
    if (company && companyId === company.id) {
      setOpen(false)
      return
    }
    setIsPending(true)
    const result = await switchCompany(companyId)
    if (result.error) {
      setIsPending(false)
      toast({
        title: t(result.error === 'not_member' ? 'error_no_access' : 'error_switch_failed'),
        variant: 'destructive',
      })
      return
    }
    // Notify every other open tab of the same user so they hard-reload
    // onto the new company. BroadcastChannel is best-effort — if the
    // browser doesn't support it (very old) we still hard-reload
    // ourselves, and other tabs will self-correct via the visibilitychange
    // / pageshow listeners in CompanyTabSync on their next focus event.
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const channel = new BroadcastChannel('gnubok-company-switch')
        channel.postMessage({ companyId })
        channel.close()
      } catch {
        // Ignore — hard reload still happens below
      }
    }
    // Hard navigation — tears down React state, router cache, in-flight
    // fetches, blob URLs, etc. This is the whole point: nothing from the
    // previous company can survive the switch.
    window.location.assign('/')
  }

  // Always allow opening the dropdown (to show "Lägg till företag")
  const hasMultiple = companies.length > 1

  // No companies yet — show a direct "Lägg till företag" link instead of
  // the switcher so the user can still create one. Hidden in sandbox mode.
  if (!company && companies.length === 0) {
    if (isSandbox) return null
    return (
      <Link
        href="/select-company"
        className="flex items-center gap-2 w-full text-left rounded-lg border border-dashed border-border/60 hover:border-foreground/30 hover:bg-muted/40 -mx-1 px-2 py-1.5 transition-colors duration-150"
      >
        <Plus className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        <span className="text-[13px] text-muted-foreground truncate">{t('add_company')}</span>
      </Link>
    )
  }

  return (
    <div>
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full text-left rounded-lg border border-transparent hover:border-border/60 hover:bg-muted/40 -mx-1 px-2 py-1.5 transition-colors duration-150"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <div className="flex-1 min-w-0">
          <p className="text-[10px] text-muted-foreground/60 uppercase tracking-[0.06em] leading-none mb-1">{t('company_label')}</p>
          <p className="text-[13px] font-semibold text-foreground truncate tracking-[-0.01em]">
            {company?.name || t('default_company_name')}
          </p>
        </div>
        <ChevronsUpDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          className="fixed min-w-56 w-max max-w-[calc(100vw-1rem)] bg-card border border-border/60 rounded-lg shadow-lg z-[60] py-1 animate-in fade-in slide-in-from-top-1 duration-150"
          style={{ top: dropdownPos.top, left: dropdownPos.left }}
        >
          {companies.length > 0 && (
            <>
              {hasMultiple && (
                <div className="px-2 py-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] px-1.5">
                    {t('company_label')}
                  </p>
                </div>
              )}

              <div className="max-h-48 overflow-y-auto px-1">
                {companies.map(({ company: c, role }) => (
                  <button
                    key={c.id}
                    onClick={() => handleSwitch(c.id)}
                    disabled={isPending}
                    className={cn(
                      'flex items-center gap-2 w-full px-2.5 py-2 text-left text-[13px] leading-snug transition-colors rounded-md md:whitespace-nowrap',
                      c.id === company?.id
                        ? 'text-foreground bg-muted/40'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
                      isPending && 'opacity-50',
                    )}
                    role="option"
                    aria-selected={c.id === company?.id}
                  >
                    <span className="flex-1 min-w-0">{c.name}</span>
                    {role !== 'owner' && (
                      <span className="text-[10px] text-muted-foreground/60 flex-shrink-0">
                        {role}
                      </span>
                    )}
                    {c.id === company?.id && (
                      <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />
                    )}
                    {isPending && c.id !== company?.id && (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground flex-shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          {!isSandbox && (
            <div className={cn(companies.length > 0 && 'border-t border-border/40 mt-1 pt-1', 'px-1')}>
              <Link
                href="/select-company"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-2.5 py-2 text-[13px] text-muted-foreground hover:text-foreground hover:bg-muted/40 rounded-md transition-colors md:whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('add_company')}
              </Link>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}

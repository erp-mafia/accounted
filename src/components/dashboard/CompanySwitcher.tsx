'use client'

import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { POPOVER_ENTER_CLASS, POPOVER_SURFACE_CLASS } from '@/components/ui/popover-surface'
import { useCompany } from '@/contexts/CompanyContext'
import { companyInitials } from './company-initials'
import { ADD_COMPANY_HREF } from '@/components/settings/company-deletion'
import { performCompanySwitch } from '@/lib/company/switch-client'
import { useToast } from '@/components/ui/use-toast'
import {
  CheckIcon,
  ChevronUpDownIcon,
  LockClosedIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SpinnerIcon,
} from '@/components/icons'

/** The company's mark in the shell: its initials (two letters) on a small dark tile. */
export function CompanyTile({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-primary/88 text-[11px] font-semibold leading-none tracking-tight text-primary-foreground"
    >
      {companyInitials(name)}
    </span>
  )
}

interface CompanySwitcherProps {
  /**
   * field (default): the labelled field in the phone's menu sheet.
   * row: the row that heads the area sidebar (V7 shell): the company's
   * initials tile, its name, then `trailing` (the fiscal year) and the
   * up-down chevron. The whole row reads as one control; the name and the
   * chevron open the switcher.
   */
  variant?: 'field' | 'row'
  /** Row variant: what sits between the name and the chevron (the fiscal year chip). */
  trailing?: ReactNode
}

/** The list shows five companies without scrolling; from the sixth it carries a search field. */
const SEARCH_FROM = 5

export default function CompanySwitcher({ variant = 'field', trailing }: CompanySwitcherProps = {}) {
  const { company, companies, isSandbox, foreignCompanies = [], lockedCompanyIds = [], addCompanyHref = ADD_COMPANY_HREF } = useCompany()
  const t = useTranslations('company_switcher')
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [isPending, setIsPending] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 })
  // Someone with many companies (a byrå) finds one by name: the list is
  // searched once it is longer than it shows without scrolling.
  const [query, setQuery] = useState('')
  const searchable = companies.length > SEARCH_FROM
  const needle = query.trim().toLowerCase()
  const listed = searchable && needle ? companies.filter(({ company: c }) => c.name.toLowerCase().includes(needle)) : companies

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !dropdownRef.current) return
    const triggerRect = triggerRef.current.getBoundingClientRect()
    const dropdownRect = dropdownRef.current.getBoundingClientRect()
    const margin = 8

    let top = triggerRect.bottom + 4
    // The row variant's trigger starts at the tile; the list lines up with the row's edge.
    let left = triggerRect.left - (variant === 'row' ? 8 : 0)

    // Clamp right edge to viewport
    if (left + dropdownRect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - dropdownRect.width - margin)
    }

    // If dropdown would go below viewport, show above trigger
    if (top + dropdownRect.height > window.innerHeight - margin) {
      top = Math.max(margin, triggerRect.top - dropdownRect.height - 4)
    }

    setDropdownPos({ top, left })
  }, [variant])

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
        (!triggerRef.current || !triggerRef.current.parentElement?.contains(target)) &&
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
    // Shared switch-and-reload mechanism (lib/company/switch-client), same
    // path as the sidebar user-menu flyout.
    const result = await performCompanySwitch(companyId)
    if (result?.error) {
      setIsPending(false)
      toast({
        title: t(
          result.error === 'not_member'
            ? 'error_no_access'
            : result.error === 'company_locked'
              ? 'error_locked'
              : 'error_switch_failed',
        ),
        variant: 'destructive',
      })
    }
  }

  // Always allow opening the dropdown (to show "Lägg till företag")
  const hasMultiple = companies.length > 1

  // No companies yet: show a direct "Lägg till företag" link instead of
  // the switcher so the user can still create one. Hidden in sandbox mode.
  if (!company && companies.length === 0) {
    if (isSandbox) return null
    return (
      <Link
        href={addCompanyHref}
        className={cn(
          'flex items-center gap-2 w-full text-left transition-colors duration-150',
          variant === 'row'
            ? 'h-7.5 rounded-md px-2 hover:bg-secondary/60'
            : 'rounded-lg border border-dashed border-border hover:border-foreground/30 hover:bg-secondary/60 -mx-1 px-2 py-1.5',
        )}
      >
        <PlusIcon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        <span className="text-[13px] text-muted-foreground truncate">{t('add_company')}</span>
      </Link>
    )
  }

  return (
    <div>
      {variant === 'row' ? (
        <div
          className={cn(
            'flex h-7.5 items-center gap-1 rounded-md pl-2 pr-1 transition-colors duration-150 hover:bg-secondary/60 focus-within:bg-secondary/60',
            open && 'bg-secondary/60',
          )}
        >
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label={t('switch_company_aria', { company: company?.name || t('default_company_name') })}
            className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            <CompanyTile name={company?.name || t('default_company_name')} />
            {/* data-ph-mask: a company name in the shell chrome. */}
            <span data-ph-mask title={company?.name} className="min-w-0 flex-1 truncate text-[13px] font-medium text-strong">
              {company?.name || t('default_company_name')}
            </span>
          </button>
          {trailing}
          {/* The chevron belongs to the switcher; the name button is its keyboard stop. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen(!open)}
            className="flex h-full w-4 flex-shrink-0 items-center justify-center text-muted-foreground"
          >
            <ChevronUpDownIcon className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <button
          ref={triggerRef}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 w-full text-left rounded-lg border border-transparent hover:border-border hover:bg-secondary/60 -mx-1 px-2 py-1.5 transition-colors duration-150"
          aria-expanded={open}
          aria-haspopup="listbox"
        >
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground leading-none mb-1">{t('company_label')}</p>
            <p className="text-[13px] font-semibold text-foreground truncate tracking-[-0.01em]">
              {company?.name || t('default_company_name')}
            </p>
          </div>
          <ChevronUpDownIcon className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        </button>
      )}

      {open && createPortal(
        <div
          ref={dropdownRef}
          className={cn('fixed min-w-56 w-max max-w-[calc(100vw-1rem)] z-[60] py-1', POPOVER_SURFACE_CLASS, POPOVER_ENTER_CLASS)}
          style={{ top: dropdownPos.top, left: dropdownPos.left }}
        >
          {companies.length > 0 && (
            <>
              {hasMultiple && (
                <div className="px-2 py-1.5">
                  <p className="text-xs font-semibold text-muted-foreground px-1.5">
                    {t('company_label')}
                  </p>
                </div>
              )}

              {searchable && (
                <div className="mb-1 flex items-center gap-2 border-b-hairline px-3.5 pb-2 pt-1">
                  <MagnifyingGlassIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter takes the one company the search has narrowed to.
                      if (e.key !== 'Enter' || listed.length !== 1) return
                      const only = listed[0].company.id
                      if (!lockedCompanyIds.includes(only)) void handleSwitch(only)
                    }}
                    placeholder={t('search_placeholder')}
                    aria-label={t('search_placeholder')}
                    className="w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none"
                  />
                </div>
              )}

              <div className="max-h-48 overflow-y-auto px-1">
                {listed.length === 0 && <p className="px-2.5 py-2 text-xs text-muted-foreground">{t('no_results')}</p>}
                {listed.map(({ company: c, role }) =>
                  lockedCompanyIds.includes(c.id) ? (
                    // Multi-user seat gate: frozen for this user until the
                    // company pays. Shown, not hidden: the membership exists
                    // and the row explains why it cannot be entered.
                    <div
                      key={c.id}
                      className="flex items-center gap-2 w-full px-2.5 py-2 text-left text-[13px] leading-snug text-muted-foreground rounded-sm md:whitespace-nowrap"
                      aria-disabled="true"
                    >
                      <span className="flex-1 min-w-0">
                        <span className="block truncate" title={c.name}>{c.name}</span>
                        <span className="block truncate text-xs">{t('locked_note')}</span>
                      </span>
                      <LockClosedIcon className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                    </div>
                  ) : (
                  <button
                    key={c.id}
                    onClick={() => handleSwitch(c.id)}
                    disabled={isPending}
                    className={cn(
                      'flex items-center gap-2 w-full px-2.5 py-2 text-left text-[13px] leading-snug transition-colors rounded-sm md:whitespace-nowrap',
                      c.id === company?.id
                        ? 'text-foreground bg-muted/40'
                        : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60',
                      isPending && 'opacity-50',
                    )}
                    role="option"
                    aria-selected={c.id === company?.id}
                  >
                    <span className="flex-1 min-w-0">{c.name}</span>
                    {role !== 'owner' && (
                      <span className="text-xs text-muted-foreground flex-shrink-0">
                        {role}
                      </span>
                    )}
                    {c.id === company?.id && (
                      <CheckIcon className="h-3.5 w-3.5 text-primary flex-shrink-0" />
                    )}
                    {isPending && c.id !== company?.id && (
                      <SpinnerIcon className="h-3 w-3 animate-spin text-muted-foreground flex-shrink-0" />
                    )}
                  </button>
                  ),
                )}
              </div>
            </>
          )}

          {/* Companies homed on another domain (home-domain rule, WL-01):
              non-clickable signposts; the company is worked in over there. */}
          {foreignCompanies.length > 0 && (
            <div className="border-t-hairline mt-1 pt-1 px-1">
              <p className="px-2.5 pt-1 pb-0.5 text-xs font-semibold text-muted-foreground">
                {t('managed_elsewhere')}
              </p>
              {foreignCompanies.map((entry) => (
                <div
                  key={entry.id}
                  className="px-2.5 py-1.5 text-xs leading-snug text-muted-foreground"
                  aria-disabled="true"
                >
                  <span className="block truncate">{entry.name}</span>
                  <span className="block truncate text-xs">
                    {t('managed_via', { domain: entry.domain })}
                  </span>
                </div>
              ))}
            </div>
          )}

          {!isSandbox && (
            <div className={cn((companies.length > 0 || foreignCompanies.length > 0) && 'border-t-hairline mt-1 pt-1', 'px-1')}>
              <Link
                href={addCompanyHref}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-2.5 py-2 text-[13px] text-muted-foreground hover:text-foreground hover:bg-secondary/60 rounded-sm transition-colors md:whitespace-nowrap"
              >
                <PlusIcon className="h-3.5 w-3.5" />
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

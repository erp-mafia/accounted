'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { useCompany } from '@/contexts/CompanyContext'
import { performCompanySwitch } from '@/lib/company/switch-client'
import { useToast } from '@/components/ui/use-toast'
import { SupportLink } from '@/components/ui/support-link'
import {
  Check,
  ChevronsUpDown,
  ChevronRight,
  CreditCard,
  HelpCircle,
  Loader2,
  LogOut,
  Plus,
  Search,
  Settings,
  Users,
} from 'lucide-react'

// Community invite (Accounted's Discord). Deliberately a constant, not
// branding config: self-hosted rebrands can hide or swap it when someone
// actually asks for that. Must be a never-expiring invite: the previous one
// expired and left logged-in users with a dead link.
const DISCORD_INVITE_URL = 'https://discord.gg/nfE9Uyv69a'

// Lucide ships no brand marks, so the Discord logo is inlined (simple-icons
// path, CC0). Sized and colored like the surrounding lucide icons.
function DiscordLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  )
}

interface UserMenuProps {
  userName: string | null
  userEmail: string | null
  isSandbox: boolean
  collapsed: boolean
  // Byrå cockpit (lean sidebar): the cockpit is above the companies, so the
  // widget shows no active company and no company-switcher flyout; entering
  // a client happens through the Klienter list instead.
  cockpitMode?: boolean
  onLogout: () => void
}

// Best single-character initial for the avatar. Prefers the first letter of
// the full name; falls back to the email; falls back to "?" so the circle
// never renders empty.
function accountInitial(name: string | null, email: string | null): string {
  const trimmedName = name?.trim()
  if (trimmedName && trimmedName.length > 0) return trimmedName[0]!.toUpperCase()
  const trimmedEmail = email?.trim()
  if (trimmedEmail && trimmedEmail.length > 0) return trimmedEmail[0]!.toUpperCase()
  return '?'
}

// Company monogram: first letter in a small rounded square. Square = company,
// circle = person (the avatar above), so the two identity marks stay distinct.
function CompanyMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-sm bg-secondary text-[9px] font-semibold uppercase leading-none text-foreground"
    >
      {name.trim().charAt(0) || '?'}
    </span>
  )
}

/**
 * Sticky bottom-of-sidebar user block: avatar initials, name, active company,
 * chevron. Opens an upward popover aligned with the nav column holding
 * identity, the company-switcher flyout, account links and logout.
 * Concept reference: ui_migration_plan.md PR 2.
 */
export default function UserMenu({
  userName,
  userEmail,
  isSandbox,
  collapsed,
  cockpitMode = false,
  onLogout,
}: UserMenuProps) {
  const { company, companies, isSandbox: companyCtxSandbox, foreignCompanies = [] } = useCompany()
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const tSwitcher = useTranslations('company_switcher')
  const { toast } = useToast()

  const [open, setOpen] = useState(false)
  const [companiesOpen, setCompaniesOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [isPending, setIsPending] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })

  const sandbox = isSandbox || companyCtxSandbox

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !menuRef.current) return
    const triggerRect = triggerRef.current.getBoundingClientRect()
    const menuRect = menuRef.current.getBoundingClientRect()
    const margin = 8
    // Upward popover: bottom edge sits just above the trigger, left-aligned
    // with the nav column.
    const top = Math.max(margin, triggerRect.top - menuRect.height - 6)
    const left = Math.max(margin, triggerRect.left)
    setMenuPos({ top, left })
  }, [])

  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => updatePosition())
    return () => cancelAnimationFrame(raf)
  }, [open, companiesOpen, updatePosition])

  // Focus the search field when the company flyout opens.
  useEffect(() => {
    if (!companiesOpen) return
    const raf = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [companiesOpen])

  const close = useCallback(() => {
    setOpen(false)
    setCompaniesOpen(false)
    setQuery('')
  }, [])

  // Outside click. Two carve-outs: elements already removed from the DOM
  // (isConnected: clicking a row that re-renders must not read as outside,
  // known concept bug pattern), and portaled dialogs (the support dialog
  // opens above the menu; interacting with it must not unmount it).
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.isConnected) return
      if (target.closest('[role="dialog"]')) return
      if (
        (!triggerRef.current || !triggerRef.current.contains(target)) &&
        (!menuRef.current || !menuRef.current.contains(target))
      ) {
        close()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open, close])

  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      // Esc closes the flyout first, then the menu; but never while the
      // support dialog is open (it handles its own Esc).
      if (document.querySelector('[role="dialog"]')) return
      if (companiesOpen) {
        setCompaniesOpen(false)
        setQuery('')
      } else {
        close()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, companiesOpen, close])

  const handleSwitch = async (companyId: string) => {
    // In the cockpit nothing is "current": picking any company, including the
    // technically-active one, must enter it (full navigation to its start).
    if (!cockpitMode && company && companyId === company.id) {
      close()
      return
    }
    setIsPending(true)
    const result = await performCompanySwitch(companyId)
    if (result?.error) {
      setIsPending(false)
      toast({
        title: tSwitcher(
          result.error === 'not_member' ? 'error_no_access' : 'error_switch_failed',
        ),
        variant: 'destructive',
      })
    }
  }

  const filteredCompanies = companies.filter(({ company: c }) =>
    c.name.toLowerCase().includes(query.trim().toLowerCase()),
  )

  const menuRow =
    'flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left text-[13px] ' +
    'text-muted-foreground hover:text-foreground hover:bg-secondary/60 ' +
    'transition-colors duration-150 cursor-pointer'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          'group flex w-full items-center rounded-lg text-left transition-colors duration-150 hover:bg-secondary/60',
          collapsed ? 'justify-center p-2' : 'gap-2.5 px-3 py-2',
        )}
      >
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold uppercase text-foreground">
          {accountInitial(userName, userEmail)}
        </span>
        {!collapsed && (
          <>
            <span className="flex-1 min-w-0">
              <span className="block truncate text-[13px] font-medium text-foreground leading-tight">
                {userName?.trim() || userEmail || tNav('mitt_konto')}
              </span>
              {company && !cockpitMode && (
                <span className="block truncate text-[11px] text-muted-foreground leading-tight">
                  {company.name}
                </span>
              )}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground opacity-50 group-hover:opacity-100" />
          </>
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-[60] w-[232px] rounded-lg border border-border bg-popover py-1 shadow-lg animate-in fade-in slide-in-from-bottom-1 duration-150"
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            {/* Identity */}
            {(userName || userEmail) && (
              <div className="border-b border-border/60 px-3 py-2.5">
                {userName && (
                  <p className="truncate text-[13px] font-medium text-foreground">{userName}</p>
                )}
                {userEmail && (
                  <p className="truncate text-[11px] text-muted-foreground">{userEmail}</p>
                )}
              </div>
            )}

            {/* Company switcher flyout. In the cockpit no company reads as
                active (neutral label, no check mark); picking one enters it
                like the Klienter list does. */}
            <div className="relative px-1 pt-1">
              <button
                type="button"
                onClick={() => setCompaniesOpen((v) => !v)}
                aria-expanded={companiesOpen}
                className={cn(menuRow, companiesOpen && 'bg-secondary/60 text-foreground')}
              >
                <CompanyMark name={company?.name || tSwitcher('default_company_name')} />
                <span className="flex-1 truncate">
                  {cockpitMode
                    ? tSwitcher('choose_company')
                    : company?.name || tSwitcher('default_company_name')}
                </span>
                <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 opacity-50" />
              </button>

              {companiesOpen && (
                // Top-aligned with the company row, growing DOWNWARD
                // (founder feedback 2026-07-23: never upward over the menu).
                <div className="absolute top-0 left-full z-[61] ml-1.5 w-60 rounded-lg border border-border bg-popover py-1 shadow-lg animate-in fade-in slide-in-from-left-1 duration-150">
                  <div className="flex items-center gap-2 border-b border-border/60 px-3 pb-2 pt-1.5">
                    <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <input
                      ref={searchRef}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={tSwitcher('search_placeholder')}
                      className="w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
                    />
                  </div>
                  <div className="max-h-56 overflow-y-auto px-1 py-1" role="listbox">
                    {filteredCompanies.length === 0 && (
                      <p className="px-2.5 py-2 text-[12px] text-muted-foreground">
                        {tSwitcher('no_results')}
                      </p>
                    )}
                    {filteredCompanies.map(({ company: c, role }) => {
                      const isCurrent = !cockpitMode && c.id === company?.id
                      return (
                        <button
                          key={c.id}
                          onClick={() => handleSwitch(c.id)}
                          disabled={isPending}
                          role="option"
                          aria-selected={isCurrent}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-[13px] leading-snug transition-colors',
                            isCurrent
                              ? 'bg-secondary/60 text-foreground'
                              : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                            isPending && 'opacity-50',
                          )}
                        >
                          <CompanyMark name={c.name} />
                          <span className="min-w-0 flex-1 truncate">{c.name}</span>
                          {role !== 'owner' && (
                            <span className="flex-shrink-0 text-[10px] text-muted-foreground/60">
                              {role}
                            </span>
                          )}
                          {isCurrent && (
                            <Check className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
                          )}
                          {isPending && !isCurrent && (
                            <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-muted-foreground" />
                          )}
                        </button>
                      )
                    })}
                  </div>
                  {/* Companies homed on another domain (home-domain rule,
                      WL-01): subtle, non-clickable signpost entries. */}
                  {foreignCompanies.length > 0 && (
                    <div className="border-t border-border/60 px-1 pt-1">
                      <p className="px-2.5 pt-1 pb-0.5 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-[0.08em]">
                        {tSwitcher('managed_elsewhere')}
                      </p>
                      {foreignCompanies.map((entry) => (
                        <div
                          key={entry.id}
                          className="px-2.5 py-1.5 text-[12px] leading-snug text-muted-foreground/60"
                          aria-disabled="true"
                        >
                          <span className="block truncate">{entry.name}</span>
                          <span className="block truncate text-[10px]">
                            {tSwitcher('managed_via', { domain: entry.domain })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {!sandbox && (
                    <div className="border-t border-border/60 px-1 pt-1">
                      <Link href="/select-company?choose=1" onClick={close} className={menuRow}>
                        <Plus className="h-4 w-4 flex-shrink-0" />
                        {tSwitcher('add_company')}
                      </Link>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Account links. From the cockpit, settings open in byrå scope
                (?ctx=byra): account-level sections only; Abonnemang is
                company-scoped and hidden there. */}
            <div className="px-1 pb-1">
              <Link
                href={cockpitMode ? '/settings/account?ctx=byra' : '/settings'}
                onClick={close}
                className={menuRow}
              >
                <Settings className="h-4 w-4 flex-shrink-0" />
                {tNav('settings')}
              </Link>
              <Link
                href={cockpitMode ? '/settings/team?ctx=byra' : '/settings/company#members'}
                onClick={close}
                className={menuRow}
              >
                <Users className="h-4 w-4 flex-shrink-0" />
                {tNav('members_roles')}
              </Link>
              {!cockpitMode && (
                <Link href="/settings/billing" onClick={close} className={menuRow}>
                  <CreditCard className="h-4 w-4 flex-shrink-0" />
                  {tNav('subscription')}
                </Link>
              )}
              <div className="my-1 border-t border-border/60" />
              <Link href="/help" onClick={close} className={menuRow}>
                <HelpCircle className="h-4 w-4 flex-shrink-0" />
                {tNav('help')}
              </Link>
              <a
                href={DISCORD_INVITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={close}
                className={menuRow}
              >
                <DiscordLogo className="h-4 w-4 flex-shrink-0" />
                {tNav('discord_community')}
              </a>
              <SupportLink variant="muted" className={menuRow} />
              <div className="my-1 border-t border-border/60" />
              <button
                type="button"
                onClick={() => {
                  close()
                  onLogout()
                }}
                className={cn(menuRow, 'text-destructive hover:text-destructive')}
              >
                <LogOut className="h-4 w-4 flex-shrink-0" />
                {sandbox ? tNav('logout_sandbox') : tCommon('logout')}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

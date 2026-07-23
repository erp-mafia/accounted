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
  Building2,
  Check,
  ChevronsUpDown,
  ChevronRight,
  CreditCard,
  HelpCircle,
  Loader2,
  LogOut,
  MessagesSquare,
  Plus,
  Search,
  Settings,
  Users,
} from 'lucide-react'

// Community invite (Accounted's Discord). Deliberately a constant, not
// branding config: self-hosted rebrands can hide or swap it when someone
// actually asks for that.
const DISCORD_INVITE_URL = 'https://discord.gg/D9SxtTgvx'

interface UserMenuProps {
  userName: string | null
  userEmail: string | null
  isSandbox: boolean
  collapsed: boolean
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
  onLogout,
}: UserMenuProps) {
  const { company, companies, isSandbox: companyCtxSandbox } = useCompany()
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
    if (company && companyId === company.id) {
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
    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] ' +
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
              {company && (
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

            {/* Company switcher flyout */}
            <div className="relative px-1 pt-1">
              <button
                type="button"
                onClick={() => setCompaniesOpen((v) => !v)}
                aria-expanded={companiesOpen}
                className={cn(menuRow, companiesOpen && 'bg-secondary/60 text-foreground')}
              >
                <Building2 className="h-4 w-4 flex-shrink-0" />
                <span className="flex-1 truncate">
                  {company?.name || tSwitcher('default_company_name')}
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
                    {filteredCompanies.map(({ company: c, role }) => (
                      <button
                        key={c.id}
                        onClick={() => handleSwitch(c.id)}
                        disabled={isPending}
                        role="option"
                        aria-selected={c.id === company?.id}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] leading-snug transition-colors',
                          c.id === company?.id
                            ? 'bg-secondary/60 text-foreground'
                            : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                          isPending && 'opacity-50',
                        )}
                      >
                        <Building2 className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        {role !== 'owner' && (
                          <span className="flex-shrink-0 text-[10px] text-muted-foreground/60">
                            {role}
                          </span>
                        )}
                        {c.id === company?.id && (
                          <Check className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
                        )}
                        {isPending && c.id !== company?.id && (
                          <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-muted-foreground" />
                        )}
                      </button>
                    ))}
                  </div>
                  {!sandbox && (
                    <div className="border-t border-border/60 px-1 pt-1">
                      <Link href="/select-company" onClick={close} className={menuRow}>
                        <Plus className="h-4 w-4 flex-shrink-0" />
                        {tSwitcher('add_company')}
                      </Link>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Account links */}
            <div className="px-1 pb-1">
              <Link href="/settings" onClick={close} className={menuRow}>
                <Settings className="h-4 w-4 flex-shrink-0" />
                {tNav('settings')}
              </Link>
              <Link href="/settings/team" onClick={close} className={menuRow}>
                <Users className="h-4 w-4 flex-shrink-0" />
                {tNav('members_roles')}
              </Link>
              <Link href="/settings/billing" onClick={close} className={menuRow}>
                <CreditCard className="h-4 w-4 flex-shrink-0" />
                {tNav('subscription')}
              </Link>
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
                <MessagesSquare className="h-4 w-4 flex-shrink-0" />
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

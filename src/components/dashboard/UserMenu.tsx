'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { POPOVER_ENTER_CLASS, POPOVER_ENTER_UP_CLASS, POPOVER_SURFACE_CLASS } from '@/components/ui/popover-surface'
import { useCompany } from '@/contexts/CompanyContext'
import { performCompanySwitch } from '@/lib/company/switch-client'
import { useToast } from '@/components/ui/use-toast'
import { SupportLink } from '@/components/ui/support-link'
import { DISCORD_INVITE_URL, DiscordLogo } from '@/components/community/discord'
import NewClientCompanyDialog from '@/components/dashboard/NewClientCompanyDialog'
import { ADD_COMPANY_HREF } from '@/components/settings/company-deletion'
import {
  ArrowRightStartOnRectangleIcon,
  ChevronRightIcon,
  ChevronUpDownIcon,
  Cog6ToothIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  QuestionMarkCircleIcon,
  SpinnerIcon,
  UserIcon,
  UsersIcon,
} from '@/components/icons'

interface UserMenuProps {
  userName: string | null
  userEmail: string | null
  isSandbox: boolean
  /**
   * Byrå cockpit: above the companies, where no row heads the sidebar with a
   * switcher, so the menu carries the company list, the byrå-scope settings
   * and the team. Inside a company it holds only what belongs to the person.
   */
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
      className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-sm bg-secondary text-xs font-semibold leading-none text-foreground"
    >
      {name.trim().charAt(0) || '?'}
    </span>
  )
}

/**
 * The sidebar's foot (V7 shell): one 30px row with the initials dot and the
 * name. Opens an upward popover aligned with the nav column holding identity,
 * account links and logout, and in the cockpit the company list.
 */
export default function UserMenu({
  userName,
  userEmail,
  isSandbox,
  cockpitMode = false,
  onLogout,
}: UserMenuProps) {
  const { company, companies, isSandbox: companyCtxSandbox, foreignCompanies = [], byraTeam, addCompanyHref = ADD_COMPANY_HREF } = useCompany()
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const tSettingsNav = useTranslations('settings_nav')
  const tSwitcher = useTranslations('company_switcher')
  const tClients = useTranslations('clients')
  const { toast } = useToast()

  const [open, setOpen] = useState(false)
  const [companiesOpen, setCompaniesOpen] = useState(false)
  const [clientDialogOpen, setClientDialogOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [isPending, setIsPending] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 232 })

  const sandbox = isSandbox || companyCtxSandbox
  // Byrå owner/admin get the client path next to "Lägg till företag", which
  // attaches to the user's personal team (WL-08): the explicit entry is how
  // a client lands in the byrå instead.
  const canCreateClient = byraTeam?.role === 'owner' || byraTeam?.role === 'admin'

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !menuRef.current) return
    const triggerRect = triggerRef.current.getBoundingClientRect()
    const menuRect = menuRef.current.getBoundingClientRect()
    const margin = 8
    // Upward popover: bottom edge sits just above the trigger, left-aligned
    // with the nav column.
    const top = Math.max(margin, triggerRect.top - menuRect.height - 6)
    const left = Math.max(margin, triggerRect.left)
    // As wide as the trigger when it spans a nav column, so the menu stays
    // inside the sidebar instead of spilling over the page beside it.
    const width = triggerRect.width >= 180 ? Math.round(triggerRect.width) : 232
    setMenuPos({ top, left, width })
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
  // opens above the menu; interacting with it must not unmount it). The
  // dialog's backdrop sits outside [role="dialog"], so while a modal dialog
  // is open the menu stays put: a click on the backdrop belongs to the
  // dialog, and closing the menu there would unmount the dialog with it.
  // data-state="open" narrows this to Radix dialogs; the docked assistant
  // sheet is also role="dialog" but must not pin the menu open.
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.isConnected) return
      if (target.closest('[role="dialog"]')) return
      if (document.querySelector('[role="dialog"][data-state="open"]')) return
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

  // In the cockpit nothing is "current": picking any company, including the
  // technically-active one, enters it (full navigation to its start).
  const handleSwitch = async (companyId: string) => {
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
    'flex min-h-7.5 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] ' +
    'text-foreground hover:bg-secondary/60 ' +
    'transition-colors duration-150 cursor-pointer'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="menu"
        className="group flex h-7.5 w-full items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 hover:bg-secondary/60 pointer-coarse:min-h-10"
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-control text-[11px] font-semibold text-foreground/80 shadow-raised">
          {accountInitial(userName, userEmail)}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block truncate text-[13px] leading-5 text-strong">
            {userName?.trim() || userEmail || tNav('mitt_konto')}
          </span>
        </span>
        <ChevronUpDownIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground opacity-50 group-hover:opacity-100" />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className={cn('fixed z-[60] p-1', POPOVER_SURFACE_CLASS, POPOVER_ENTER_UP_CLASS)}
            style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width }}
          >
            {/* Identity */}
            {(userName || userEmail) && (
              <div className="-mx-1 -mt-1 mb-1 border-b-hairline px-3.5 py-2.5">
                {userName && (
                  <p className="truncate text-[13px] font-medium text-foreground">{userName}</p>
                )}
                {userEmail && (
                  <p className="truncate text-xs text-muted-foreground">{userEmail}</p>
                )}
              </div>
            )}

            {/* Company switcher flyout, in the cockpit only: no company reads
                as active (neutral label, no check mark); picking one enters
                it like the Klienter list does. */}
            {cockpitMode && <div className="relative">
              <button
                type="button"
                onClick={() => setCompaniesOpen((v) => !v)}
                aria-expanded={companiesOpen}
                className={cn(menuRow, companiesOpen && 'bg-secondary/60 text-foreground')}
              >
                <CompanyMark name={company?.name || tSwitcher('default_company_name')} />
                <span className="min-w-0 flex-1 truncate">{tSwitcher('choose_company')}</span>
                <ChevronRightIcon className="h-3.5 w-3.5 flex-shrink-0 opacity-50" />
              </button>

              {companiesOpen && (
                // Top-aligned with the company row, growing DOWNWARD
                // (founder feedback 2026-07-23: never upward over the menu).
                <div className={cn('absolute top-0 left-full z-[61] ml-1.5 w-60 p-1', POPOVER_SURFACE_CLASS, POPOVER_ENTER_CLASS)}>
                  <div className="-mx-1 -mt-1 flex items-center gap-2 border-b-hairline px-3.5 pb-2 pt-2.5">
                    <MagnifyingGlassIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <input
                      ref={searchRef}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={tSwitcher('search_placeholder')}
                      className="w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none"
                    />
                  </div>
                  <div className="max-h-56 overflow-y-auto py-1" role="listbox">
                    {filteredCompanies.length === 0 && (
                      <p className="px-2.5 py-2 text-xs text-muted-foreground">
                        {tSwitcher('no_results')}
                      </p>
                    )}
                    {filteredCompanies.map(({ company: c, role }) => (
                      <button
                        key={c.id}
                        onClick={() => handleSwitch(c.id)}
                        disabled={isPending}
                        role="option"
                        aria-selected={false}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-[13px] leading-snug text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground',
                          isPending && 'opacity-50',
                        )}
                      >
                        <CompanyMark name={c.name} />
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        {role !== 'owner' && <span className="flex-shrink-0 text-xs text-muted-foreground">{role}</span>}
                        {isPending && <SpinnerIcon className="h-3 w-3 flex-shrink-0 animate-spin text-muted-foreground" />}
                      </button>
                    ))}
                  </div>
                  {/* Companies homed on another domain (home-domain rule,
                      WL-01): subtle, non-clickable signpost entries. */}
                  {foreignCompanies.length > 0 && (
                    <div className="-mx-1 border-t-hairline px-1 pt-1">
                      <p className="px-2.5 pb-0.5 pt-1 text-xs font-medium text-muted-foreground">
                        {tSwitcher('managed_elsewhere')}
                      </p>
                      {foreignCompanies.map((entry) => (
                        <div
                          key={entry.id}
                          className="px-2.5 py-1.5 text-xs leading-snug text-muted-foreground"
                          aria-disabled="true"
                        >
                          <span className="block truncate">{entry.name}</span>
                          <span className="block truncate text-xs">
                            {tSwitcher('managed_via', { domain: entry.domain })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {!sandbox && canCreateClient && (
                    <div className="-mx-1 border-t-hairline px-1 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          close()
                          setClientDialogOpen(true)
                        }}
                        className={menuRow}
                      >
                        <PlusIcon className="h-4 w-4 flex-shrink-0" />
                        {tClients('new_client_company')}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Adding a company sits in the menu itself, right under the
                  company row: behind the flyout, new users never found it
                  (PH 216, PH 202). */}
              {!sandbox && (
                <Link href={addCompanyHref} onClick={close} className={menuRow}>
                  <PlusIcon className="h-4 w-4 flex-shrink-0" />
                  {tSwitcher('add_company')}
                </Link>
              )}
            </div>}

            {/* Account links. Inside a company the row that heads the sidebar
                switches companies and the rail's gear opens the settings, so
                only the person's own account is here. From the cockpit,
                settings open in byrå scope (?ctx=byra): account-level sections
                only, so the row says Kontoinställningar (a client's own
                settings open from its row in the client list, crm#1237). */}
            <div className="px-1 pb-1">
              {cockpitMode ? (
                <>
                  <Link href="/settings/account?ctx=byra" onClick={close} className={menuRow}>
                    <Cog6ToothIcon className="h-4 w-4 flex-shrink-0" />
                    {tNav('account_settings')}
                  </Link>
                  <Link href="/settings/team?ctx=byra" onClick={close} className={menuRow}>
                    <UsersIcon className="h-4 w-4 flex-shrink-0" />
                    {tNav('members_roles')}
                  </Link>
                </>
              ) : (
                <Link href="/settings/account" onClick={close} className={menuRow}>
                  <UserIcon className="h-4 w-4 flex-shrink-0" />
                  {tSettingsNav('account')}
                </Link>
              )}
              <div className="-mx-1 my-1 border-t-hairline" />
              <Link href="/help" onClick={close} className={menuRow}>
                <QuestionMarkCircleIcon className="h-4 w-4 flex-shrink-0" />
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
              <div className="-mx-1 my-1 border-t-hairline" />
              <button
                type="button"
                onClick={() => {
                  close()
                  onLogout()
                }}
                className={cn(menuRow, 'text-destructive hover:text-destructive')}
              >
                <ArrowRightStartOnRectangleIcon className="h-4 w-4 flex-shrink-0" />
                {sandbox ? tNav('logout_sandbox') : tCommon('logout')}
              </button>
            </div>
          </div>,
          document.body,
        )}

      {canCreateClient && (
        <NewClientCompanyDialog open={clientDialogOpen} onOpenChange={setClientDialogOpen} />
      )}
    </>
  )
}

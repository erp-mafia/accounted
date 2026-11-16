'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  ArrowRightIcon,
  ArrowTrendingUpIcon,
  ArrowUpTrayIcon,
  ArrowsRightLeftIcon,
  BanknotesIcon,
  BookOpenIcon,
  ChartBarIcon,
  ClipboardDocumentCheckIcon,
  Cog6ToothIcon,
  CubeIcon,
  DocumentTextIcon,
  InboxIcon,
  PlusIcon,
  QuestionMarkCircleIcon,
  QueueListIcon,
  ScaleIcon,
  SparklesIcon,
  TruckIcon,
  UsersIcon,
  WalletIcon,
  type Icon as AppIcon,
} from '@/components/icons'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/count-tile'
import { useCompany } from '@/contexts/CompanyContext'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'
import { requiredCapabilityForExtension } from '@/lib/entitlements/keys'
import { passesNavGates, type NavGateContext, type ShellNavGate } from '@/lib/navigation/nav-gates'
import { getBranding } from '@/lib/branding/service'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { groupPalettePages, paletteOpensForRole, palettePages, paletteStartPages, type PageAlias } from './palette-pages'
import { INBOX_SEARCH_KEYWORDS, INKORG_HREF, LEGACY_INBOX_HREF } from '@/lib/inkorg/flag'
import { ADD_COMPANY_HREF } from '@/components/settings/company-deletion'

type Entry = {
  id: string
  label: string
  hint?: string
  icon: AppIcon
  href: string
  keywords?: string
  /** The extension a page outside /e/ needs, for the capability gate below. */
  extension?: { sector: string; id: string }
}

const ACTION_ENTRIES: Entry[] = [
  { id: 'new-invoice', label: 'Ny faktura', hint: 'Skapa & skicka faktura', icon: DocumentTextIcon, href: '/invoices/new', keywords: 'fakturera ny invoice send create' },
  { id: 'book-transaction', label: 'Boka transaktion', hint: 'Gå till transaktionsinkorgen', icon: ArrowsRightLeftIcon, href: '/transactions', keywords: 'transaktion bokför kategorisera categorize' },
  { id: 'new-customer', label: 'Lägg till kund', icon: UsersIcon, href: '/customers', keywords: 'kund customer ny lägg till' },
  { id: 'new-supplier-invoice', label: 'Skapa leverantörsfaktura', icon: WalletIcon, href: '/supplier-invoices?new=1', keywords: 'leverantörsfaktura supplier invoice ny' },
  { id: 'reports', label: 'Visa resultaträkning', hint: 'Rapporter', icon: ChartBarIcon, href: '/reports', keywords: 'rapport resultat balans report' },
]

/**
 * The words above are Swedish: what people type, and the label where the
 * entry has no message. An entry listed here is shown in the reader's
 * language (command_palette.*), and keeps its Swedish words as keywords so
 * the same typing finds it in both.
 */
const ENTRY_LABEL_KEYS: Record<string, { label: string; hint?: string }> = {
  'new-invoice': { label: 'action_new_invoice', hint: 'action_new_invoice_hint' },
  'book-transaction': { label: 'action_book_transaction', hint: 'action_book_transaction_hint' },
  'new-customer': { label: 'action_new_customer' },
  'new-supplier-invoice': { label: 'action_new_supplier_invoice' },
  reports: { label: 'action_reports', hint: 'action_reports_hint' },
  'rapport-saldobalans': { label: 'page_trial_balance' },
  'rapport-kundreskontra': { label: 'page_customer_ledger' },
  'inställningar': { label: 'page_settings' },
  help: { label: 'page_help' },
}

/** The entry in the reader's language; its Swedish label and hint stay searchable. */
export function localizeEntry<E extends Entry>(entry: E, translate: (key: string) => string): E {
  const keys = ENTRY_LABEL_KEYS[entry.id]
  if (!keys) return entry
  return {
    ...entry,
    label: translate(keys.label),
    hint: keys.hint ? translate(keys.hint) : entry.hint,
    keywords: [entry.keywords, entry.label, entry.hint].filter(Boolean).join(' '),
  }
}

/**
 * The actions, with "Lägg till företag" (the user menu's door, under the
 * label the menu shows, found by the words people typed for it in PH 216 and
 * PH 202: company_switcher.add_company_keywords) unless it is null: a sandbox
 * has no such door.
 */
export function actionEntries(addCompany: { label: string; keywords: string; href?: string } | null): Entry[] {
  if (!addCompany) return ACTION_ENTRIES
  return [...ACTION_ENTRIES, { id: 'add-company', icon: PlusIcon, ...addCompany, href: addCompany.href ?? ADD_COMPANY_HREF }]
}

/** The words people type for a page, and the destinations without a menu row (see palette-pages.ts). */
export const PAGE_ALIASES: PageAlias[] = [
  { id: 'kunder', label: 'Kunder', icon: UsersIcon, href: '/customers' },
  { id: 'leverantörer', label: 'Leverantörer', icon: TruckIcon, href: '/suppliers' },
  { id: 'kundfakturor', label: 'Kundfakturor', icon: DocumentTextIcon, href: '/invoices', keywords: 'fakturor fakturering invoices kundfaktura' },
  { id: 'leverantörsfakturor', label: 'Leverantörsfakturor', icon: WalletIcon, href: '/supplier-invoices' },
  { id: 'bokföring', label: 'Bokföring', icon: BookOpenIcon, href: '/bookkeeping', keywords: 'verifikat verifikationer journal ledger' },
  { id: 'kontoplan', label: 'Kontoplan', icon: QueueListIcon, href: '/chart-of-accounts', keywords: 'kontoplan konton bas chart of accounts konto' },
  { id: 'anläggningstillgångar', label: 'Anläggningstillgångar', icon: CubeIcon, href: '/assets', keywords: 'tillgångar assets' },
  { id: 'rapporter', label: 'Rapporter', icon: ChartBarIcon, href: '/reports' },
  { id: 'rapport-resultatrapport', label: 'Visa rapport: Resultatrapport', icon: ChartBarIcon, href: '/reports/resultatrapport', keywords: 'rapport resultat resultaträkning intäkter kostnader' },
  { id: 'rapport-balansrapport', label: 'Visa rapport: Balansrapport', icon: ChartBarIcon, href: '/reports/balansrapport', keywords: 'rapport balans tillgångar skulder saldo per konto' },
  { id: 'rapport-saldobalans', label: 'Visa rapport: Saldobalans', icon: ChartBarIcon, href: '/reports/trial-balance', keywords: 'rapport saldobalans trial balance saldo per konto' },
  { id: 'rapport-moms', label: 'Visa rapport: Momsdeklaration', icon: ChartBarIcon, href: '/reports/vat-declaration', keywords: 'rapport moms vat deklaration' },
  // "verifikat" is the word a bookkeeper reaches for ("verifikat per konto"),
  // and matches() requires every typed token, so leaving it out made the exact
  // phrase return nothing even though this report is precisely the answer.
  // Deliberately NOT carrying "stäm av"/"avstämning" here: the palette
  // auto-selects the first hit and the report rows are listed above the
  // reconciliation aliases, so those words would hijack Enter from the
  // reconciliation page. They live in ReportDescriptor.searchTerms instead,
  // where the library shows a list.
  { id: 'rapport-huvudbok', label: 'Visa rapport: Huvudbok', icon: BookOpenIcon, href: '/reports/huvudbok', keywords: 'rapport huvudbok ledger general konto saldo transaktioner per konto verifikat verifikationer verifikationer per konto kontoutdrag kontoanalys kontokort kontohistorik balance account statement transactions vouchers' },
  { id: 'rapport-kundreskontra', label: 'Visa rapport: Kundreskontra', icon: UsersIcon, href: '/reports/kundreskontra', keywords: 'rapport kundreskontra ar kundfordringar' },
  { id: 'avstamning', label: 'Avstämning', hint: 'Stäm av bank och skattekonto', icon: ScaleIcon, href: '/accounts', keywords: 'avstämning stäm av bank skattekonto matcha reconcile reconciliation 1630 1930' },
  { id: 'rapport-bankavstamning', label: 'Bankavstämning', hint: 'Stäm av bank mot bokföring', icon: ArrowsRightLeftIcon, href: '/accounts', keywords: 'avstämning stäm av bank matcha banktransaktioner reconcile reconciliation 1930' },
  { id: 'importera', label: 'Importera', icon: ArrowUpTrayIcon, href: '/import' },
  { id: 'granskning', label: 'Granskning', icon: ClipboardDocumentCheckIcon, href: '/pending', keywords: 'agentförslag förslag pending review' },
  { id: 'löner', label: 'Löner', icon: BanknotesIcon, href: '/salary' },
  { id: 'anställda', label: 'Anställda', icon: UsersIcon, href: '/salary/employees' },
  // The inbox, on whichever page the menu puts it (lib/inkorg/flag.ts): both
  // rows answer to the old names and to "utlägg" and "kvitto".
  { id: 'dokumentinkorg', label: 'Dokumentinkorg', icon: InboxIcon, href: LEGACY_INBOX_HREF, keywords: INBOX_SEARCH_KEYWORDS },
  { id: 'inkorg', label: 'Inkorg', icon: InboxIcon, href: INKORG_HREF, keywords: INBOX_SEARCH_KEYWORDS },
  { id: 'nyckeltal', label: 'Nyckeltal', icon: ArrowTrendingUpIcon, href: '/kpi' },
  // Arbetssätt answers to the names the page had before (founder decision 2026-11-16).
  { id: 'kompetens', label: 'Kompetens', icon: SparklesIcon, href: '/skills', keywords: 'instruktioner skills' },
  { id: 'inställningar', label: 'Inställningar', icon: Cog6ToothIcon, href: '/settings' },
  { id: 'help', label: 'Hjälp', icon: QuestionMarkCircleIcon, href: '/help' },
]

/** The gates as the layout resolved them: the object DashboardNav is handed. */
export type PaletteNavGate = ShellNavGate

export function matches(entry: Entry, q: string): boolean {
  const hay = `${entry.label} ${entry.hint ?? ''} ${entry.keywords ?? ''}`.toLowerCase()
  return q.split(/\s+/).filter(Boolean).every(t => hay.includes(t))
}

export default function CommandPalette({
  initialOpen = false,
  navGate = null,
}: { initialOpen?: boolean; navGate?: PaletteNavGate | null } = {}) {
  const router = useRouter()
  // initialOpen: LazyCommandPalette mounts this component on the first ⌘K,
  // so the palette must come up already open rather than waiting for a
  // second keypress.
  const [open, setOpen] = useState(initialOpen)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { company, capabilities, isSandbox, addCompanyHref, byraTeam, role } = useCompany()
  const { identity } = useAgentSheet()
  const tSwitcher = useTranslations('company_switcher')
  const tNav = useTranslations('nav')
  const t = useTranslations('command_palette')
  const addCompanyLabel = isSandbox ? null : tSwitcher('add_company')
  const addCompanyKeywords = tSwitcher('add_company_keywords')

  // Drop entries that jump to a paywalled extension workspace the active
  // company can't reach (e.g. the AI-only Dokumentinkorg). The page itself is
  // gated server-side; this keeps ⌘K from offering a dead destination.
  const allowedByCapability = useMemo(() => {
    return (entry: Entry) => {
      const m = entry.href.match(/^\/e\/([^/]+)\/([^/?#]+)/)
      const extension = entry.extension ?? (m ? { sector: m[1], id: m[2] } : null)
      if (!extension) return true
      const required = requiredCapabilityForExtension(extension.sector, extension.id)
      return !required || capabilities.includes(required)
    }
  }, [capabilities])

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setQuery('')
      setActiveIndex(0)
    }
  }

  // Global ⌘K / Ctrl+K
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(prev => !prev)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open])

  const q = query.trim().toLowerCase()

  const filteredActions = useMemo(() => {
    const addCompany = addCompanyLabel ? { label: addCompanyLabel, keywords: addCompanyKeywords, href: addCompanyHref } : null
    // "Lägg till företag" leaves the company, so it is not a page of the role.
    const visible = actionEntries(addCompany)
      .map((entry) => localizeEntry(entry, (key) => t(key as never)))
      .filter(allowedByCapability)
      .filter((entry) => entry.id === 'add-company' || paletteOpensForRole(role, entry.href))
    return q ? visible.filter(e => matches(e, q)) : visible
  }, [q, allowedByCapability, addCompanyLabel, addCompanyKeywords, addCompanyHref, role, t])
  // The pages are the shell's own tree (nav-v3.ts), gated as the sidebar
  // gates it for this company and grouped by area (palette-pages.ts).
  const hasCompany = !!company
  const isByraMember = !!byraTeam
  const pages = useMemo(() => {
    const gateContext: NavGateContext | null = navGate
      ? {
          ...navGate,
          mcpExtensionEnabled: ENABLED_EXTENSION_IDS.has('mcp-server'),
          capabilities,
          hiddenNavHrefs: new Set(getBranding().hiddenNavHrefs),
          role,
        }
      : null
    return palettePages({
      passes: (item) => !!gateContext && passesNavGates(item, gateContext),
      hasCompany: hasCompany && !!gateContext,
      isByraMember,
      navLabel: (key) => tNav(key as never),
      aliases: PAGE_ALIASES,
    })
      .map((page) => localizeEntry(page, (key) => t(key as never)))
      .filter(allowedByCapability)
      .filter((page) => paletteOpensForRole(role, page.href))
  }, [navGate, capabilities, role, hasCompany, isByraMember, tNav, t, allowedByCapability])
  const filteredPages = useMemo(
    () => (q ? pages.filter(e => matches(e, q)) : paletteStartPages(pages)),
    [q, pages],
  )
  // Typed: the hits under their area. Nothing typed: one row per area.
  const pageGroups = q ? groupPalettePages(filteredPages) : [{ group: t('section_pages'), pages: filteredPages }]

  // The hand-off-to-assistant entries use the agent name the user chose in
  // /onboarding/agent, and hide entirely until that onboarding is done: the
  // same gate as the FAB.
  const assistantName = identity.displayName?.trim() || t('assistant_default_name')
  // With no hit it is the one entry; with hits it follows them.
  const noHits = filteredActions.length === 0 && filteredPages.length === 0
  const assistantFallback: Entry | null = !identity.isVerified || !q || !paletteOpensForRole(role, '/chat/new')
    ? null
    : {
        id: noHits ? 'assistant-fallback' : 'assistant-followup',
        label: t(noHits ? 'ask_assistant' : 'ask_assistant_instead', { name: assistantName, query: query.trim() }),
        icon: SparklesIcon,
        href: `/chat/new?prompt=${encodeURIComponent(query.trim())}`,
      }

  // One list for the arrow keys: the order the sections below draw.
  const flatEntries: Entry[] = [...filteredActions, ...filteredPages, ...(assistantFallback ? [assistantFallback] : [])]

  function commit(entry: Entry) {
    setOpen(false)
    router.push(entry.href)
  }

  const row = (entry: Entry) => {
    const idx = flatEntries.indexOf(entry)
    return <Row key={entry.id} entry={entry} active={idx === activeIndex} onSelect={() => commit(entry)} onHover={() => setActiveIndex(idx)} />
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => Math.min(flatEntries.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = flatEntries[activeIndex]
      if (target) commit(target)
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-veil data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          aria-label={t('title')}
          className="fixed left-[50%] top-[72px] z-50 w-[calc(100vw-2rem)] max-w-[560px] translate-x-[-50%] overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-float data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-98 data-[state=open]:slide-in-from-bottom-2 data-[state=open]:duration-300 data-[state=open]:ease-emphasized"
        >
          <DialogPrimitive.Title className="sr-only">{t('title')}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {t('description')}
          </DialogPrimitive.Description>
          <div className="border-b-hairline px-4 py-3">
            <input
              ref={inputRef}
              value={query}
              onChange={e => { setQuery(e.target.value); setActiveIndex(0) }}
              onKeyDown={onInputKey}
              placeholder={t('placeholder')}
              aria-label={t('search_label')}
              className="w-full bg-transparent text-[15px] placeholder:text-muted-foreground outline-none"
            />
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-1" role="listbox">
            {filteredActions.length > 0 && <Section title={t('section_actions')}>{filteredActions.map(row)}</Section>}
            {pageGroups.map(({ group, pages: groupPages }) =>
              groupPages.length === 0 ? null : (
                <Section key={group} title={group}>
                  {groupPages.map(row)}
                </Section>
              ),
            )}
            {assistantFallback && <Section title={assistantName}>{row(assistantFallback)}</Section>}
            {flatEntries.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {t('empty')}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between border-t-hairline px-4 py-2 text-xs text-muted-foreground">
            <span>{t('keys_hint')}</span>
            <Kbd>⌘K</Kbd>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5 last:mb-0">
      <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">{title}</p>
      <div>{children}</div>
    </div>
  )
}

function Row({
  entry,
  active,
  onSelect,
  onHover,
}: {
  entry: Entry
  active: boolean
  onSelect: () => void
  onHover: () => void
}) {
  const Icon = entry.icon
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      onFocus={onHover}
      onClick={onSelect}
      className={cn(
        'flex min-h-7.5 w-full items-center gap-3 rounded-md px-3 py-1.5 text-left text-sm transition-colors duration-150',
        active ? 'bg-secondary/60 text-strong' : 'text-foreground hover:bg-secondary/60',
      )}
    >
      <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
      {entry.hint && <span className="text-xs text-muted-foreground">{entry.hint}</span>}
      {active && <ArrowRightIcon className="h-3.5 w-3.5 text-muted-foreground" />}
    </button>
  )
}

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ArrowRight, Wand2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCompany } from '@/contexts/CompanyContext'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'
import { useSettingsNavItems } from '@/components/settings/useSettingsNavItems'
import { getBranding } from '@/lib/branding/service'
import { isEmployerCompany, type NavGateContext } from '@/components/dashboard/nav-gates'
import {
  buildPaletteEntries,
  groupPaletteResults,
  type PaletteEntry,
  type PaletteSection,
} from './command-palette-entries'
import { COMMAND_PALETTE_OPEN_EVENT, isCommandPaletteShortcut } from './command-palette-events'
import {
  commandPaletteShortcutLabel,
  settingsShortcutLabel,
  useIsApplePlatform,
} from './use-shortcut-modifier'
import type { DashboardShell, EntityType } from '@/types'

/**
 * The layout's nav flags, passed through LazyCommandPalette: the same values
 * DashboardNav receives, so the palette shows and hides a destination for
 * exactly the reason the sidebar does (nav-gates.ts).
 */
export interface CommandPaletteGateProps {
  entityType: EntityType
  paysSalaries: boolean
  dimensionsEnabled: boolean
  salesOrdersEnabled: boolean
  hasWebshop: boolean
  hasMileage: boolean
  hasExpenseClaims: boolean
  shell: DashboardShell
}

interface CommandPaletteProps extends CommandPaletteGateProps {
  /**
   * LazyCommandPalette mounts this component on the first ⌘K or trigger
   * tap, so the palette must come up already open rather than waiting for
   * a second keypress.
   */
  initialOpen?: boolean
}

const SECTION_TITLE_KEY = {
  actions: 'section_actions',
  pages: 'section_pages',
  reports: 'section_reports',
  settings: 'section_settings',
} as const satisfies Record<PaletteSection, string>

export default function CommandPalette({
  initialOpen = false,
  entityType,
  paysSalaries,
  dimensionsEnabled,
  salesOrdersEnabled,
  hasWebshop,
  hasMileage,
  hasExpenseClaims,
  shell,
}: CommandPaletteProps) {
  const router = useRouter()
  const t = useTranslations('command_palette')
  const tNav = useTranslations('nav')
  const tReports = useTranslations('reports')
  const [open, setOpen] = useState(initialOpen)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { company, capabilities, byraTeam } = useCompany()
  const { identity } = useAgentSheet()
  const { items: settingsSections } = useSettingsNavItems()
  const isApple = useIsApplePlatform()

  const entries = useMemo(() => {
    const gates: NavGateContext = {
      entityType,
      isEmployer: isEmployerCompany(entityType, paysSalaries),
      dimensionsEnabled,
      salesOrdersEnabled,
      hasWebshop,
      hasMileage,
      hasExpenseClaims,
      capabilities,
      hiddenNavHrefs: new Set(getBranding().hiddenNavHrefs),
      assistantVerified: identity.isVerified,
    }
    return buildPaletteEntries({
      gates,
      hasCompany: !!company,
      isByraMember: !!byraTeam,
      shell,
      settingsSections,
      settingsShortcut: settingsShortcutLabel(isApple),
      labels: {
        nav: (key) => tNav(key),
        reports: (key) => tReports(key),
        palette: (key) => t(key),
      },
    })
  }, [
    entityType,
    paysSalaries,
    dimensionsEnabled,
    salesOrdersEnabled,
    hasWebshop,
    hasMileage,
    hasExpenseClaims,
    capabilities,
    identity.isVerified,
    company,
    byraTeam,
    shell,
    settingsSections,
    isApple,
    t,
    tNav,
    tReports,
  ])

  const groups = useMemo(() => groupPaletteResults(entries, query), [entries, query])

  // The hand-off-to-assistant row uses the agent name the user chose in
  // /onboarding/agent, and hides entirely until that onboarding is done:
  // the same gate as the nav entry and the FAB. Alone when nothing else
  // matched, last otherwise.
  const trimmed = query.trim()
  const assistantName = identity.displayName?.trim() || t('assistant_default')
  const hasResults = groups.length > 0
  const assistantEntry: PaletteEntry | null =
    identity.isVerified && trimmed
      ? {
          id: 'assistant',
          section: 'pages',
          label: hasResults
            ? t('ask_assistant_instead', { name: assistantName, query: trimmed })
            : t('ask_assistant', { name: assistantName, query: trimmed }),
          icon: Wand2,
          href: `/chat/new?prompt=${encodeURIComponent(trimmed)}`,
          keywords: '',
        }
      : null

  const flat = groups.flatMap((g) => g.entries)
  const rows: PaletteEntry[] = assistantEntry ? [...flat, assistantEntry] : flat
  const selected = Math.min(activeIndex, Math.max(0, rows.length - 1))

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setQuery('')
      setActiveIndex(0)
    }
  }

  // Global ⌘K / Ctrl+K toggles; a trigger tap (sidebar, mobile sheet) opens.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isCommandPaletteShortcut(e)) {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    function onOpen() {
      setOpen(true)
    }
    document.addEventListener('keydown', onKey)
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open])

  function commit(entry: PaletteEntry) {
    setOpen(false)
    setQuery('')
    setActiveIndex(0)
    router.push(entry.href)
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(Math.min(rows.length - 1, selected + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(Math.max(0, selected - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = rows[selected]
      if (target) commit(target)
    }
  }

  const renderRow = (entry: PaletteEntry) => {
    const idx = rows.indexOf(entry)
    return (
      <Row
        key={entry.id}
        entry={entry}
        active={idx === selected}
        onSelect={() => commit(entry)}
        onHover={() => setActiveIndex(idx)}
      />
    )
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-label={t('title')}
          className="fixed left-[50%] top-[20%] z-50 w-[calc(100vw-2rem)] max-w-xl translate-x-[-50%] rounded-xl border border-border bg-card data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          <DialogPrimitive.Title className="sr-only">{t('title')}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{t('description')}</DialogPrimitive.Description>
          <div className="px-4 py-3 border-b border-border">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={onInputKey}
              placeholder={t('placeholder')}
              aria-label={t('input_aria')}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full bg-transparent text-base placeholder:text-muted-foreground outline-none"
            />
          </div>

          <div className="max-h-[60vh] overflow-y-auto py-1.5" role="listbox">
            {assistantEntry && !hasResults && (
              <Section title={assistantName}>{renderRow(assistantEntry)}</Section>
            )}
            {groups.map((group) => (
              <Section key={group.section} title={t(SECTION_TITLE_KEY[group.section])}>
                {group.entries.map(renderRow)}
              </Section>
            ))}
            {assistantEntry && hasResults && (
              <Section title={assistantName}>{renderRow(assistantEntry)}</Section>
            )}
            {rows.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">{t('empty')}</div>
            )}
          </div>

          <div className="px-4 py-2 border-t border-border flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{t('footer_keys')}</span>
            <kbd className="rounded-sm border border-border px-1 font-sans text-[10px] leading-4">
              {commandPaletteShortcutLabel(isApple)}
            </kbd>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5 last:mb-0">
      <p className="px-4 pt-2 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {title}
      </p>
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
  entry: PaletteEntry
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
        'w-full text-left flex items-center gap-3 px-4 py-2 text-sm transition-colors',
        active ? 'bg-secondary text-foreground' : 'text-foreground hover:bg-secondary/60',
      )}
    >
      <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      <span className="flex-1 truncate">{entry.label}</span>
      {entry.hint && <span className="text-xs text-muted-foreground truncate">{entry.hint}</span>}
      {active && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />}
    </button>
  )
}

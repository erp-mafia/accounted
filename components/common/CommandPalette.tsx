'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  ReceiptText,
  ArrowLeftRight,
  Users,
  Wallet,
  Building2,
  BookOpen,
  ListTree,
  BarChart3,
  Upload,
  Package,
  ClipboardCheck,
  HandCoins,
  Wand2,
  Inbox,
  TrendingUp,
  Settings,
  HelpCircle,
  ArrowRight,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type Entry = {
  id: string
  label: string
  hint?: string
  icon: LucideIcon
  href: string
  keywords?: string
}

const ACTION_ENTRIES: Entry[] = [
  { id: 'new-invoice', label: 'Ny faktura', hint: 'Skapa & skicka faktura', icon: ReceiptText, href: '/invoices?new=1', keywords: 'fakturera ny invoice send create' },
  { id: 'book-transaction', label: 'Boka transaktion', hint: 'Gå till transaktionsinkorgen', icon: ArrowLeftRight, href: '/transactions', keywords: 'transaktion bokför kategorisera categorize' },
  { id: 'new-customer', label: 'Lägg till kund', icon: Users, href: '/customers', keywords: 'kund customer ny lägg till' },
  { id: 'new-supplier-invoice', label: 'Skapa leverantörsfaktura', icon: Wallet, href: '/supplier-invoices?new=1', keywords: 'leverantörsfaktura supplier invoice ny' },
  { id: 'reports', label: 'Visa resultaträkning', hint: 'Rapporter', icon: BarChart3, href: '/reports', keywords: 'rapport resultat balans report' },
]

const PAGE_ENTRIES: Entry[] = [
  { id: 'kunder', label: 'Kunder', icon: Users, href: '/customers' },
  { id: 'leverantörer', label: 'Leverantörer', icon: Building2, href: '/suppliers' },
  { id: 'leverantörsfakturor', label: 'Leverantörsfakturor', icon: Wallet, href: '/supplier-invoices' },
  { id: 'bokföring', label: 'Bokföring', icon: BookOpen, href: '/bookkeeping', keywords: 'verifikat journal ledger' },
  { id: 'kontoplan', label: 'Kontoplan', icon: ListTree, href: '/chart-of-accounts', keywords: 'kontoplan konton bas chart of accounts konto' },
  { id: 'anläggningstillgångar', label: 'Anläggningstillgångar', icon: Package, href: '/assets', keywords: 'tillgångar assets' },
  { id: 'rapporter', label: 'Rapporter', icon: BarChart3, href: '/reports' },
  { id: 'rapport-resultatrapport', label: 'Visa rapport: Resultatrapport', icon: BarChart3, href: '/reports/resultatrapport', keywords: 'rapport resultat intäkter kostnader' },
  { id: 'rapport-balansrapport', label: 'Visa rapport: Balansrapport', icon: BarChart3, href: '/reports/balansrapport', keywords: 'rapport balans tillgångar skulder saldo per konto' },
  { id: 'rapport-saldobalans', label: 'Visa rapport: Saldobalans', icon: BarChart3, href: '/reports/trial-balance', keywords: 'rapport saldobalans trial balance saldo per konto' },
  { id: 'rapport-moms', label: 'Visa rapport: Momsdeklaration', icon: BarChart3, href: '/reports/vat-declaration', keywords: 'rapport moms vat deklaration' },
  { id: 'rapport-huvudbok', label: 'Visa rapport: Huvudbok', icon: BookOpen, href: '/reports/huvudbok', keywords: 'rapport huvudbok ledger general konto saldo transaktioner per konto kontoutdrag kontoanalys kontokort kontohistorik balance account statement transactions' },
  { id: 'rapport-kundreskontra', label: 'Visa rapport: Kundreskontra', icon: Users, href: '/reports/kundreskontra', keywords: 'rapport kundreskontra ar kundfordringar' },
  { id: 'importera', label: 'Importera', icon: Upload, href: '/import' },
  { id: 'granskning', label: 'Granskning', icon: ClipboardCheck, href: '/pending', keywords: 'pending review' },
  { id: 'löner', label: 'Löner', icon: HandCoins, href: '/salary' },
  { id: 'anställda', label: 'Anställda', icon: Users, href: '/salary/employees' },
  { id: 'dokumentinkorg', label: 'Dokumentinkorg', icon: Inbox, href: '/e/general/invoice-inbox' },
  { id: 'nyckeltal', label: 'Nyckeltal', icon: TrendingUp, href: '/kpi' },
  { id: 'inställningar', label: 'Inställningar', icon: Settings, href: '/settings' },
  { id: 'hjälp', label: 'Hjälp', icon: HelpCircle, href: '/help' },
]

function matches(entry: Entry, q: string): boolean {
  const hay = `${entry.label} ${entry.hint ?? ''} ${entry.keywords ?? ''}`.toLowerCase()
  return q.split(/\s+/).filter(Boolean).every(t => hay.includes(t))
}

export default function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

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

  const filteredActions = useMemo(
    () => (q ? ACTION_ENTRIES.filter(e => matches(e, q)) : ACTION_ENTRIES),
    [q],
  )
  const filteredPages = useMemo(
    () => (q ? PAGE_ENTRIES.filter(e => matches(e, q)) : PAGE_ENTRIES.slice(0, 6)),
    [q],
  )

  const annaFallback: Entry | null = q && filteredActions.length === 0 && filteredPages.length === 0
    ? {
        id: 'anna-fallback',
        label: `Fråga Anna: "${query.trim()}"`,
        icon: Wand2,
        href: `/chat?prompt=${encodeURIComponent(query.trim())}`,
      }
    : q
      ? {
          id: 'anna-followup',
          label: `Fråga Anna istället: "${query.trim()}"`,
          icon: Wand2,
          href: `/chat?prompt=${encodeURIComponent(query.trim())}`,
        }
      : null

  const flatEntries: Entry[] = [
    ...(annaFallback && filteredActions.length === 0 && filteredPages.length === 0 ? [annaFallback] : []),
    ...filteredActions,
    ...filteredPages,
    ...(annaFallback && (filteredActions.length > 0 || filteredPages.length > 0) ? [annaFallback] : []),
  ]

  function commit(entry: Entry) {
    setOpen(false)
    router.push(entry.href)
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
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          aria-label="Snabbkommandon"
          className="fixed left-[50%] top-[20%] z-50 w-[calc(100vw-2rem)] max-w-xl translate-x-[-50%] rounded-xl border border-border bg-card data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          <DialogPrimitive.Title className="sr-only">Snabbkommandon</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Sök efter sidor och åtgärder, eller fråga Anna.
          </DialogPrimitive.Description>
          <div className="px-4 py-3 border-b border-border">
            <input
              ref={inputRef}
              value={query}
              onChange={e => { setQuery(e.target.value); setActiveIndex(0) }}
              onKeyDown={onInputKey}
              placeholder="Sök eller skriv vad du vill göra…"
              aria-label="Sök eller skriv vad du vill göra"
              className="w-full bg-transparent text-base placeholder:text-muted-foreground outline-none"
            />
          </div>

          <div className="max-h-[60vh] overflow-y-auto py-1.5" role="listbox">
            {filteredActions.length > 0 && (
              <Section title="Åtgärder">
                {filteredActions.map((entry) => {
                  const idx = flatEntries.indexOf(entry)
                  return (
                    <Row
                      key={entry.id}
                      entry={entry}
                      active={idx === activeIndex}
                      onSelect={() => commit(entry)}
                      onHover={() => setActiveIndex(idx)}
                    />
                  )
                })}
              </Section>
            )}
            {filteredPages.length > 0 && (
              <Section title="Sidor">
                {filteredPages.map((entry) => {
                  const idx = flatEntries.indexOf(entry)
                  return (
                    <Row
                      key={entry.id}
                      entry={entry}
                      active={idx === activeIndex}
                      onSelect={() => commit(entry)}
                      onHover={() => setActiveIndex(idx)}
                    />
                  )
                })}
              </Section>
            )}
            {annaFallback && (
              <Section title="Anna">
                <Row
                  entry={annaFallback}
                  active={flatEntries.indexOf(annaFallback) === activeIndex}
                  onSelect={() => commit(annaFallback)}
                  onHover={() => setActiveIndex(flatEntries.indexOf(annaFallback))}
                />
              </Section>
            )}
            {flatEntries.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                Inget hittades. Tryck Enter eller börja om.
              </div>
            )}
          </div>

          <div className="px-4 py-2 border-t border-border flex items-center justify-between text-[11px] text-muted-foreground">
            <span>↑↓ navigera · Enter välj · Esc stäng</span>
            <span className="font-mono">⌘K</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5 last:mb-0">
      <p className="px-4 pt-2 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{title}</p>
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
        'w-full text-left flex items-center gap-3 px-4 py-2 text-sm transition-colors',
        active ? 'bg-secondary text-foreground' : 'text-foreground hover:bg-secondary/60',
      )}
    >
      <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      <span className="flex-1 truncate">{entry.label}</span>
      {entry.hint && <span className="text-xs text-muted-foreground">{entry.hint}</span>}
      {active && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />}
    </button>
  )
}

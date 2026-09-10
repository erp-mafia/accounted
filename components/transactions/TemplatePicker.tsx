'use client'

import { useState, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Search, ChevronDown, ChevronUp, AlertTriangle, Info, PenLine, Briefcase } from 'lucide-react'
import {
  getCommonTemplates,
  getAdvancedTemplates,
  searchTemplates,
  type BookingTemplate,
  type TemplateGroup,
} from '@/lib/bookkeeping/booking-templates'
import {
  buildActiveAccountIndex,
  searchAccounts,
  type AccountSearchItem,
} from '@/lib/bookkeeping/account-search'
import { formatAccountWithName } from '@/lib/bookkeeping/client-account-names'
import { isCounterpartyTemplateId } from '@/lib/bookkeeping/counterparty-templates'
import { convertLibraryToBookingTemplate, LIBRARY_TEMPLATE_PREFIX, isLibraryTemplateId } from '@/lib/bookkeeping/template-library'
import { GROUP_LABEL_KEYS, GROUP_ORDER, libraryTemplateGroup } from '@/lib/bookkeeping/template-groups'
import { getAccountName } from '@/lib/bookkeeping/client-account-names'
import type { BookingTemplateLibrary, EntityType } from '@/types'
import type { SuggestedTemplate } from '@/lib/transactions/category-suggestions'
import { useAccounts, useBookingTemplates } from '@/lib/reference-data/hooks'
import { cn } from '@/lib/utils'
import { HUE_DOT_CLASS, accountHue, templateGroupHue, type TemplateHue } from '@/lib/bookkeeping/template-group-colors'

/** The account a template books against: the leg that is not the cash account. */
function categoryAccount(debit: string, credit: string): string {
  return debit.startsWith('19') ? credit : debit
}

/**
 * Dense mode (shell v2, the Kick-style picker beside the row): one line per
 * template with a colour dot for its family, the name, and the account.
 */
function DenseRow({
  hue,
  name,
  account,
  note,
  selected,
  onClick,
}: {
  hue: TemplateHue
  name: string
  account?: string | null
  note?: string | null
  selected?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-sm px-3 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-secondary/60',
        selected && 'bg-secondary',
      )}
    >
      <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', HUE_DOT_CLASS[hue])} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {note && <span className="shrink-0 text-[10.5px] text-muted-foreground">{note}</span>}
      {account && <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-muted-foreground">{account}</span>}
    </button>
  )
}

// Cap on the "Konton" search-result group: enough to cover sibling accounts
// on a number-prefix query without drowning the template results.
const ACCOUNT_RESULT_LIMIT = 8

function getVatLabelKey(template: BookingTemplate): string | null {
  if (!template.vat_treatment) return null
  switch (template.vat_treatment) {
    case 'standard_25': return 'vat_standard_25'
    case 'reduced_12': return 'vat_reduced_12'
    case 'reduced_6': return 'vat_reduced_6'
    case 'reverse_charge': return 'vat_reverse_charge'
    case 'export': return 'vat_export'
    case 'exempt': return 'vat_exempt'
    default: return null
  }
}

// Reverse charge (omvänd moms) carries the ochre emphasis via the sanctioned
// `warning` variant; every other VAT treatment uses the neutral `secondary`.
function getVatBadgeVariant(vatTreatment: string | null | undefined): 'secondary' | 'warning' {
  return vatTreatment === 'reverse_charge' ? 'warning' : 'secondary'
}

function groupTemplates(templates: BookingTemplate[]): Map<TemplateGroup, BookingTemplate[]> {
  const grouped = new Map<TemplateGroup, BookingTemplate[]>()
  for (const t of templates) {
    const list = grouped.get(t.group) || []
    list.push(t)
    grouped.set(t.group, list)
  }
  return grouped
}

interface TemplateCardProps {
  template: BookingTemplate
  selected: boolean
  onClick: () => void
  compact?: boolean
  dense?: boolean
}

interface LibraryTemplateCardProps {
  raw: BookingTemplateLibrary
  converted: BookingTemplate | null
  selected: boolean
  onClick: () => void
  dense?: boolean
}

function LibraryTemplateCard({ raw, converted, selected, onClick, dense }: LibraryTemplateCardProps) {
  const t = useTranslations('tx_template_picker')
  // Convertible templates render the familiar two-account summary; complex
  // ones list the business legs (the cost/revenue accounts) so the user can
  // recognise the template at a glance, and carry an "opens editor" badge.
  const businessLines = raw.lines.filter((l) => l.type === 'business')
  // The leg that says what the template is about: a result account (3xxx to
  // 8xxx) before a balance one, so a salary template reads 7010, not 2710.
  const shownLine = businessLines.find((l) => /^[3-8]/.test(l.account)) ?? businessLines[0] ?? raw.lines[0]
  const vatLabelKey = converted ? getVatLabelKey(converted) : null
  if (dense) {
    const account = converted ? categoryAccount(converted.debit_account, converted.credit_account) : (shownLine?.account ?? null)
    return <DenseRow hue={templateGroupHue(libraryTemplateGroup(raw))} name={raw.name} account={account} note={vatLabelKey ? t(vatLabelKey) : null} selected={selected} onClick={onClick} />
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors hover:bg-muted/50 ${
        selected
          ? 'border-primary bg-primary/5 ring-1 ring-primary'
          : 'border-border'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm leading-tight">{raw.name}</p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {converted ? (
              <span className="text-xs font-mono text-muted-foreground">
                D: {formatAccountWithName(converted.debit_account)} &middot; K: {formatAccountWithName(converted.credit_account)}
              </span>
            ) : (
              <span className="text-xs font-mono text-muted-foreground">
                {businessLines.slice(0, 2).map((l) => formatAccountWithName(l.account)).join(' · ') || raw.lines.map((l) => l.account).slice(0, 2).join(' · ')}
              </span>
            )}
            {vatLabelKey && (
              <Badge
                variant={getVatBadgeVariant(converted?.vat_treatment)}
                className="text-[10px] px-1.5 py-0"
              >
                {t(vatLabelKey)}
              </Badge>
            )}
            {!converted && (
              <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                <PenLine className="h-3 w-3" />
                {t('opens_editor_badge')}
              </span>
            )}
          </div>
        </div>
      </div>
      {raw.description && (
        <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
          {raw.description}
        </p>
      )}
    </button>
  )
}

function TemplateCard({ template, selected, onClick, compact, dense }: TemplateCardProps) {
  const t = useTranslations('tx_template_picker')
  const vatLabelKey = getVatLabelKey(template)
  if (dense) {
    return (
      <DenseRow
        hue={templateGroupHue(template.group)}
        name={template.name_sv}
        account={categoryAccount(template.debit_account, template.credit_account)}
        note={vatLabelKey ? t(vatLabelKey) : null}
        selected={selected}
        onClick={onClick}
      />
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors hover:bg-muted/50 ${
        selected
          ? 'border-primary bg-primary/5 ring-1 ring-primary'
          : 'border-border'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className={`font-medium ${compact ? 'text-sm' : 'text-sm'} leading-tight`}>
            {template.name_sv}
          </p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-xs font-mono text-muted-foreground">
              D: {formatAccountWithName(template.debit_account)} &middot; K: {formatAccountWithName(template.credit_account)}
            </span>
            {vatLabelKey && (
              <Badge
                variant={getVatBadgeVariant(template.vat_treatment)}
                className="text-[10px] px-1.5 py-0"
              >
                {t(vatLabelKey)}
              </Badge>
            )}
            {template.requires_vat_registration_data && (
              <Badge variant="warning" className="text-[10px] px-1.5 py-0 gap-0.5">
                <AlertTriangle className="h-2.5 w-2.5" />
                {t('requires_vat_reg')}
              </Badge>
            )}
          </div>
        </div>
        {template.requires_review && (
          <Info className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
        )}
      </div>
      {template.special_rules_sv && !compact && (
        <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
          {template.special_rules_sv}
        </p>
      )}
    </button>
  )
}

// A chart-of-accounts hit in the search results (issue #1877): clicking it
// routes into the manual booking flow with the account prefilled, so typing
// "5460" or "Förbrukningsmaterial" always yields a path to booking even when
// no template covers the account.
function AccountResultCard({ account, onClick, dense }: { account: AccountSearchItem; onClick: () => void; dense?: boolean }) {
  const t = useTranslations('tx_template_picker')
  if (dense) {
    return <DenseRow hue={accountHue(account.account_number)} name={account.account_name} account={account.account_number} note={t('opens_editor_badge')} onClick={onClick} />
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-muted/50"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="font-mono text-sm shrink-0">{account.account_number}</span>
          <span className="font-medium text-sm leading-tight truncate">{account.account_name}</span>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
          <PenLine className="h-3 w-3" />
          {t('opens_editor_badge')}
        </span>
      </div>
    </button>
  )
}

interface TemplatePickerProps {
  /** Which side of the catalog to show; 'all' for a form with no transaction (Ny verifikation). */
  direction: 'expense' | 'income' | 'all'
  entityType?: EntityType
  suggestedTemplates?: SuggestedTemplate[]
  onSelect: (template: BookingTemplate) => void

  onSelectCounterparty?: (templateId: string) => void
  onPickLibraryTemplate?: (raw: BookingTemplateLibrary) => void
  // When provided, the search field also matches the company's active chart
  // of accounts and shows hits as a "Konton" result group; picking one routes
  // into the manual booking flow with the account prefilled. Omitting it
  // keeps the picker template-only (and skips the accounts fetch).
  onSelectAccount?: (accountNumber: string) => void
  /** Shell v2: one line per template, colour dot, no cards (the picker sits beside the row). */
  dense?: boolean
  selectedTemplateId?: string
  /**
   * List the standard library templates (the seeded multi-line ones: lön,
   * momsredovisning, skattekonto, bokslut) inside their families too. The
   * transactions picker leaves them out because a bank row books through
   * the static catalog; a form that writes a whole verifikat wants them.
   */
  includeSystemLibrary?: boolean
}

export default function TemplatePicker({
  direction,
  entityType,
  suggestedTemplates,
  onSelect,
  onSelectCounterparty,
  onPickLibraryTemplate,
  onSelectAccount,
  dense = false,
  selectedTemplateId,
  includeSystemLibrary = false,
}: TemplatePickerProps) {
  const t = useTranslations('tx_template_picker')
  const [searchQuery, setSearchQuery] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  // The user's library templates (company + team scope), session-cached
  // (lib/reference-data). Kept in their raw shape so every template renders,
  // even ones that don't fit convertLibraryToBookingTemplate's simple
  // 2-account contract: those get routed through the manual booking dialog
  // instead of the QuickReview single-account path.
  const { templates: libraryTemplates } = useBookingTemplates()
  // Hidden templates (opted out in Inställningar > Mallar) never surface in
  // a picker; only the settings panel lists them, for restore.
  const libraryRaw = useMemo(
    () => libraryTemplates.filter((tt) => !tt.is_system && tt.is_active && !tt.is_hidden),
    [libraryTemplates],
  )
  const systemRaw = useMemo(
    () => (includeSystemLibrary ? libraryTemplates.filter((tt) => tt.is_system && tt.is_active && !tt.is_hidden) : []),
    [libraryTemplates, includeSystemLibrary],
  )
  // The company's active chart, from the session cache (lib/reference-data),
  // so the search field can surface real accounts (issue #1877) without a
  // request per mount. buildActiveAccountIndex re-filters is_active as
  // defense in depth. Only consulted when the consumer routes account picks.
  const { accounts: chartAccounts } = useAccounts()
  // Boolean gate rather than the callback itself: the parent recreates the
  // handler every render, and depending on its identity would refetch the
  // chart on each keystroke of the page underneath.
  const accountSearchEnabled = !!onSelectAccount

  // Map direction to template direction filter (transfers show in both).
  // Direction filtering applies only to the static "Vanliga mallar" list:   // user-created library templates ignore it (inferred direction is unreliable
  // and users know what they made).
  const templateDirection = direction === 'income' ? 'income' : 'expense'
  const bothDirections = direction === 'all'

  const accountIndex = useMemo(() => buildActiveAccountIndex(chartAccounts), [chartAccounts])

  // Lazy convertibility map. A template is "convertible" if it fits the
  // simple debit/credit pair shape the QuickReview booking path expects.
  // Non-convertible templates are still shown: they just route to the
  // full journal-entry editor on click.
  const convertedById = useMemo(() => {
    const m = new Map<string, BookingTemplate | null>()
    for (const raw of libraryRaw) m.set(raw.id, convertLibraryToBookingTemplate(raw))
    for (const raw of systemRaw) m.set(raw.id, convertLibraryToBookingTemplate(raw))
    return m
  }, [libraryRaw, systemRaw])

  const commonTemplates = useMemo(
    () => (bothDirections ? [...getCommonTemplates(entityType, 'expense'), ...getCommonTemplates(entityType, 'income')] : getCommonTemplates(entityType, templateDirection)),
    [entityType, templateDirection, bothDirections]
  )

  const advancedTemplates = useMemo(
    () => (bothDirections ? [...getAdvancedTemplates(entityType, 'expense'), ...getAdvancedTemplates(entityType, 'income')] : getAdvancedTemplates(entityType, templateDirection)),
    [entityType, templateDirection, bothDirections]
  )

  // Also include transfer templates in both directions
  const commonTransfers = useMemo(
    () => getCommonTemplates(entityType, 'transfer'),
    [entityType]
  )
  const advancedTransfers = useMemo(
    () => getAdvancedTemplates(entityType, 'transfer'),
    [entityType]
  )

  const allCommon = useMemo(
    () => [...commonTemplates, ...commonTransfers],
    [commonTemplates, commonTransfers]
  )
  const allAdvanced = useMemo(
    () => [...advancedTemplates, ...advancedTransfers],
    [advancedTemplates, advancedTransfers]
  )

  // Library templates filtered by entity_type only. Direction is NOT applied
  // here: see the comment on convertedById above.
  const relevantLibraryRaw = useMemo(() => {
    return libraryRaw.filter((tt) => {
      if (entityType && tt.entity_type && tt.entity_type !== 'all' && tt.entity_type !== entityType) {
        return false
      }
      return true
    })
  }, [libraryRaw, entityType])

  // The standard library templates, by family, so they sit beside the
  // catalog templates that book the same kind of thing.
  const systemGrouped = useMemo(() => {
    const grouped = new Map<TemplateGroup, BookingTemplateLibrary[]>()
    for (const tt of systemRaw) {
      if (entityType && tt.entity_type && tt.entity_type !== 'all' && tt.entity_type !== entityType) continue
      const group = libraryTemplateGroup(tt)
      const list = grouped.get(group) ?? []
      list.push(tt)
      grouped.set(group, list)
    }
    for (const list of grouped.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'sv'))
    return grouped
  }, [systemRaw, entityType])

  // Convertible templates surface first; within each group, sort by name.
  const sortedLibraryRaw = useMemo(() => {
    return [...relevantLibraryRaw].sort((a, b) => {
      const ac = convertedById.get(a.id) ? 0 : 1
      const bc = convertedById.get(b.id) ? 0 : 1
      if (ac !== bc) return ac - bc
      return a.name.localeCompare(b.name, 'sv')
    })
  }, [relevantLibraryRaw, convertedById])

  // Search results (static + library + chart accounts). Library search
  // ignores direction; the static catalog still respects it because it's
  // curated content. Accounts are direction-agnostic: the manual flow the
  // pick routes into handles either side.
  const searchResults = useMemo<
    | { library: BookingTemplateLibrary[]; staticTemplates: BookingTemplate[]; accounts: AccountSearchItem[] }
    | null
  >(() => {
    const qTrimmed = searchQuery.trim()
    if (!qTrimmed) return null
    const q = qTrimmed.toLowerCase()
    const isDigits = /^\d+$/.test(qTrimmed)
    const matchesLibrary = (tt: BookingTemplateLibrary) =>
      tt.name.toLowerCase().includes(q) ||
      (tt.description ?? '').toLowerCase().includes(q) ||
      // An all-digit query also prefix-matches the accounts a user template
      // books to, mirroring the static catalog's account matching: business
      // lines only, so the settlement leg (typically 1930) and VAT lines do
      // not light up every template.
      (isDigits && tt.lines.some((l) => l.type === 'business' && l.account.startsWith(qTrimmed)))
    const libraryMatches = [
      ...sortedLibraryRaw.filter(matchesLibrary),
      ...Array.from(systemGrouped.values()).flat().filter(matchesLibrary),
    ]
    const staticMatches = searchTemplates(searchQuery, entityType).filter((tt) => {
      return bothDirections || tt.direction === templateDirection || tt.direction === 'transfer'
    })
    const accountMatches = accountSearchEnabled
      ? searchAccounts(accountIndex, searchQuery, ACCOUNT_RESULT_LIMIT)
      : []
    return { library: libraryMatches, staticTemplates: staticMatches, accounts: accountMatches }
  }, [searchQuery, entityType, templateDirection, bothDirections, sortedLibraryRaw, systemGrouped, accountIndex, accountSearchEnabled])

  // Group templates by group for display
  const commonGrouped = useMemo(() => groupTemplates(allCommon), [allCommon])
  const advancedGrouped = useMemo(() => groupTemplates(allAdvanced), [allAdvanced])
  const commonGroups = useMemo(
    () => GROUP_ORDER.filter((g) => commonGrouped.has(g) || systemGrouped.has(g)),
    [commonGrouped, systemGrouped],
  )

  const bumpLibraryMru = (libraryId: string) => {
    fetch(`/api/settings/booking-templates/${libraryId}/touch`, { method: 'POST' }).catch(() => {})
  }

  const handleSelect = (template: BookingTemplate) => {
    if (isLibraryTemplateId(template.id)) {
      bumpLibraryMru(template.id.slice(LIBRARY_TEMPLATE_PREFIX.length))
    }
    onSelect(template)
  }

  // Click a raw library card. Always book a user's mall from its LITERAL lines
  // via the journal-entry editor (onPickLibraryTemplate → applyTemplate → /book),
  // for both convertible and non-convertible shapes.
  //
  // The old "convertible → onSelect(converted)" branch routed through the
  // QuickReview fast path, which books a single category + one account_override
  // and silently discards the template's chosen debit/credit. A kundinbetalning
  // mall (D 1930 / K 1510) came out as a generic cost (D 6991 / K 1930), or with
  // a VAT line as D 1930 / K 1930 / K 2611, and the result flipped with the
  // direction the converter happened to infer from the business/settlement tags.
  // Routing every library template through the editor books exactly the accounts
  // the user defined, independent of those tags. See template-library.test.ts.
  //
  // MRU is only bumped once we know the click will do something: otherwise a
  // consumer that omits onPickLibraryTemplate would reorder MRU for a template
  // the user never actually applied.
  const handleSelectLibraryRaw = (raw: BookingTemplateLibrary) => {
    if (onPickLibraryTemplate) {
      bumpLibraryMru(raw.id)
      onPickLibraryTemplate(raw)
      return
    }
    // Fallback only for consumers that didn't wire the editor path: fall back to
    // the lossy converted shape rather than leaving the click dead. The single
    // render site (the transactions page) always passes onPickLibraryTemplate,
    // so this branch is not reached in the app today.
    const converted = convertedById.get(raw.id) ?? null
    if (converted) {
      bumpLibraryMru(raw.id)
      onSelect(converted)
    }
  }

  // Split suggestions: counterparty templates vs regular booking templates
  const counterpartySuggestions = useMemo(() => {
    if (!suggestedTemplates) return []
    return suggestedTemplates.filter(s => isCounterpartyTemplateId(s.template_id))
  }, [suggestedTemplates])
  const resolvedSuggestions = useMemo(() => {
    if (!suggestedTemplates) return []
    return suggestedTemplates.filter(s => !isCounterpartyTemplateId(s.template_id) && s.source !== 'assistant')
  }, [suggestedTemplates])
  const hasCounterparty = counterpartySuggestions.length > 0 && !!onSelectCounterparty
  const hasSuggestions = resolvedSuggestions.length > 0

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className={dense ? 'relative px-3 pt-2.5 pb-1.5' : 'relative px-4 pt-3 pb-2'}>
        <Search className={cn('absolute top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground mt-0.5', dense ? 'left-6' : 'left-7')} />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={accountSearchEnabled ? t('search_placeholder_with_accounts') : t('search_placeholder')}
          className="pl-9 h-9"
        />
      </div>

      {/* Scrollable content */}
      <div className={dense ? 'flex-1 overflow-auto px-2 pb-2 space-y-3' : 'flex-1 overflow-auto px-4 pb-4 space-y-4'}>
        {/* Search results */}
        {searchResults !== null ? (
          (() => {
            const templateResults = searchResults.library.length + searchResults.staticTemplates.length
            const totalResults = templateResults + searchResults.accounts.length
            return (
              <div className="space-y-4">
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    {totalResults === 0 ? t('no_results') : t('n_results', { count: totalResults })}
                  </p>
                  {totalResults === 0 && accountSearchEnabled && (
                    <p className="text-xs text-muted-foreground">
                      {t('no_results_manual_hint')}
                    </p>
                  )}
                  <div className={dense ? 'space-y-px' : 'space-y-1.5'}>
                    {searchResults.library.map((raw) => (
                      <LibraryTemplateCard
                        dense={dense}
                        key={raw.id}
                        raw={raw}
                        converted={convertedById.get(raw.id) ?? null}
                        selected={selectedTemplateId === (convertedById.get(raw.id)?.id ?? raw.id)}
                        onClick={() => handleSelectLibraryRaw(raw)}
                      />
                    ))}
                    {searchResults.staticTemplates.map((tt) => (
                      <TemplateCard
                        dense={dense}
                        key={tt.id}
                        template={tt}
                        selected={selectedTemplateId === tt.id}
                        onClick={() => handleSelect(tt)}
                      />
                    ))}
                  </div>
                </div>
                {searchResults.accounts.length > 0 && onSelectAccount && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">
                      {t('accounts_group')}
                    </p>
                    <div className={dense ? 'space-y-px' : 'space-y-1.5'}>
                      {searchResults.accounts.map((acc) => (
                        <AccountResultCard
                          dense={dense}
                          key={acc.account_number}
                          account={acc}
                          onClick={() => onSelectAccount(acc.account_number)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })()
        ) : (
          <>
            {/* User-created library templates (company + team scope).
                Direction is intentionally NOT applied here: all the user's
                own templates are shown regardless of expense/income context. */}
            {sortedLibraryRaw.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Briefcase className="h-3 w-3" />
                  {t('my_templates')}
                </p>
                <div className={dense ? 'space-y-px' : 'space-y-1.5'}>
                  {sortedLibraryRaw.map((raw) => (
                    <LibraryTemplateCard
                      dense={dense}
                      key={raw.id}
                      raw={raw}
                      converted={convertedById.get(raw.id) ?? null}
                      selected={selectedTemplateId === (convertedById.get(raw.id)?.id ?? raw.id)}
                      onClick={() => handleSelectLibraryRaw(raw)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Counterparty templates: learned from history */}
            {hasCounterparty && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">{t('previous_counterparties')}</p>
                <div className={dense ? 'space-y-px' : 'space-y-1.5'}>
                  {counterpartySuggestions.slice(0, 3).map((s) => dense ? (
                    <DenseRow
                      key={s.template_id}
                      hue={accountHue(s.line_pattern?.find((lp) => lp.type === 'business')?.account ?? categoryAccount(s.debit_account, s.credit_account))}
                      name={s.name_sv}
                      account={s.line_pattern?.find((lp) => lp.type === 'business')?.account ?? categoryAccount(s.debit_account, s.credit_account)}
                      note={s.description_sv}
                      onClick={() => onSelectCounterparty!(s.template_id)}
                    />
                  ) : (
                    <button
                      key={s.template_id}
                      type="button"
                      onClick={() => onSelectCounterparty!(s.template_id)}
                      className="w-full text-left rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-muted/50"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-sm leading-tight">{s.name_sv}</p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            {s.line_pattern && s.line_pattern.length > 0 ? (
                              s.line_pattern.filter(lp => lp.type === 'business').map((lp, i) => (
                                <span key={i} className="text-xs font-mono text-muted-foreground">
                                  {formatAccountWithName(lp.account)}
                                </span>
                              ))
                            ) : (
                              <span className="text-xs font-mono text-muted-foreground">
                                D: {getAccountName(s.debit_account)} &middot; K: {getAccountName(s.credit_account)}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className="text-[10px] text-muted-foreground flex-shrink-0 mt-0.5">
                          {s.description_sv}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Suggested templates */}
            {hasSuggestions && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">{t('suggested')}</p>
                <div className={dense ? 'space-y-px' : 'space-y-1.5'}>
                  {resolvedSuggestions.slice(0, 5).map((s) => {
                    // Find the full template object
                    const fullTemplate = allCommon.find((t) => t.id === s.template_id) ||
                      allAdvanced.find((t) => t.id === s.template_id)
                    if (!fullTemplate) return null
                    return (
                      <TemplateCard
                        dense={dense}
                        key={s.template_id}
                        template={fullTemplate}
                        selected={selectedTemplateId === s.template_id}
                        onClick={() => handleSelect(fullTemplate)}
                        compact
                      />
                    )
                  })}
                </div>
              </div>
            )}

            {/* Common templates grouped */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">{t('common_templates')}</p>
              <div className="space-y-3">
                {commonGroups.map((group) => (
                  <div key={group}>
                    <p className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-1">
                      {t(GROUP_LABEL_KEYS[group])}
                    </p>
                    <div className={dense ? 'space-y-px' : 'space-y-1.5'}>
                      {(commonGrouped.get(group) ?? []).map((t) => (
                        <TemplateCard
                          dense={dense}
                          key={t.id}
                          template={t}
                          selected={selectedTemplateId === t.id}
                          onClick={() => handleSelect(t)}
                          compact
                        />
                      ))}
                      {(systemGrouped.get(group) ?? []).map((raw) => (
                        <LibraryTemplateCard
                          dense={dense}
                          key={raw.id}
                          raw={raw}
                          converted={convertedById.get(raw.id) ?? null}
                          selected={selectedTemplateId === (convertedById.get(raw.id)?.id ?? raw.id)}
                          onClick={() => handleSelectLibraryRaw(raw)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Advanced templates (collapsible) */}
            {allAdvanced.length > 0 && (
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-between text-xs text-muted-foreground h-8"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                >
                  {t('more_templates', { count: allAdvanced.length })}
                  {showAdvanced ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </Button>
                {showAdvanced && (
                  <div className="space-y-3 mt-2">
                    {GROUP_ORDER.filter((g) => advancedGrouped.has(g)).map((group) => (
                      <div key={group}>
                        <p className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-1">
                          {t(GROUP_LABEL_KEYS[group])}
                        </p>
                        <div className={dense ? 'space-y-px' : 'space-y-1.5'}>
                          {advancedGrouped.get(group)!.map((t) => (
                            <TemplateCard
                              dense={dense}
                              key={t.id}
                              template={t}
                              selected={selectedTemplateId === t.id}
                              onClick={() => handleSelect(t)}
                              compact
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

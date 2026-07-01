'use client'

import { useState, useMemo, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Search, ChevronDown, ChevronUp, AlertTriangle, Info, Building2, PenLine } from 'lucide-react'
import {
  getCommonTemplates,
  getAdvancedTemplates,
  searchTemplates,
  type BookingTemplate,
  type TemplateGroup,
} from '@/lib/bookkeeping/booking-templates'
import { formatAccountWithName } from '@/lib/bookkeeping/client-account-names'
import { isCounterpartyTemplateId } from '@/lib/bookkeeping/counterparty-templates'
import { convertLibraryToBookingTemplate, LIBRARY_TEMPLATE_PREFIX, isLibraryTemplateId } from '@/lib/bookkeeping/template-library'
import { getAccountName } from '@/lib/bookkeeping/client-account-names'
import type { BookingTemplateLibrary, EntityType } from '@/types'
import type { SuggestedTemplate } from '@/lib/transactions/category-suggestions'

const GROUP_ORDER: TemplateGroup[] = [
  'premises', 'vehicle', 'it_software', 'office_supplies', 'marketing',
  'travel', 'representation', 'insurance', 'professional_services',
  'bank_finance', 'telecom', 'education', 'personnel', 'revenue',
  'financial', 'private_transfers', 'equipment',
]

const GROUP_LABEL_KEYS: Record<TemplateGroup, string> = {
  premises: 'group_premises',
  vehicle: 'group_vehicle',
  it_software: 'group_it_software',
  office_supplies: 'group_office_supplies',
  marketing: 'group_marketing',
  travel: 'group_travel',
  representation: 'group_representation',
  insurance: 'group_insurance',
  professional_services: 'group_professional_services',
  bank_finance: 'group_bank_finance',
  telecom: 'group_telecom',
  education: 'group_education',
  personnel: 'group_personnel',
  revenue: 'group_revenue',
  financial: 'group_financial',
  private_transfers: 'group_private_transfers',
  equipment: 'group_equipment',
}

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
}

interface LibraryTemplateCardProps {
  raw: BookingTemplateLibrary
  converted: BookingTemplate | null
  selected: boolean
  onClick: () => void
}

function LibraryTemplateCard({ raw, converted, selected, onClick }: LibraryTemplateCardProps) {
  const t = useTranslations('tx_template_picker')
  // Convertible templates render the familiar two-account summary; complex
  // ones list the business legs (the cost/revenue accounts) so the user can
  // recognise the template at a glance, and carry an "opens editor" badge.
  const businessLines = raw.lines.filter((l) => l.type === 'business')
  const vatLabelKey = converted ? getVatLabelKey(converted) : null

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

function TemplateCard({ template, selected, onClick, compact }: TemplateCardProps) {
  const t = useTranslations('tx_template_picker')
  const vatLabelKey = getVatLabelKey(template)

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

interface TemplatePickerProps {
  direction: 'expense' | 'income'
  entityType?: EntityType
  suggestedTemplates?: SuggestedTemplate[]
  recentTemplateIds?: string[]
  onSelect: (template: BookingTemplate) => void
  onSelectCounterparty?: (templateId: string) => void
  onPickLibraryTemplate?: (raw: BookingTemplateLibrary) => void
  selectedTemplateId?: string
}

export default function TemplatePicker({
  direction,
  entityType,
  suggestedTemplates,
  onSelect,
  onSelectCounterparty,
  onPickLibraryTemplate,
  selectedTemplateId,
}: TemplatePickerProps) {
  const t = useTranslations('tx_template_picker')
  const [searchQuery, setSearchQuery] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [libraryRaw, setLibraryRaw] = useState<BookingTemplateLibrary[]>([])

  // Map direction to template direction filter (transfers show in both).
  // Direction filtering applies only to the static "Vanliga mallar" list —
  // user-created library templates ignore it (inferred direction is unreliable
  // and users know what they made).
  const templateDirection = direction === 'income' ? 'income' : 'expense'

  // Fetch the user's library templates (company + team scope). We keep them
  // in their raw shape so we can render every template, even ones that don't
  // fit convertLibraryToBookingTemplate's simple 2-account contract — those
  // get routed through the manual booking dialog instead of the QuickReview
  // single-account path.
  useEffect(() => {
    const controller = new AbortController()
    ;(async () => {
      try {
        const res = await fetch('/api/settings/booking-templates', { signal: controller.signal })
        if (!res.ok) return
        const { data } = await res.json() as { data?: BookingTemplateLibrary[] }
        if (!data) return
        setLibraryRaw(data.filter((tt) => !tt.is_system && tt.is_active))
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
      }
    })()
    return () => { controller.abort() }
  }, [])

  // Lazy convertibility map. A template is "convertible" if it fits the
  // simple debit/credit pair shape the QuickReview booking path expects.
  // Non-convertible templates are still shown — they just route to the
  // full journal-entry editor on click.
  const convertedById = useMemo(() => {
    const m = new Map<string, BookingTemplate | null>()
    for (const raw of libraryRaw) m.set(raw.id, convertLibraryToBookingTemplate(raw))
    return m
  }, [libraryRaw])

  const commonTemplates = useMemo(
    () => getCommonTemplates(entityType, templateDirection),
    [entityType, templateDirection]
  )

  const advancedTemplates = useMemo(
    () => getAdvancedTemplates(entityType, templateDirection),
    [entityType, templateDirection]
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
  // here — see the comment on convertedById above.
  const relevantLibraryRaw = useMemo(() => {
    return libraryRaw.filter((tt) => {
      if (entityType && tt.entity_type && tt.entity_type !== 'all' && tt.entity_type !== entityType) {
        return false
      }
      return true
    })
  }, [libraryRaw, entityType])

  // Convertible templates surface first; within each group, sort by name.
  const sortedLibraryRaw = useMemo(() => {
    return [...relevantLibraryRaw].sort((a, b) => {
      const ac = convertedById.get(a.id) ? 0 : 1
      const bc = convertedById.get(b.id) ? 0 : 1
      if (ac !== bc) return ac - bc
      return a.name.localeCompare(b.name, 'sv')
    })
  }, [relevantLibraryRaw, convertedById])

  // Search results (static + library). Library search ignores direction; the
  // static catalog still respects it because it's curated content.
  const searchResults = useMemo<
    | { library: BookingTemplateLibrary[]; staticTemplates: BookingTemplate[] }
    | null
  >(() => {
    if (!searchQuery.trim()) return null
    const q = searchQuery.toLowerCase()
    const libraryMatches = sortedLibraryRaw.filter((tt) =>
      tt.name.toLowerCase().includes(q) ||
      (tt.description ?? '').toLowerCase().includes(q)
    )
    const staticMatches = searchTemplates(searchQuery, entityType).filter((tt) => {
      return tt.direction === templateDirection || tt.direction === 'transfer'
    })
    return { library: libraryMatches, staticTemplates: staticMatches }
  }, [searchQuery, entityType, templateDirection, sortedLibraryRaw])

  // Group templates by group for display
  const commonGrouped = useMemo(() => groupTemplates(allCommon), [allCommon])
  const advancedGrouped = useMemo(() => groupTemplates(allAdvanced), [allAdvanced])

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
  // a VAT line as D 1930 / K 1930 / K 2611 — and the result flipped with the
  // direction the converter happened to infer from the business/settlement tags.
  // Routing every library template through the editor books exactly the accounts
  // the user defined, independent of those tags. See template-library.test.ts.
  //
  // MRU is only bumped once we know the click will do something — otherwise a
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
    return suggestedTemplates.filter(s => !isCounterpartyTemplateId(s.template_id))
  }, [suggestedTemplates])
  const hasCounterparty = counterpartySuggestions.length > 0 && !!onSelectCounterparty
  const hasSuggestions = resolvedSuggestions.length > 0

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="relative px-4 pt-3 pb-2">
        <Search className="absolute left-7 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground mt-0.5" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('search_placeholder')}
          className="pl-9 h-9"
        />
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-auto px-4 pb-4 space-y-4">
        {/* Search results */}
        {searchResults !== null ? (
          (() => {
            const totalResults = searchResults.library.length + searchResults.staticTemplates.length
            return (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  {totalResults === 0 ? t('no_results') : t('n_results', { count: totalResults })}
                </p>
                <div className="space-y-1.5">
                  {searchResults.library.map((raw) => (
                    <LibraryTemplateCard
                      key={raw.id}
                      raw={raw}
                      converted={convertedById.get(raw.id) ?? null}
                      selected={selectedTemplateId === (convertedById.get(raw.id)?.id ?? raw.id)}
                      onClick={() => handleSelectLibraryRaw(raw)}
                    />
                  ))}
                  {searchResults.staticTemplates.map((tt) => (
                    <TemplateCard
                      key={tt.id}
                      template={tt}
                      selected={selectedTemplateId === tt.id}
                      onClick={() => handleSelect(tt)}
                    />
                  ))}
                </div>
              </div>
            )
          })()
        ) : (
          <>
            {/* User-created library templates (company + team scope).
                Direction is intentionally NOT applied here — all the user's
                own templates are shown regardless of expense/income context. */}
            {sortedLibraryRaw.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Building2 className="h-3 w-3" />
                  {t('my_templates')}
                </p>
                <div className="space-y-1.5">
                  {sortedLibraryRaw.map((raw) => (
                    <LibraryTemplateCard
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

            {/* Counterparty templates — learned from history */}
            {hasCounterparty && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">{t('previous_counterparties')}</p>
                <div className="space-y-1.5">
                  {counterpartySuggestions.slice(0, 3).map((s) => (
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
                <div className="space-y-1.5">
                  {resolvedSuggestions.slice(0, 5).map((s) => {
                    // Find the full template object
                    const fullTemplate = allCommon.find((t) => t.id === s.template_id) ||
                      allAdvanced.find((t) => t.id === s.template_id)
                    if (!fullTemplate) return null
                    return (
                      <TemplateCard
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
                {GROUP_ORDER.filter((g) => commonGrouped.has(g)).map((group) => (
                  <div key={group}>
                    <p className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-1">
                      {t(GROUP_LABEL_KEYS[group])}
                    </p>
                    <div className="space-y-1.5">
                      {commonGrouped.get(group)!.map((t) => (
                        <TemplateCard
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
                        <div className="space-y-1.5">
                          {advancedGrouped.get(group)!.map((t) => (
                            <TemplateCard
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

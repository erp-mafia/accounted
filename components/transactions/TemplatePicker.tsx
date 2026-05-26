'use client'

import { useState, useMemo, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Search, ChevronDown, ChevronUp, AlertTriangle, Info, Building2 } from 'lucide-react'
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
                variant="secondary"
                className={`text-[10px] px-1.5 py-0 ${
                  template.vat_treatment === 'reverse_charge'
                    ? 'bg-warning/10 text-warning-foreground'
                    : ''
                }`}
              >
                {t(vatLabelKey)}
              </Badge>
            )}
            {template.requires_vat_registration_data && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-warning/30 text-warning-foreground gap-0.5">
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
  selectedTemplateId?: string
}

export default function TemplatePicker({
  direction,
  entityType,
  suggestedTemplates,
  onSelect,
  onSelectCounterparty,
  selectedTemplateId,
}: TemplatePickerProps) {
  const t = useTranslations('tx_template_picker')
  const [searchQuery, setSearchQuery] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [libraryTemplates, setLibraryTemplates] = useState<BookingTemplate[]>([])

  // Map direction to template direction filter (transfers show in both)
  const templateDirection = direction === 'income' ? 'income' : 'expense'

  // Fetch user-created booking templates (company + team scope) and map
  // convertible ones into BookingTemplate shape. System templates are
  // already covered by the static list below, so we exclude them here.
  useEffect(() => {
    const controller = new AbortController()
    ;(async () => {
      try {
        const res = await fetch('/api/settings/booking-templates', { signal: controller.signal })
        if (!res.ok) return
        const { data } = await res.json() as { data?: BookingTemplateLibrary[] }
        if (!data) return
        const mapped = data
          .filter((t) => !t.is_system && t.is_active)
          .map(convertLibraryToBookingTemplate)
          .filter((t): t is BookingTemplate => t !== null)
        setLibraryTemplates(mapped)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
      }
    })()
    return () => { controller.abort() }
  }, [])

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

  // User-created library templates filtered by direction + entity
  const relevantLibraryTemplates = useMemo(() => {
    return libraryTemplates.filter((t) => {
      if (entityType && t.entity_applicability !== 'all' && t.entity_applicability !== entityType) {
        return false
      }
      return t.direction === templateDirection || t.direction === 'transfer'
    })
  }, [libraryTemplates, entityType, templateDirection])

  // Search results (static + library)
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return null
    const q = searchQuery.toLowerCase()
    const libraryMatches = relevantLibraryTemplates.filter((t) =>
      t.name_sv.toLowerCase().includes(q) || t.description_sv.toLowerCase().includes(q)
    )
    const staticMatches = searchTemplates(searchQuery, entityType).filter((t) => {
      if (t.direction === templateDirection || t.direction === 'transfer') return true
      return false
    })
    return [...libraryMatches, ...staticMatches]
  }, [searchQuery, entityType, templateDirection, relevantLibraryTemplates])

  // Group templates by group for display
  const commonGrouped = useMemo(() => groupTemplates(allCommon), [allCommon])
  const advancedGrouped = useMemo(() => groupTemplates(allAdvanced), [allAdvanced])

  const handleSelect = (template: BookingTemplate) => {
    // For library-backed templates, bump MRU so they surface at the top next time.
    if (isLibraryTemplateId(template.id)) {
      const libraryId = template.id.slice(LIBRARY_TEMPLATE_PREFIX.length)
      fetch(`/api/settings/booking-templates/${libraryId}/touch`, { method: 'POST' }).catch(() => {})
    }
    onSelect(template)
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
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">
              {searchResults.length === 0 ? t('no_results') : t('n_results', { count: searchResults.length })}
            </p>
            <div className="space-y-1.5">
              {searchResults.map((t) => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  selected={selectedTemplateId === t.id}
                  onClick={() => handleSelect(t)}
                />
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* User-created library templates (company + team scope) */}
            {relevantLibraryTemplates.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Building2 className="h-3 w-3" />
                  {t('my_templates')}
                </p>
                <div className="space-y-1.5">
                  {relevantLibraryTemplates.map((t) => (
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

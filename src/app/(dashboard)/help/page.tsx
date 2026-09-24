'use client'

import { useState, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { HelpLink } from '@/components/ui/info-tooltip'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { EmptyState } from '@/components/ui/empty-state'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Search, FileDown, ExternalLink, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SupportLink } from '@/components/ui/support-link'

interface GlossaryTerm {
  term: string
  simpleTerm?: string // Vardagligt alternativ
  definition: string
  category: 'skatt' | 'moms' | 'faktura' | 'bokföring' | 'bank' | 'företag'
  skatteverketUrl?: string
  relatedTerms?: string[]
}

// Term names and related terms stay Swedish: they are the statutory Swedish
// words being explained. The everyday name and definition are translated.
function buildGlossaryTerms(t: ReturnType<typeof useTranslations>): GlossaryTerm[] {
  return [
  // Skatt
  {
    term: 'F-skatt',
    simpleTerm: t('term_fskatt_simple'),
    definition: t('term_fskatt_definition'),
    category: 'skatt',
    skatteverketUrl: 'https://www.skatteverket.se/foretag/foretagarguiden/foretagsformer/enskildnaringsverksamhet/fskatt.4.361dc8c15312eff6fd1f8a3.html',
    relatedTerms: ['Preliminärskatt', 'Restskatt', 'Egenavgifter'],
  },
  {
    term: 'Preliminärskatt',
    definition: t('term_preliminarskatt_definition'),
    category: 'skatt',
    relatedTerms: ['F-skatt', 'Restskatt'],
  },
  {
    term: 'Egenavgifter',
    simpleTerm: t('term_egenavgifter_simple'),
    definition: t('term_egenavgifter_definition'),
    category: 'skatt',
    skatteverketUrl: 'https://www.skatteverket.se/foretag/foretagarguiden/avgifterochegenavgifter/egenavgifter.4.361dc8c15312eff6fd1e5e7.html',
    relatedTerms: ['Enskild firma'],
  },
  {
    term: 'Restskatt',
    definition: t('term_restskatt_definition'),
    category: 'skatt',
    relatedTerms: ['F-skatt', 'Preliminärskatt'],
  },
  {
    term: 'Schablonavdrag',
    simpleTerm: t('term_schablonavdrag_simple'),
    definition: t('term_schablonavdrag_definition'),
    category: 'skatt',
    skatteverketUrl: 'https://www.skatteverket.se/privat/skatter/arbeteochinkomst/avdrag.4.6efe6285127ab4f1d25800023187.html',
    relatedTerms: ['Avdrag', 'Hemmakontor'],
  },
  {
    term: 'NE-bilaga',
    definition: t('term_ne_bilaga_definition'),
    category: 'skatt',
    skatteverketUrl: 'https://www.skatteverket.se/privat/deklaration/blanketter/inkomstochfastighetsdeklaration/blankett21.4.6efe6285127ab4f1d25800023142.html',
    relatedTerms: ['Enskild firma', 'Inkomstdeklaration'],
  },
  {
    term: 'Disponibelt',
    simpleTerm: t('term_disponibelt_simple'),
    definition: t('term_disponibelt_definition'),
    category: 'skatt',
  },
  // Moms
  {
    term: 'Moms',
    simpleTerm: t('term_moms_simple'),
    definition: t('term_moms_definition'),
    category: 'moms',
    skatteverketUrl: 'https://www.skatteverket.se/foretag/moms.4.65fc817e1077c25b8328000206.html',
    relatedTerms: ['Momsperiod', 'Ingående moms', 'Utgående moms'],
  },
  {
    term: 'Momsperiod',
    simpleTerm: t('term_momsperiod_simple'),
    definition: t('term_momsperiod_definition'),
    category: 'moms',
    relatedTerms: ['Moms', 'Momsdeklaration'],
  },
  {
    term: 'Omvänd skattskyldighet',
    simpleTerm: t('term_omvand_skattskyldighet_simple'),
    definition: t('term_omvand_skattskyldighet_definition'),
    category: 'moms',
    skatteverketUrl: 'https://www.skatteverket.se/foretag/moms/saljavarortjanster/omvandskattskyldighetvidsaljandeinomeu.4.7be5268414bea0646940d0e.html',
    relatedTerms: ['EU-försäljning', 'Momsfri export'],
  },
  {
    term: 'Ingående moms',
    definition: t('term_ingaende_moms_definition'),
    category: 'moms',
    relatedTerms: ['Utgående moms', 'Moms'],
  },
  {
    term: 'Utgående moms',
    definition: t('term_utgaende_moms_definition'),
    category: 'moms',
    relatedTerms: ['Ingående moms', 'Moms'],
  },
  // Faktura
  {
    term: 'Förfallodag',
    definition: t('term_forfallodag_definition'),
    category: 'faktura',
    relatedTerms: ['Dröjsmålsränta', 'Påminnelse'],
  },
  {
    term: 'OCR-nummer',
    definition: t('term_ocr_nummer_definition'),
    category: 'faktura',
  },
  {
    term: 'Kreditfaktura',
    definition: t('term_kreditfaktura_definition'),
    category: 'faktura',
    relatedTerms: ['Faktura'],
  },
  // Bank
  {
    term: 'Clearingnummer',
    definition: t('term_clearingnummer_definition'),
    category: 'bank',
    relatedTerms: ['IBAN', 'BIC/SWIFT'],
  },
  {
    term: 'IBAN',
    definition: t('term_iban_definition'),
    category: 'bank',
    relatedTerms: ['BIC/SWIFT', 'Clearingnummer'],
  },
  {
    term: 'BIC/SWIFT',
    definition: t('term_bic_swift_definition'),
    category: 'bank',
    relatedTerms: ['IBAN'],
  },
  // Företag
  {
    term: 'Enskild firma',
    simpleTerm: t('term_enskild_firma_simple'),
    definition: t('term_enskild_firma_definition'),
    category: 'företag',
    skatteverketUrl: 'https://www.skatteverket.se/foretag/foretagarguiden/foretagsformer/enskildnaringsverksamhet.4.361dc8c15312eff6fd1e5dc.html',
    relatedTerms: ['Aktiebolag', 'Egenavgifter', 'NE-bilaga'],
  },
  {
    term: 'Aktiebolag',
    simpleTerm: t('term_aktiebolag_simple'),
    definition: t('term_aktiebolag_definition'),
    category: 'företag',
    skatteverketUrl: 'https://www.skatteverket.se/foretag/foretagarguiden/foretagsformer/aktiebolag.4.361dc8c15312eff6fd18a05.html',
    relatedTerms: ['Enskild firma', 'Bolagsskatt'],
  },
  {
    term: 'Organisationsnummer',
    definition: t('term_organisationsnummer_definition'),
    category: 'företag',
  },
  {
    term: 'Eget utlägg',
    simpleTerm: t('term_eget_utlagg_simple'),
    definition: t('term_eget_utlagg_definition'),
    category: 'bokföring',
    relatedTerms: ['Aktiebolag', 'Enskild firma'],
  },
  ]
}

const categoryConfig = {
  skatt: { labelKey: 'category_skatt' },
  moms: { labelKey: 'category_moms' },
  faktura: { labelKey: 'category_faktura' },
  bokföring: { labelKey: 'category_bokforing' },
  bank: { labelKey: 'category_bank' },
  företag: { labelKey: 'category_foretag' },
}

// One hairline row per term (convention 4): the term and its everyday name
// on one line, the definition, related terms and the Skatteverket link in the
// expanded fold. The category shows as the filter above, not as an icon tile
// on every row.
function TermRow({ term, isExpanded, onToggle }: { term: GlossaryTerm; isExpanded: boolean; onToggle: () => void }) {
  const t = useTranslations('help')

  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="flex w-full items-center justify-between gap-4 px-1 py-3 text-left transition-colors duration-150 hover:bg-secondary/35"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-sm font-medium">{term.term}</span>
          {term.simpleTerm && (
            <span className="truncate text-[13px] text-muted-foreground">{term.simpleTerm}</span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150',
            isExpanded && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      {isExpanded && (
        <div className="space-y-3 px-1 pb-4 animate-fade-in">
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            {term.definition}
          </p>

          {term.relatedTerms && term.relatedTerms.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('related_label')} {term.relatedTerms.join(', ')}
            </p>
          )}

          {term.skatteverketUrl && (
            <HelpLink href={term.skatteverketUrl}>
              {t('read_more_skv')}
              <ExternalLink className="h-3 w-3" />
            </HelpLink>
          )}
        </div>
      )}
    </div>
  )
}

// Quiet link row for the resources below the glossary: title with the muted
// description on the same line, hairline between rows.
const LINK_ROW_CLASS =
  'flex items-baseline gap-3 border-b border-border px-1 py-3 text-sm text-foreground transition-colors duration-150 hover:bg-secondary/35 hover:text-foreground hover:no-underline'

export default function HelpPage() {
  const t = useTranslations('help')
  const glossaryTerms = useMemo(() => buildGlossaryTerms(t), [t])
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [expandedTerms, setExpandedTerms] = useState<Set<string>>(new Set())

  const filteredTerms = useMemo(() => {
    return glossaryTerms.filter((term) => {
      // Category filter
      if (selectedCategory && term.category !== selectedCategory) {
        return false
      }

      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase()
        return (
          term.term.toLowerCase().includes(query) ||
          term.simpleTerm?.toLowerCase().includes(query) ||
          term.definition.toLowerCase().includes(query) ||
          term.relatedTerms?.some((r) => r.toLowerCase().includes(query))
        )
      }

      return true
    })
  }, [glossaryTerms, searchQuery, selectedCategory])

  const toggleTerm = (termName: string) => {
    setExpandedTerms((prev) => {
      const next = new Set(prev)
      if (next.has(termName)) {
        next.delete(termName)
      } else {
        next.add(termName)
      }
      return next
    })
  }

  const categoryOptions = [
    { value: 'all', label: t('filter_all') },
    ...Object.entries(categoryConfig).map(([key, config]) => ({ value: key, label: t(config.labelKey) })),
  ]

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        help={
          <HelpPopover>
            <p>{t('subtitle')}</p>
          </HelpPopover>
        }
      />

      {/* Toolbar: search + category filter on one row */}
      <div className="flex flex-wrap items-center gap-3">
        <ToolbarSearch
          placeholder={t('search_placeholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label={t('search_placeholder')}
        />
        <div className="max-w-full overflow-x-auto">
          <SegmentedControl
            value={selectedCategory ?? 'all'}
            onChange={(value) => setSelectedCategory(value === 'all' ? null : value)}
            options={categoryOptions}
            aria-label={t('category_filter_label')}
          />
        </div>
      </div>

      {/* Terms list */}
      <div>
        {filteredTerms.length === 0 ? (
          <EmptyState
            icon={Search}
            title={t('no_results_title')}
            description={<span data-ph-mask="">{t('no_results', { query: searchQuery })}</span>}
          />
        ) : (
          <div className="stagger-enter">
            {filteredTerms.map((term) => (
              <TermRow
                key={term.term}
                term={term}
                isExpanded={expandedTerms.has(term.term)}
                onToggle={() => toggleTerm(term.term)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Document templates */}
      <section>
        <h2 className="flex items-center gap-2 px-1 pb-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('templates_title')}
          <HelpPopover className="shrink-0">{t('templates_subtitle')}</HelpPopover>
        </h2>
        <a href="/docs/arkivplan-mall.md" download className={LINK_ROW_CLASS}>
          <FileDown className="h-4 w-4 shrink-0 self-center text-muted-foreground" />
          <span className="shrink-0 font-medium">{t('template_arkivplan_title')}</span>
          <span className="truncate text-xs text-muted-foreground">
            {t('template_arkivplan_description')}
          </span>
        </a>
        <a href="/docs/systemdokumentation-mall.md" download className={LINK_ROW_CLASS}>
          <FileDown className="h-4 w-4 shrink-0 self-center text-muted-foreground" />
          <span className="shrink-0 font-medium">{t('template_systemdokumentation_title')}</span>
          <span className="truncate text-xs text-muted-foreground">
            {t('template_systemdokumentation_description')}
          </span>
        </a>
      </section>

      {/* External resources */}
      <section>
        <h2 className="px-1 pb-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('external_resources_title')}
        </h2>
        <HelpLink
          href="https://www.skatteverket.se/foretag/foretagarguiden.4.361dc8c15312eff6fd1f87f.html"
          className={LINK_ROW_CLASS}
        >
          <ExternalLink className="h-4 w-4 shrink-0 self-center text-muted-foreground" />
          <span className="shrink-0 font-medium">{t('resource_skv_guide_title')}</span>
          <span className="truncate text-xs text-muted-foreground">{t('resource_skv_guide_description')}</span>
        </HelpLink>
        <HelpLink href="https://www.verksamt.se/" className={LINK_ROW_CLASS}>
          <ExternalLink className="h-4 w-4 shrink-0 self-center text-muted-foreground" />
          <span className="shrink-0 font-medium">Verksamt.se</span>
          <span className="truncate text-xs text-muted-foreground">{t('resource_verksamt_description')}</span>
        </HelpLink>
      </section>

      {/* Support: one quiet line */}
      <section className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-sm">
        <span className="text-muted-foreground">{t('support_subtitle')}</span>
        <SupportLink variant="inline" subject="Fråga från hjälpsidan" />
      </section>
    </div>
  )
}

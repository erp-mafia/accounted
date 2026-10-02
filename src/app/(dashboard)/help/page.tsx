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

const glossaryTerms: GlossaryTerm[] = [
  // Skatt
  {
    term: 'F-skatt',
    simpleTerm: 'Månatlig skatteinbetalning',
    definition:
      'F-skatt (företagsskatt) innebär att du som företagare själv ansvarar för att betala in preliminärskatt och egenavgifter. Du betalar in en fast summa varje månad baserat på din beräknade årsinkomst. Om du betalat för lite under året kan du få restskatt.',
    category: 'skatt',
    skatteverketUrl: 'https://www.skatteverket.se/foretag/foretagarguiden/foretagsformer/enskildnaringsverksamhet/fskatt.4.361dc8c15312eff6fd1f8a3.html',
    relatedTerms: ['Preliminärskatt', 'Restskatt', 'Egenavgifter'],
  },
  {
    term: 'Preliminärskatt',
    definition:
      'Skatt som betalas in i förskott under inkomståret, baserat på uppskattad årsinkomst. Din F-skatteinbetalning är en form av preliminärskatt.',
    category: 'skatt',
    relatedTerms: ['F-skatt', 'Restskatt'],
  },
  {
    term: 'Egenavgifter',
    simpleTerm: 'Sociala avgifter',
    definition:
      'Som enskild näringsidkare betalar du egenavgifter (ca 28,97%) istället för arbetsgivaravgifter. Avgifterna finansierar socialförsäkringar som pension, sjukpenning och föräldrapenning - saker som anställda får via sin arbetsgivare.',
    category: 'skatt',
    skatteverketUrl: 'https://www.skatteverket.se/foretag/foretagarguiden/avgifterochegenavgifter/egenavgifter.4.361dc8c15312eff6fd1e5e7.html',
    relatedTerms: ['Enskild firma'],
  },
  {
    term: 'Restskatt',
    definition:
      'Om du betalat in för lite preliminärskatt under året får du restskatt att betala. Det betyder att din faktiska skatt var högre än vad du betalade in via F-skatten.',
    category: 'skatt',
    relatedTerms: ['F-skatt', 'Preliminärskatt'],
  },
  {
    term: 'Schablonavdrag',
    simpleTerm: 'Enkla avdrag',
    definition:
      'Förenklade avdrag där du använder fasta belopp istället för att spara kvitton. Exempel: hemmakontor (2 000 kr/år) eller milersättning (25 kr/mil för bil). Perfekt om du inte vill krångla med att spara alla kvitton.',
    category: 'skatt',
    skatteverketUrl: 'https://www.skatteverket.se/privat/skatter/arbeteochinkomst/avdrag.4.6efe6285127ab4f1d25800023187.html',
    relatedTerms: ['Avdrag', 'Hemmakontor'],
  },
  {
    term: 'NE-bilaga',
    definition:
      'En bilaga till din inkomstdeklaration där du redovisar resultatet från din enskilda näringsverksamhet. Appen hjälper dig samla underlaget - du behöver inte förstå alla detaljer.',
    category: 'skatt',
    skatteverketUrl: 'https://www.skatteverket.se/privat/deklaration/blanketter/inkomstochfastighetsdeklaration/blankett21.4.6efe6285127ab4f1d25800023142.html',
    relatedTerms: ['Enskild firma', 'Inkomstdeklaration'],
  },
  {
    term: 'Disponibelt',
    simpleTerm: 'Ditt att spendera',
    definition:
      'Det belopp du kan använda fritt efter att vi räknat bort uppskattad skatt och moms från ditt saldo. Resten bör du "låsa" för framtida skatteinbetalningar.',
    category: 'skatt',
  },
  // Moms
  {
    term: 'Moms',
    simpleTerm: 'Mervärdesskatt',
    definition:
      'Mervärdesskatt som läggs på varor och tjänster. Som momsregistrerad lägger du på moms på dina fakturor och drar av moms på dina inköp. Skillnaden betalar eller får du tillbaka från Skatteverket.',
    category: 'moms',
    skatteverketUrl: 'https://www.skatteverket.se/foretag/moms.4.65fc817e1077c25b8328000206.html',
    relatedTerms: ['Momsperiod', 'Ingående moms', 'Utgående moms'],
  },
  {
    term: 'Momsperiod',
    simpleTerm: 'Hur ofta du rapporterar moms',
    definition:
      'Hur ofta du redovisar och betalar moms till Skatteverket. Vanligast är kvartal (4 gånger/år). Osäker? Börja med kvartal - du kan ändra senare. Omsättning under 1 miljon = år möjlig, över 40 miljoner = månad krävs.',
    category: 'moms',
    relatedTerms: ['Moms', 'Momsdeklaration'],
  },
  {
    term: 'Omvänd skattskyldighet',
    simpleTerm: 'Kunden betalar momsen',
    definition:
      'När du säljer till företag i andra EU-länder betalar köparen momsen i sitt eget land. Du fakturerar 0% moms och skriver "Omvänd skattskyldighet" eller "Reverse charge" på fakturan.',
    category: 'moms',
    skatteverketUrl: 'https://www.skatteverket.se/foretag/moms/saljavarortjanster/omvandskattskyldighetvidsaljandeinomeu.4.7be5268414bea0646940d0e.html',
    relatedTerms: ['EU-försäljning', 'Momsfri export'],
  },
  {
    term: 'Ingående moms',
    definition:
      'Moms du betalar på dina inköp (utgifter). Denna moms får du dra av från din momsredovisning.',
    category: 'moms',
    relatedTerms: ['Utgående moms', 'Moms'],
  },
  {
    term: 'Utgående moms',
    definition:
      'Moms du tar ut av dina kunder (lägger på fakturan). Denna moms ska du redovisa till Skatteverket.',
    category: 'moms',
    relatedTerms: ['Ingående moms', 'Moms'],
  },
  // Faktura
  {
    term: 'Förfallodag',
    definition:
      'Sista dag kunden ska betala fakturan. Vanligast är 30 dagar efter fakturadatum. Efter förfallodagen kan du skicka påminnelse och ta ut dröjsmålsränta.',
    category: 'faktura',
    relatedTerms: ['Dröjsmålsränta', 'Påminnelse'],
  },
  {
    term: 'OCR-nummer',
    definition:
      'Ett referensnummer som gör det enkelt att matcha inbetalningar med rätt faktura. Genereras automatiskt och bör alltid anges på fakturan.',
    category: 'faktura',
  },
  {
    term: 'Kreditfaktura',
    definition:
      'En "minusfaktura" som du skapar om du behöver korrigera eller makulera en redan skickad faktura. Beloppet blir negativt och kvittar ut originalfakturan.',
    category: 'faktura',
    relatedTerms: ['Faktura'],
  },
  // Bank
  {
    term: 'Clearingnummer',
    definition:
      'De första 4-5 siffrorna i ditt bankkonto som identifierar vilken bank och vilket kontor det tillhör. Exempel: 5331 = Avanza, 3300 = Nordea. Ofta separerat från kontonumret med bindestreck.',
    category: 'bank',
    relatedTerms: ['IBAN', 'BIC/SWIFT'],
  },
  {
    term: 'IBAN',
    definition:
      'Internationellt bankkontonummer som används för utlandsbetalningar. Svenska IBAN börjar med SE följt av 22 siffror. Din bank kan ge dig ditt IBAN.',
    category: 'bank',
    relatedTerms: ['BIC/SWIFT', 'Clearingnummer'],
  },
  {
    term: 'BIC/SWIFT',
    definition:
      'Bankens internationella identifieringskod, används tillsammans med IBAN för utlandsbetalningar. Exempel: SWEDSESS (Swedbank), NDEASESS (Nordea).',
    category: 'bank',
    relatedTerms: ['IBAN'],
  },
  // Företag
  {
    term: 'Enskild firma',
    simpleTerm: 'Enskild näringsverksamhet',
    definition:
      'Den enklaste företagsformen där du och företaget är samma juridiska person. Du äger allt personligen och ansvarar personligen för skulder. Lättast att starta men du betalar skatt via din privata deklaration.',
    category: 'företag',
    skatteverketUrl: 'https://www.skatteverket.se/foretag/foretagarguiden/foretagsformer/enskildnaringsverksamhet.4.361dc8c15312eff6fd1e5dc.html',
    relatedTerms: ['Aktiebolag', 'Egenavgifter', 'NE-bilaga'],
  },
  {
    term: 'Aktiebolag',
    simpleTerm: 'AB',
    definition:
      'Företagsform där företaget är en egen juridisk person, skild från dig. Kräver 25 000 kr i aktiekapital och mer administration, men ger begränsat personligt ansvar och andra skattemöjligheter.',
    category: 'företag',
    skatteverketUrl: 'https://www.skatteverket.se/foretag/foretagarguiden/foretagsformer/aktiebolag.4.361dc8c15312eff6fd18a05.html',
    relatedTerms: ['Enskild firma', 'Bolagsskatt'],
  },
  {
    term: 'Organisationsnummer',
    definition:
      'Ditt företags unika identitetsnummer. För enskild firma är det ditt personnummer + 100 på århundradesiffran (199001011234 blir 199101011234).',
    category: 'företag',
  },
  {
    term: 'Eget utlägg',
    simpleTerm: 'Betalat privat för bolagets räkning',
    definition:
      'När du som ägare lägger ut pengar privat för en kostnad som bolaget ska stå för. Registrera under Leverantörsfakturor → Ny, kryssa i "Jag har betalat detta privat". Verifikatet bokförs då direkt mot skuld till ägare (2893 för AB, 2018 för EF) istället för via leverantörsskuld. När bolaget senare ersätter dig kategoriserar du den utgående banktransaktionen mot samma konto.',
    category: 'bokföring',
    relatedTerms: ['Aktiebolag', 'Enskild firma'],
  },
]

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
  }, [searchQuery, selectedCategory])

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
          <span className="shrink-0 font-medium">Arkivplan</span>
          <span className="truncate text-xs text-muted-foreground">
            Mall enligt BFNAR 2013:2: beskriver var räkenskapsinformation förvaras
          </span>
        </a>
        <a href="/docs/systemdokumentation-mall.md" download className={LINK_ROW_CLASS}>
          <FileDown className="h-4 w-4 shrink-0 self-center text-muted-foreground" />
          <span className="shrink-0 font-medium">Systemdokumentation</span>
          <span className="truncate text-xs text-muted-foreground">
            Mall enligt BFL 5 kap. 11 §: beskriver bokföringssystemets uppbyggnad
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
          <span className="shrink-0 font-medium">Skatteverkets företagarguide</span>
          <span className="truncate text-xs text-muted-foreground">Omfattande guide för nya företagare</span>
        </HelpLink>
        <HelpLink href="https://www.verksamt.se/" className={LINK_ROW_CLASS}>
          <ExternalLink className="h-4 w-4 shrink-0 self-center text-muted-foreground" />
          <span className="shrink-0 font-medium">Verksamt.se</span>
          <span className="truncate text-xs text-muted-foreground">Starta och driva företag i Sverige</span>
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

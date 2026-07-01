'use client'

import { useState, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { HelpLink } from '@/components/ui/info-tooltip'
import { PageHeader } from '@/components/ui/page-header'
import {
  Search,
  BookOpen,
  Receipt,
  Calculator,
  Building2,
  FileText,
  FileDown,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { SupportLink } from '@/components/ui/support-link'
import { Mail } from 'lucide-react'

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
  skatt: { labelKey: 'category_skatt', icon: Calculator, color: 'bg-secondary text-muted-foreground' },
  moms: { labelKey: 'category_moms', icon: Receipt, color: 'bg-secondary text-muted-foreground' },
  faktura: { labelKey: 'category_faktura', icon: FileText, color: 'bg-secondary text-muted-foreground' },
  bokföring: { labelKey: 'category_bokforing', icon: BookOpen, color: 'bg-secondary text-muted-foreground' },
  bank: { labelKey: 'category_bank', icon: Building2, color: 'bg-secondary text-muted-foreground' },
  företag: { labelKey: 'category_foretag', icon: Building2, color: 'bg-secondary text-muted-foreground' },
}

function TermCard({ term, isExpanded, onToggle }: { term: GlossaryTerm; isExpanded: boolean; onToggle: () => void }) {
  const t = useTranslations('help')
  const config = categoryConfig[term.category]
  const CategoryIcon = config.icon

  return (
    <Card className={cn('transition-colors', isExpanded && 'ring-2 ring-primary/20')}>
      <CardContent className="pt-4">
        <button
          onClick={onToggle}
          className="w-full text-left"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className={cn('p-2 rounded-lg', config.color)}>
                <CategoryIcon className="h-4 w-4" />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-medium">{term.term}</h3>
                  {term.simpleTerm && (
                    <span className="text-sm text-muted-foreground font-normal">
                      {term.simpleTerm}
                    </span>
                  )}
                </div>
                {!isExpanded && (
                  <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                    {term.definition}
                  </p>
                )}
              </div>
            </div>
            {isExpanded ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-1" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-1" />
            )}
          </div>
        </button>

        {isExpanded && (
          <div className="mt-4 pl-11 space-y-3 animate-fade-in">
            <p className="text-sm text-muted-foreground leading-relaxed">
              {term.definition}
            </p>

            {term.relatedTerms && term.relatedTerms.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">{t('related_label')}</span>
                <span className="text-xs text-muted-foreground">
                  {term.relatedTerms.join(', ')}
                </span>
              </div>
            )}

            {term.skatteverketUrl && (
              <HelpLink href={term.skatteverketUrl}>
                {t('read_more_skv')}
                <ExternalLink className="h-3 w-3" />
              </HelpLink>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

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

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
      />

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type="search"
          placeholder={t('search_placeholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Category filters */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setSelectedCategory(null)}
          className={cn(
            'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
            selectedCategory === null
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary text-muted-foreground hover:text-foreground'
          )}
        >
          {t('filter_all')}
        </button>
        {Object.entries(categoryConfig).map(([key, config]) => (
          <button
            key={key}
            onClick={() => setSelectedCategory(selectedCategory === key ? null : key)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
              selectedCategory === key
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground hover:text-foreground'
            )}
          >
            {t(config.labelKey)}
          </button>
        ))}
      </div>

      {/* Terms list */}
      <div className="space-y-4">
        {filteredTerms.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Search className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">
                {t('no_results', { query: searchQuery })}
              </p>
            </CardContent>
          </Card>
        ) : (
          filteredTerms.map((term) => (
            <TermCard
              key={term.term}
              term={term}
              isExpanded={expandedTerms.has(term.term)}
              onToggle={() => toggleTerm(term.term)}
            />
          ))
        )}
      </div>

      {/* Document templates */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('templates_title')}</CardTitle>
          <CardDescription>{t('templates_subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <a
              href="/docs/arkivplan-mall.md"
              download
              className="p-3 rounded-lg border border-border hover:border-primary/50 transition-colors block"
            >
              <div className="flex items-center gap-2">
                <FileDown className="h-4 w-4" />
                <span className="font-medium">Arkivplan</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Mall enligt BFNAR 2013:2 — beskriver var räkenskapsinformation förvaras
              </p>
            </a>
            <a
              href="/docs/systemdokumentation-mall.md"
              download
              className="p-3 rounded-lg border border-border hover:border-primary/50 transition-colors block"
            >
              <div className="flex items-center gap-2">
                <FileDown className="h-4 w-4" />
                <span className="font-medium">Systemdokumentation</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Mall enligt BFL 5 kap. 11 § — beskriver bokföringssystemets uppbyggnad
              </p>
            </a>
          </div>
        </CardContent>
      </Card>

      {/* External resources */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('external_resources_title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <HelpLink
              href="https://www.skatteverket.se/foretag/foretagarguiden.4.361dc8c15312eff6fd1f87f.html"
              className="p-3 rounded-lg border border-border hover:border-primary/50 transition-colors block"
            >
              <div className="flex items-center gap-2">
                <ExternalLink className="h-4 w-4" />
                <span>Skatteverkets företagarguide</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Omfattande guide för nya företagare
              </p>
            </HelpLink>
            <HelpLink
              href="https://www.verksamt.se/"
              className="p-3 rounded-lg border border-border hover:border-primary/50 transition-colors block"
            >
              <div className="flex items-center gap-2">
                <ExternalLink className="h-4 w-4" />
                <span>Verksamt.se</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Starta och driva företag i Sverige
              </p>
            </HelpLink>
          </div>
        </CardContent>
      </Card>

      {/* Support section */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('support_title')}</CardTitle>
          </div>
          <CardDescription>
            {t('support_subtitle')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SupportLink variant="inline" subject="Fråga från hjälpsidan" />
        </CardContent>
      </Card>
    </div>
  )
}

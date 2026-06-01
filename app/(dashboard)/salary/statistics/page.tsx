'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Download, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { SALARY_STAT_REPORTS, type SalaryStatReport } from '@/lib/salary/statistics/registry'

const NOW_YEAR = new Date().getFullYear()
const YEARS = [NOW_YEAR, NOW_YEAR - 1, NOW_YEAR - 2]
const MONTHS = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december',
]

// Group the reports by issuing authority for the left rail, mirroring the
// Redovisning report navigation.
const NAV_GROUPS: { authority: string; ids: string[] }[] = [
  { authority: 'SCB', ids: ['sus', 'klp', 'slp'] },
  { authority: 'Svenskt Näringsliv', ids: ['sn'] },
]

async function downloadFile(url: string, filename: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) {
    const json = await res.json().catch(() => ({}))
    throw new Error(json.error || 'Kunde inte skapa rapporten')
  }
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(href)
}

export default function SalaryStatisticsPage() {
  const { toast } = useToast()
  const [active, setActive] = useState('sus')
  const [year, setYear] = useState(String(NOW_YEAR))
  const [month, setMonth] = useState('1')
  const [klpYear, setKlpYear] = useState(String(NOW_YEAR))
  const [klpMonth, setKlpMonth] = useState('1')
  const [slpYear, setSlpYear] = useState(String(NOW_YEAR))
  const [snYear, setSnYear] = useState(String(NOW_YEAR))
  const [snDelagar, setSnDelagar] = useState('')
  const [snForbund, setSnForbund] = useState('')
  const [snAvtal, setSnAvtal] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const byId = useMemo(
    () => Object.fromEntries(SALARY_STAT_REPORTS.map(r => [r.id, r])) as Record<string, SalaryStatReport>,
    [],
  )
  const report = byId[active]

  const run = async (key: string, url: string, filename: string) => {
    setBusy(key)
    try {
      await downloadFile(url, filename)
    } catch (e) {
      toast({
        title: 'Kunde inte skapa rapporten',
        description: e instanceof Error ? e.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setBusy(null)
    }
  }

  const yearOptions = YEARS.map(y => ({ value: String(y), label: String(y) }))
  const monthOptions = MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))

  return (
    <div className="space-y-8">
      <Link href="/salary" className="inline-flex items-center text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Tillbaka till lön
      </Link>
      <PageHeader
        title="Statistik och rapporter"
        description="Generera myndighets- och branschrapporter från dina lönekörningar."
      />

      <div className="flex flex-col sm:flex-row gap-6 sm:gap-8">
        <StatNav active={active} onChange={setActive} byId={byId} />

        <div className="flex-1 min-w-0">
          {report && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{report.authority} {report.name}</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">{report.description}</p>
              </CardHeader>
              <CardContent>
                {active === 'sus' && (
                  <>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                      <PeriodSelect label="År" value={year} onChange={setYear} options={yearOptions} />
                      <PeriodSelect label="Månad" value={month} onChange={setMonth} options={monthOptions} />
                      <Button
                        onClick={() => run('sus', `/api/salary/statistics/sus?year=${year}&month=${month}&format=txt`, `SuS_${year}${String(month).padStart(2, '0')}.txt`)}
                        disabled={busy !== null}
                      >
                        {busy === 'sus' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
                        Ladda ner .txt
                      </Button>
                    </div>
                    <p className="mt-3 text-[11px] text-muted-foreground">
                      En post per sjukfall under sjuklöneperioden (dag 1–14) för månaden. Sjukfall byggs av
                      registrerade sjukdagar; kontrollera gränsdragningen vid månadsskiften. Stäm av mot SCB:s
                      datafilbeskrivning innan inlämning.
                    </p>
                  </>
                )}

                {active === 'klp' && (
                  <>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                      <PeriodSelect label="År" value={klpYear} onChange={setKlpYear} options={yearOptions} />
                      <PeriodSelect label="Månad" value={klpMonth} onChange={setKlpMonth} options={monthOptions} />
                      <Button
                        onClick={() => run('klp', `/api/salary/statistics/klp?year=${klpYear}&month=${klpMonth}&format=txt`, `KLP_${klpYear}${String(klpMonth).padStart(2, '0')}.txt`)}
                        disabled={busy !== null}
                      >
                        {busy === 'klp' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
                        Ladda ner .txt
                      </Button>
                    </div>
                    <p className="mt-3 text-[11px] text-muted-foreground">
                      Aggregerad konjunkturlönestatistik per personalkategori (timavlönade/månadsavlönade
                      arbetare, tjänstemän) baserat på utbetalningsmånad. Övertidstimmar och retroaktiv lön
                      spåras inte ännu och nollfylls. Stäm av mot SCB:s postbeskrivning (KLP) innan inlämning.
                    </p>
                  </>
                )}

                {active === 'slp' && (
                  <>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                      <PeriodSelect label="År" value={slpYear} onChange={setSlpYear} options={yearOptions} />
                      <Button
                        onClick={() => run('slp', `/api/salary/statistics/slp?year=${slpYear}&format=txt`, `SLP_${slpYear}.txt`)}
                        disabled={busy !== null}
                      >
                        {busy === 'slp' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
                        Ladda ner .txt
                      </Button>
                    </div>
                    <p className="mt-3 text-[11px] text-muted-foreground">
                      Individbaserad fil (mätperiod september). Kräver yrkeskod (SSYK), CFAR-nummer,
                      arbetstidsart och anställningsform per anställd — fält som saknas nollfylls. Stäm av mot
                      SCB:s postbeskrivning (SCB-FS 2022:6) innan inlämning.
                    </p>
                  </>
                )}

                {active === 'sn' && (
                  <>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:flex-wrap">
                      <PeriodSelect label="År" value={snYear} onChange={setSnYear} options={yearOptions} />
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">Delägarnummer</Label>
                        <Input value={snDelagar} onChange={e => setSnDelagar(e.target.value)} className="w-36" placeholder="t.ex. 1234567" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">Förbundsnummer</Label>
                        <Input value={snForbund} onChange={e => setSnForbund(e.target.value)} className="w-28" placeholder="t.ex. 12" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">Avtalskod</Label>
                        <Input value={snAvtal} onChange={e => setSnAvtal(e.target.value)} className="w-28" placeholder="t.ex. 001" />
                      </div>
                      <Button
                        onClick={() => {
                          const qs = new URLSearchParams({ year: snYear, format: 'txt' })
                          if (snDelagar) qs.set('delagarnummer', snDelagar)
                          if (snForbund) qs.set('forbundsnummer', snForbund)
                          if (snAvtal) qs.set('avtalskod', snAvtal)
                          run('sn', `/api/salary/statistics/sn?${qs.toString()}`, `SN_lonestatistik_${snYear}.txt`)
                        }}
                        disabled={busy !== null}
                      >
                        {busy === 'sn' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
                        Ladda ner .txt
                      </Button>
                    </div>
                    <p className="mt-3 text-[11px] text-muted-foreground">
                      Samma postbeskrivning som SLP. Medlemskoderna (delägar-, förbundsnummer, avtalskod) finns
                      i ditt informationsbrev från Svenskt Näringsliv.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function StatNav({
  active, onChange, byId,
}: {
  active: string
  onChange: (v: string) => void
  byId: Record<string, SalaryStatReport>
}) {
  return (
    <>
      {/* Mobile: grouped select */}
      <div className="sm:hidden">
        <Select value={active} onValueChange={onChange}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {SALARY_STAT_REPORTS.map(r => (
              <SelectItem key={r.id} value={r.id}>{r.authority} {r.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop: vertical left rail */}
      <nav
        className="hidden sm:block w-56 flex-shrink-0 sticky top-8 self-start"
        aria-label="Statistikrapporter"
      >
        <ul className="space-y-6">
          {NAV_GROUPS.map(group => (
            <li key={group.authority}>
              <p className="text-[11px] font-semibold text-muted-foreground/80 uppercase tracking-[0.08em] mb-2 px-3">
                {group.authority}
              </p>
              <ul className="space-y-px">
                {group.ids.filter(id => byId[id]).map(id => {
                  const isActive = active === id
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => onChange(id)}
                        aria-current={isActive ? 'page' : undefined}
                        className={cn(
                          'w-full text-left px-3 py-1.5 rounded-md text-[13px] transition-colors',
                          isActive
                            ? 'bg-primary/10 text-foreground font-medium'
                            : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
                        )}
                      >
                        {byId[id].name}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
      </nav>
    </>
  )
}

function PeriodSelect({
  label, value, onChange, options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}

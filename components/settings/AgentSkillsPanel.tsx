'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, GraduationCap, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'

type Tier = 'horizontal' | 'vertical' | 'modifier'

interface AtomMeta {
  id: string
  tier: Tier
  title: string
  description: string
  active: boolean
}

const TIER_ORDER: Tier[] = ['horizontal', 'vertical', 'modifier']

const TIER_SECTION: Record<Tier, { title: string; blurb: string }> = {
  horizontal: {
    title: 'Kärnkompetens',
    blurb: 'Svenska bokförings- och skatteregler som assistenten alltid har med sig.',
  },
  vertical: {
    title: 'Anpassat för din bransch',
    blurb: 'Branschkunskap som valts utifrån vad ditt företag gör. Vilande områden finns men används inte för dig.',
  },
  modifier: {
    title: 'Din bolagssituation',
    blurb: 'Särskilda regler för hur just ditt bolag är uppbyggt.',
  },
}

// Mirror of the chat surface's markdown styling (components/agent/AgentChat.tsx),
// trimmed for a wider settings column.
const PROSE =
  'prose prose-sm max-w-none text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ' +
  'prose-headings:font-display prose-headings:font-normal prose-headings:tracking-tight ' +
  'prose-h1:text-lg prose-h2:text-base prose-h3:text-sm prose-p:my-2 prose-p:leading-6 ' +
  'prose-strong:font-semibold prose-strong:text-foreground prose-ul:my-2 prose-li:my-0.5 ' +
  'prose-a:text-foreground prose-a:underline prose-a:underline-offset-2 ' +
  'prose-code:bg-secondary prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-xs ' +
  'prose-code:before:content-none prose-code:after:content-none ' +
  'prose-table:my-2 prose-table:text-xs [&_table]:w-full ' +
  '[&_th]:border-b [&_th]:border-border [&_th]:py-1.5 [&_th]:px-2 [&_th]:text-left [&_th]:font-medium ' +
  '[&_th]:text-muted-foreground [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-[10px] ' +
  '[&_td]:border-b [&_td]:border-border [&_td]:py-1.5 [&_td]:px-2 [&_td]:align-top'

// The API returns errors either as a plain string (legacy/validation) or as
// the canonical { code, message } envelope — extract something renderable.
function apiErrorText(error: unknown): string | undefined {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    const m = (error as { message?: unknown }).message
    return typeof m === 'string' ? m : undefined
  }
  return undefined
}

export function AgentSkillsPanel() {
  const { toast } = useToast()

  const [atoms, setAtoms] = useState<AtomMeta[] | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [bodies, setBodies] = useState<Record<string, string>>({})
  const [loadingBody, setLoadingBody] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/agent/skills')
    const json = await res.json()
    if (!res.ok) {
      toast({ title: 'Kunde inte hämta kunskap', description: apiErrorText(json.error), variant: 'destructive' })
      setAtoms([])
      return
    }
    setAtoms(json.data as AtomMeta[])
  }, [toast])

  useEffect(() => { void load() }, [load])

  const grouped = useMemo(() => {
    const map: Record<Tier, AtomMeta[]> = { horizontal: [], vertical: [], modifier: [] }
    for (const a of atoms ?? []) map[a.tier]?.push(a)
    return map
  }, [atoms])

  const counts = useMemo(() => {
    const total = atoms?.length ?? 0
    const active = atoms?.filter((a) => a.active).length ?? 0
    return { total, active }
  }, [atoms])

  async function toggle(atom: AtomMeta) {
    if (expandedId === atom.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(atom.id)
    if (bodies[atom.id] !== undefined) return
    setLoadingBody(atom.id)
    try {
      const res = await fetch(`/api/agent/skills?slug=${encodeURIComponent(atom.id)}`)
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Kunde inte läsa kunskapen', description: apiErrorText(json.error), variant: 'destructive' })
        return
      }
      setBodies((prev) => ({ ...prev, [atom.id]: (json.data?.body as string) ?? '' }))
    } finally {
      setLoadingBody(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Vad min assistent kan</CardTitle>
        <CardDescription>
          Utöver vad den minns om ditt företag bygger assistenten på en uppsättning kunskapsområden
          om svensk bokföring och skatt. Kärnkompetensen gäller alla; bransch- och bolagsanpassningen
          väljs utifrån ditt företag. Klicka för att läsa hela kunskapen.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-8">
        {atoms && (
          <div className="text-xs text-muted-foreground tabular-nums">
            {counts.total} kunskapsområden · {counts.active} aktiva för ditt företag
          </div>
        )}

        {atoms === null && (
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        )}

        {atoms && atoms.length === 0 && (
          <EmptyState
            icon={GraduationCap}
            title="Inga kunskapsområden ännu"
            description="När din assistent har komponerats dyker dess kunskapsområden upp här."
          />
        )}

        {atoms && atoms.length > 0 &&
          TIER_ORDER.filter((tier) => grouped[tier].length > 0).map((tier) => (
            <section key={tier} className="space-y-3">
              <div className="space-y-1">
                <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                  {TIER_SECTION[tier].title}
                </h2>
                <p className="text-xs text-muted-foreground">{TIER_SECTION[tier].blurb}</p>
              </div>

              <ul className="space-y-2">
                {grouped[tier].map((atom) => {
                  const isOpen = expandedId === atom.id
                  const isLoading = loadingBody === atom.id
                  const body = bodies[atom.id]
                  const dormant = !atom.active
                  return (
                    <li
                      key={atom.id}
                      className={`rounded-lg border border-border transition-colors ${
                        dormant ? 'bg-muted/30' : 'bg-card'
                      }`}
                    >
                      <button
                        onClick={() => toggle(atom)}
                        aria-expanded={isOpen}
                        className="flex w-full items-start gap-3 p-4 text-left"
                      >
                        <ChevronDown
                          className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                            isOpen ? '' : '-rotate-90'
                          }`}
                        />
                        <div className="flex-1 min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-foreground">{atom.title}</span>
                            {tier !== 'horizontal' && (
                              <Badge variant={atom.active ? 'success' : 'secondary'}>
                                {atom.active ? 'Aktiv' : 'Vilande'}
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">{atom.description}</p>
                        </div>
                      </button>

                      {isOpen && (
                        <div className="border-t border-border px-4 py-4 pl-11">
                          {isLoading && (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Läser in…
                            </div>
                          )}
                          {!isLoading && body !== undefined && body.length > 0 && (
                            <div className={PROSE}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
                            </div>
                          )}
                          {!isLoading && body !== undefined && body.length === 0 && (
                            <p className="text-xs text-muted-foreground">
                              Innehållet kunde inte läsas in.
                            </p>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
      </CardContent>
    </Card>
  )
}

'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale } from 'next-intl'
import { ChevronDown, GraduationCap, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AttnLine } from '@/components/ui/attn-line'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { HelpPopover } from '@/components/ui/help-popover'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { SettingsGroup, SettingsRowNote } from '@/components/settings/SettingsRows'
import { cn } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

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
  'prose-code:bg-secondary prose-code:rounded-sm prose-code:px-1 prose-code:py-0.5 prose-code:text-xs ' +
  'prose-code:before:content-none prose-code:after:content-none ' +
  'prose-table:my-2 prose-table:text-xs [&_table]:w-full ' +
  '[&_th]:border-b [&_th]:border-border [&_th]:py-1.5 [&_th]:px-2 [&_th]:text-left [&_th]:font-medium ' +
  '[&_th]:text-muted-foreground [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-[10px] ' +
  '[&_td]:border-b [&_td]:border-border [&_td]:py-1.5 [&_td]:px-2 [&_td]:align-top'

export function AgentSkillsPanel() {
  const { toast } = useToast()
  const errorLocale = useLocale() as ErrorLocale

  // null = the atom list is not known: still loading, or the read failed
  // (loadError). A failed read must never render the "Inga kunskapsområden
  // ännu" EmptyState: that is a claim about the assistant's composition, and
  // it is only true after a confirmed empty read.
  const [atoms, setAtoms] = useState<AtomMeta[] | null>(null)
  // detail === null: transient, so the line carries a retry. A detail sentence
  // means the user has to act (an expired session) and a retry cannot help.
  const [loadError, setLoadError] = useState<{ detail: string | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [bodies, setBodies] = useState<Record<string, string>>({})
  const [loadingBody, setLoadingBody] = useState<string | null>(null)

  // The cancelled closure is the same idiom every sibling panel uses
  // (TeamPanel, AccountDangerZone): a response that lands after unmount, or
  // after a newer load superseded this one, must not setState.
  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoadError(null)
      try {
        const res = await fetch('/api/agent/skills')
        if (!res.ok) {
          // Not-JSON bodies (an HTML error page, an empty 502) leave null, and
          // getErrorMessage falls back to the status map.
          const json = await res.json().catch(() => null)
          if (cancelled) return
          const sessionGone = res.status === 401 || res.status === 403
          setAtoms(null)
          setLoadError({
            detail: sessionGone
              ? getErrorMessage(json, { statusCode: res.status, locale: errorLocale })
              : null,
          })
          return
        }
        // A 200 whose body will not parse throws into the catch below; a 200
        // without the list is a failed read too. Neither may become a
        // fabricated "Inga kunskapsområden ännu".
        const json = await res.json()
        if (cancelled) return
        if (!Array.isArray(json?.data)) {
          setAtoms(null)
          setLoadError({ detail: null })
          return
        }
        setAtoms(json.data as AtomMeta[])
      } catch {
        if (!cancelled) {
          setAtoms(null)
          setLoadError({ detail: null })
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [reloadKey, errorLocale])

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
      if (!res.ok) {
        // Not-JSON bodies (an HTML error page, an empty 502) leave null, and
        // getErrorMessage falls back to the status map.
        const json = await res.json().catch(() => null)
        toast({
          title: 'Kunde inte läsa kunskapen',
          description: getErrorMessage(json, { statusCode: res.status, locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }
      const json = await res.json()
      setBodies((prev) => ({ ...prev, [atom.id]: (json.data?.body as string) ?? '' }))
    } catch (err) {
      // A rejected fetch or a 200 whose body will not parse never reaches the
      // !res.ok arm above: without this toast the expanded row just sits
      // empty with zero feedback. One toast per outcome, never two:
      // TOAST_LIMIT is 1 (components/ui/use-toast.tsx) and a second would
      // evict the first.
      toast({
        title: 'Kunde inte läsa kunskapen',
        description: getErrorMessage(err, { locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setLoadingBody(null)
    }
  }

  return (
    <div>
      {/* Dynamic status stays visible; the static "what this is" copy sits
          behind the "?" next to it. */}
      {atoms && (
        <div className="flex items-center gap-2 px-1">
          <SettingsRowNote className="tabular-nums">
            {counts.total} kunskapsområden · {counts.active} aktiva för ditt företag
          </SettingsRowNote>
          <HelpPopover className="shrink-0">
            Utöver vad den minns om ditt företag bygger assistenten på en uppsättning
            kunskapsområden om svensk bokföring och skatt. Kärnkompetensen gäller alla;
            bransch- och bolagsanpassningen väljs utifrån ditt företag. Klicka på ett
            område för att läsa hela kunskapen.
          </HelpPopover>
        </div>
      )}

      {/* Live region always mounted so the failure is announced when it
          appears, not merely inserted. */}
      <div role="status" aria-live="polite" className="min-w-0 px-1">
        {loadError && (
          <AttnLine
            action={
              loadError.detail
                ? undefined
                : { label: 'Försök igen', onClick: () => setReloadKey((k) => k + 1) }
            }
          >
            {loadError.detail
              ? `Kunskapsområdena kunde inte läsas in just nu. ${loadError.detail}`
              : 'Kunskapsområdena kunde inte läsas in just nu.'}
          </AttnLine>
        )}
      </div>

      {atoms === null && !loadError && (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
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
          <SettingsGroup key={tier} label={TIER_SECTION[tier].title} help={TIER_SECTION[tier].blurb}>
            {grouped[tier].map((atom) => {
              const isOpen = expandedId === atom.id
              const isLoading = loadingBody === atom.id
              const body = bodies[atom.id]
              const dormant = !atom.active
              return (
                <div key={atom.id} className="border-b border-border">
                  <button
                    onClick={() => toggle(atom)}
                    aria-expanded={isOpen}
                    className="flex w-full items-start gap-3 px-1 py-3 text-left"
                  >
                    <ChevronDown
                      className={cn(
                        'mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                        !isOpen && '-rotate-90',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'block text-sm font-medium',
                          dormant ? 'text-muted-foreground' : 'text-foreground',
                        )}
                      >
                        {atom.title}
                      </span>
                      <span className="block text-xs text-muted-foreground">{atom.description}</span>
                    </span>
                    {/* Chips mark exceptions: active is the normal state and
                        renders as muted text, only dormant gets a Badge. */}
                    {tier !== 'horizontal' && (
                      atom.active ? (
                        <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">Aktiv</span>
                      ) : (
                        <Badge variant="outline" className="mt-0.5 shrink-0">Vilande</Badge>
                      )
                    )}
                  </button>

                  {isOpen && (
                    <div className="px-1 pb-4 pl-8">
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
                </div>
              )
            })}
          </SettingsGroup>
        ))}
    </div>
  )
}

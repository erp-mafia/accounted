'use client'

import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { Pin, ArrowUpRight } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { AgentCompetence, AtomTier, FactKind, FactSource } from '@/lib/agent-context/agent-competence'

/**
 * Read-only views of the agent's competence (domain-knowledge atoms) and top
 * learned facts, for the "Vad din agent vet" overview. Each is a standalone
 * Card so it can sit in its own tab. Full editable management lives in
 * /settings/assistant; each links there.
 */

const TIER_ORDER: AtomTier[] = ['horizontal', 'vertical', 'modifier']

export function CompetenceCard({ competence }: { competence: AgentCompetence }) {
  const t = useTranslations('agentKnowledge')
  const { atoms } = competence
  const activeAtoms = atoms.filter((a) => a.active).length
  const tierLabel = (tier: AtomTier) =>
    tier === 'horizontal' ? t('tier_horizontal') : tier === 'vertical' ? t('tier_vertical') : t('tier_modifier')

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('comp_title')}</CardTitle>
        <CardDescription>{t('comp_desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-0">
        {atoms.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('comp_empty')}</p>
        ) : (
          <>
            {TIER_ORDER.map((tier) => {
              const items = atoms.filter((a) => a.tier === tier)
              if (items.length === 0) return null
              return (
                <div key={tier} className="space-y-2">
                  <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {tierLabel(tier)}
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {items.map((a) => (
                      <Badge
                        key={a.id}
                        variant={a.active ? 'secondary' : 'outline'}
                        className={a.active ? '' : 'text-muted-foreground'}
                        title={a.description}
                      >
                        {a.title}
                        {!a.active && tier !== 'horizontal' && (
                          <span className="ml-1.5 opacity-70">· {t('badge_dormant')}</span>
                        )}
                      </Badge>
                    ))}
                  </div>
                </div>
              )
            })}
            <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
              <span className="tabular-nums">{t('comp_count', { total: atoms.length, active: activeAtoms })}</span>
              <ManageLink href="/settings/assistant?view=skills" label={t('comp_manage')} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function FactsCard({ competence }: { competence: AgentCompetence }) {
  const t = useTranslations('agentKnowledge')
  const { facts, factsActiveTotal } = competence
  const kindLabel = (k: FactKind) =>
    k === 'fact' ? t('kind_fact') : k === 'preference' ? t('kind_preference') : k === 'pattern' ? t('kind_pattern') : t('kind_correction')
  const sourceLabel = (s: FactSource) =>
    s === 'composer' ? t('source_composer') : s === 'user_taught' ? t('source_user_taught') : s === 'agent_learned' ? t('source_agent_learned') : t('source_derived')

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('facts_title')}</CardTitle>
        <CardDescription>{t('facts_desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {facts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('facts_empty')}</p>
        ) : (
          <>
            <ul className="space-y-3">
              {facts.map((f) => (
                <li key={f.id} className="flex items-start gap-2">
                  {f.is_pinned ? (
                    <Pin className="mt-1 h-3.5 w-3.5 shrink-0 fill-current text-muted-foreground" aria-label={t('facts_pinned')} />
                  ) : (
                    <span className="mt-1 h-3.5 w-3.5 shrink-0" aria-hidden />
                  )}
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm text-foreground">{f.content}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {kindLabel(f.kind)} · {sourceLabel(f.source)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {factsActiveTotal > facts.length ? t('facts_more', { n: factsActiveTotal - facts.length }) : ''}
              </span>
              <ManageLink href="/settings/assistant" label={t('facts_manage')} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function ManageLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-foreground underline underline-offset-2 hover:text-muted-foreground">
      {label}
      <ArrowUpRight className="h-3 w-3" />
    </Link>
  )
}

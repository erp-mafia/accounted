'use client'

import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { Pin, ArrowUpRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsRows'
import type { AgentCompetence, AtomTier, FactKind, FactSource } from '@/lib/agent-context/agent-competence'

/**
 * Read-only views of the agent's competence (domain-knowledge atoms) and top
 * learned facts, for the "Vad din agent vet" overview. Each renders as a flat
 * settings group (Fönster language) with its description behind the group
 * "?" help. Full editable management lives in /settings/assistant; each
 * links there.
 */

const TIER_ORDER: AtomTier[] = ['horizontal', 'vertical', 'modifier']

export function CompetenceCard({ competence }: { competence: AgentCompetence }) {
  const t = useTranslations('agentKnowledge')
  const { atoms } = competence
  const activeAtoms = atoms.filter((a) => a.active).length
  const tierLabel = (tier: AtomTier) =>
    tier === 'horizontal' ? t('tier_horizontal') : tier === 'vertical' ? t('tier_vertical') : t('tier_modifier')

  return (
    <SettingsGroup label={t('comp_title')} help={t('comp_desc')}>
      {atoms.length === 0 ? (
        <p className="px-1 py-3 text-sm text-muted-foreground">{t('comp_empty')}</p>
      ) : (
        <>
          {/* One row per tier: micro-label left, atom chips right. Dormant
              atoms are the exception the outline chip variant marks. */}
          {TIER_ORDER.map((tier) => {
            const items = atoms.filter((a) => a.tier === tier)
            if (items.length === 0) return null
            return (
              <SettingsRow key={tier} label={tierLabel(tier)} align="baseline">
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
              </SettingsRow>
            )
          })}
          <div className="flex items-center justify-between gap-4 px-1 pt-3 text-xs text-muted-foreground">
            <span className="tabular-nums">{t('comp_count', { total: atoms.length, active: activeAtoms })}</span>
            <ManageLink href="/settings/assistant?view=skills" label={t('comp_manage')} />
          </div>
        </>
      )}
    </SettingsGroup>
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
    <SettingsGroup label={t('facts_title')} help={t('facts_desc')}>
      {facts.length === 0 ? (
        <p className="px-1 py-3 text-sm text-muted-foreground">{t('facts_empty')}</p>
      ) : (
        <>
          {/* Flat hairline rows: fact content with its kind/source flowing
              inline as muted text; the pin marks the exception. */}
          <ul>
            {facts.map((f) => (
              <li key={f.id} className="flex items-start gap-2 border-b border-border px-1 py-3">
                {f.is_pinned ? (
                  <Pin role="img" className="mt-1 h-3.5 w-3.5 shrink-0 fill-current text-muted-foreground" aria-label={t('facts_pinned')} />
                ) : (
                  <span className="mt-1 h-3.5 w-3.5 shrink-0" aria-hidden />
                )}
                <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-sm text-foreground">{f.content}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {kindLabel(f.kind)} · {sourceLabel(f.source)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-4 px-1 pt-3 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {factsActiveTotal > facts.length ? t('facts_more', { n: factsActiveTotal - facts.length }) : ''}
            </span>
            <ManageLink href="/settings/assistant?view=memory" label={t('facts_manage')} />
          </div>
        </>
      )}
    </SettingsGroup>
  )
}

function ManageLink({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href}>
        {label}
        <ArrowUpRight className="ml-1 h-3 w-3" />
      </Link>
    </Button>
  )
}

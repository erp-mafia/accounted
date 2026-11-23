'use client'

import { useCallback } from 'react'
import { useTranslations } from 'next-intl'

/** The pack slug behind a knowledge id: "horizontal/swedish-vat" -> "swedish-vat". */
function packSlug(id: string): string {
  return id.split('/')[1] ?? id
}

/** The skills_registry messages, as a name lookup reads them. */
export interface KnowledgeMessages {
  has: (key: string) => boolean
  text: (key: string) => string
}

/**
 * A knowledge pack's display name in the messages given, falling back to its
 * registry title. The one lookup of that name: the catalogue, the knowledge
 * folders and the context graph's knowledge dots read it through
 * useKnowledgeName.
 */
export function knowledgeNameIn(messages: KnowledgeMessages, id: string, title: string): string {
  const key = `knowledge_names.${packSlug(id)}`
  return messages.has(key) ? messages.text(key) : title
}

/** A knowledge pack's display name, falling back to its registry title. The same function for as long as the messages are. */
export function useKnowledgeName() {
  const t = useTranslations('skills_registry')
  return useCallback((id: string, title: string) => knowledgeNameIn({ has: (key) => t.has(key), text: (key) => t(key) }, id, title), [t])
}

/** A pack's one-line description for people; the registry's own is written for agent routing. */
export function useKnowledgeDesc() {
  const t = useTranslations('skills_registry')
  return (id: string, fallback: string) => {
    const key = `knowledge_descs.${packSlug(id)}`
    return t.has(key) ? t(key) : fallback
  }
}

/**
 * An Accounted analysis's name and one-line summary in the page's language.
 * The analysis text the AI reads stays Swedish (lib/agent-skills/analyses.ts),
 * so an analysis without messages falls back to its own name and summary.
 */
export function useAnalysisLabel() {
  const t = useTranslations('skills_registry')
  return (slug: string, fallback: { name: string; summary: string }) => {
    const base = `analyses.${slug}`
    return {
      name: t.has(`${base}.name`) ? t(`${base}.name`) : fallback.name,
      summary: t.has(`${base}.summary`) ? t(`${base}.summary`) : fallback.summary,
    }
  }
}

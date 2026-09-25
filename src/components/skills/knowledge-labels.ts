'use client'

import { useTranslations } from 'next-intl'

/** The pack slug behind a knowledge id: "horizontal/swedish-vat" -> "swedish-vat". */
function packSlug(id: string): string {
  return id.split('/')[1] ?? id
}

/** A knowledge pack's display name, falling back to its registry title. */
export function useKnowledgeName() {
  const t = useTranslations('skills_registry')
  return (id: string, title: string) => {
    const key = `knowledge_names.${packSlug(id)}`
    return t.has(key) ? t(key) : title
  }
}

/** A pack's one-line description for people; the registry's own is written for agent routing. */
export function useKnowledgeDesc() {
  const t = useTranslations('skills_registry')
  return (id: string, fallback: string) => {
    const key = `knowledge_descs.${packSlug(id)}`
    return t.has(key) ? t(key) : fallback
  }
}

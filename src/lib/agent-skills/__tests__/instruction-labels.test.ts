import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { analysisSkills } from '../analyses'

/**
 * The Instruktioner page names Accounted's analyses and knowledge packs from
 * messages, so the English UI never shows a Swedish title (Catalog.tsx,
 * ItemDetail.tsx via components/skills/knowledge-labels.ts).
 */
describe('Instruktioner labels', () => {
  it('gives every Accounted analysis a name and summary in both languages, the Swedish ones equal to what the AI is served', () => {
    for (const skill of analysisSkills) {
      const svLabel = (sv.skills_registry.analyses as Record<string, { name: string; summary: string }>)[skill.slug]
      const enLabel = (en.skills_registry.analyses as Record<string, { name: string; summary: string }>)[skill.slug]
      expect(svLabel).toEqual({ name: skill.name, summary: skill.summary })
      expect(enLabel.name).toBeTruthy()
      expect(enLabel.summary).toBeTruthy()
    }
  })

  it('names every pack it describes, in both languages, so a title never falls back to the Swedish registry title', () => {
    for (const messages of [sv, en]) {
      const names = Object.keys(messages.skills_registry.knowledge_names).sort()
      expect(names).toEqual(Object.keys(messages.skills_registry.knowledge_descs).sort())
    }
  })

  it('names every general rule area the repository ships, so none shows under its registry title', () => {
    // The general items are the swedish-* skills (.claude/skills): each needs a name and a line here.
    const shipped = readdirSync(join(__dirname, '..', '..', '..', '..', '.claude', 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('swedish-'))
      .map((entry) => entry.name)
    expect(shipped.length).toBeGreaterThan(10)
    for (const messages of [sv, en]) {
      const names = messages.skills_registry.knowledge_names as Record<string, string>
      expect(shipped.filter((slug) => !names[slug])).toEqual([])
    }
  })

  it('names an industry pack the same as its category, so one industry has one name', () => {
    for (const messages of [sv, en]) {
      const names = messages.skills_registry.knowledge_names as Record<string, string>
      const categories = messages.skills_registry.category_names as Record<string, string>
      for (const [slug, category] of Object.entries(categories)) {
        if (slug in names) expect(names[slug]).toBe(category)
      }
    }
  })
})

import type { RegistrySkillId } from '@/lib/agent-skills/registry'

/**
 * What an agent instruction is. A flow is a task the AI carries out (steps, a
 * result to approve); knowledge is what is true (law, industry, the company)
 * and never runs on its own, it is given to flows; an analysis is a figure or
 * report and how to read it.
 */
export type ItemKind = 'workflow' | 'rules' | 'analysis'

/** How an agent is doing right now: ready, has work waiting, blocked on a connection, or waiting for the user's AI. */
export type Presence = 'ready' | 'busy' | 'blocked' | 'idle'

/** A stable number from a string, so every item keeps its colour and grain every visit. */
export function seedOf(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  return (h >>> 0) % 10000
}

/** Each curated workflow's own hue: its folder and its stage share it, so the page reads as one colour. */
const WORKFLOW_HUES: Record<RegistrySkillId, number> = {
  bookkeep: 210,
  kvittojakten: 24,
  'reconcile-month': 4,
  'month-end-close': 196,
  'quarterly-vat-review': 278,
  'payroll-monthly': 142,
  'invoicing-rules': 250,
  'kreditfaktura-process': 174,
  'year-end-close': 44,
  'tax-planning': 330,
}

/** Knowledge and analyses stay near their type's colour, a little apart from each other. */
const KIND_HUES: Record<Exclude<ItemKind, 'workflow'>, number> = { rules: 34, analysis: 152 }

export function itemHue(kind: ItemKind, key: string, curated?: RegistrySkillId | null): number {
  if (kind === 'workflow') return curated ? WORKFLOW_HUES[curated] : seedOf(key) % 360
  return (KIND_HUES[kind] + ((seedOf(key) % 5) - 2) * 5 + 360) % 360
}

/** The catalogue with a kind and (optionally) a category chosen: where an item's back link returns to. */
export function catalogHref(base: string, kind: ItemKind, category?: string | null): string {
  const sp = new URLSearchParams()
  if (kind === 'rules') sp.set('typ', 'kunskap')
  if (kind === 'analysis') sp.set('typ', 'analyser')
  if (category) sp.set('kategori', category.replace('/', '.'))
  return sp.size ? `${base}?${sp}` : base
}

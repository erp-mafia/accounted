import yaml from 'js-yaml'
import { z } from 'zod'
import type { CommunityKind } from './community'
import { SkillBodySchema } from './validation'

/**
 * Community instructions live in the public, MIT-licensed repository
 * erp-mafia/accounted-skills, one folder per item under community/ with a
 * SKILL.md (format: community/README.md there). Accounted reviews every
 * pull request; a merge publishes, and an hourly sync (community-sync.ts)
 * brings merged items into every company's catalogue. This module is the
 * format both ways: an own item written out for review, and a file read back.
 */
export const COMMUNITY_REPO = 'erp-mafia/accounted-skills'
export const COMMUNITY_DIR = 'community'

/** The repository says "knowledge"; the app calls the same kind "rules". */
const REPO_KIND: Record<CommunityKind, string> = { workflow: 'workflow', rules: 'knowledge', analysis: 'analysis' }
const ITEM_KIND: Record<string, CommunityKind> = { workflow: 'workflow', knowledge: 'rules', analysis: 'analysis' }

/** Industries a community item may name; the catalogue shows it under vertical/<id>. */
export const COMMUNITY_INDUSTRIES = ['konsult-it', 'bygg-hantverk', 'e-handel', 'restaurang-cafe', 'vard-halsa', 'software-saas-ai', 'reklambyra-marknadsforing'] as const

/**
 * Accounted's own knowledge packs are named swedish-* (.claude/skills in the
 * same repository), and accounted.se serves both at /instruktioner/<name>.
 * A community folder may not take such a name, or it would take over the
 * pack's page there.
 */
const RESERVED_PREFIX = 'swedish-'

export function isReservedCommunitySlug(slug: string): boolean {
  return slug.startsWith(RESERVED_PREFIX)
}

/** A folder name from a title: lowercase ascii, digits and hyphens, never one of Accounted's own pack names. */
export function communitySlug(title: string): string {
  const slug = title.toLowerCase()
    .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/é/g, 'e')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '') || 'instruktion'
  return isReservedCommunitySlug(slug) ? `community-${slug}`.slice(0, 60).replace(/-+$/, '') : slug
}

/**
 * What an own item's body keeps when it goes public: everything but the
 * user's own words from the AI conversation ("Så beskrev användaren det"),
 * which were written for the company, not for others.
 */
export function publicBody(body: string): string {
  return body.replace(/\n## (Så beskrev användaren det|How the user described it)\n[\s\S]*?(?=\n## |\s*$)/, '').trim() + '\n'
}

export interface CommunitySubmission {
  slug: string
  title: string
  description: string
  kind: CommunityKind
  author: string
  body: string
  submissionId: string
}

/** The SKILL.md a reviewer opens as a pull request for a submission. */
export function toCommunitySkillMd(s: CommunitySubmission): string {
  const frontmatter = yaml.dump({
    name: s.slug,
    description: s.description,
    title: s.title,
    kind: REPO_KIND[s.kind],
    author: s.author,
    industries: [],
    language: 'sv',
    submission: s.submissionId,
  }, { lineWidth: -1 })
  return `---\n${frontmatter}---\n\n${publicBody(s.body)}`
}

const FrontmatterSchema = z.object({
  name: z.string(),
  description: z.string().min(1).max(1024),
  title: z.string().min(1).max(120).optional(),
  kind: z.enum(['workflow', 'knowledge', 'analysis']),
  author: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
  industries: z.array(z.enum(COMMUNITY_INDUSTRIES)).default([]),
  language: z.enum(['sv', 'en']).default('sv'),
  submission: z.uuid().optional(),
}).loose()

export interface ParsedCommunitySkill {
  slug: string
  title: string
  description: string
  kind: CommunityKind
  author: string
  industries: string[]
  submissionId: string | null
  /** The whole file, frontmatter included: what the AI reads, as for Accounted's own skills. */
  body: string
}

/** Reads one community/<slug>/SKILL.md; an error names what to fix. */
export function parseCommunitySkillMd(slug: string, text: string): ParsedCommunitySkill | { error: string } {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) return { error: 'folder name: lowercase letters, digits and hyphens' }
  if (isReservedCommunitySlug(slug)) return { error: 'folder name: swedish-* is reserved for Accounted\'s own knowledge' }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return { error: 'missing frontmatter' }
  let raw: unknown
  try { raw = yaml.load(match[1]) } catch { return { error: 'frontmatter is not valid YAML' } }
  const parsed = FrontmatterSchema.safeParse(raw)
  if (!parsed.success) return { error: `frontmatter: ${parsed.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}` }
  const fm = parsed.data
  if (fm.name !== slug) return { error: 'name must match the folder name' }
  const body = SkillBodySchema.safeParse(text)
  if (!body.success) return { error: `body: ${body.error.issues.map((i) => i.message).join(' ')}` }
  const heading = /^#\s+(.+)$/m.exec(match[2])?.[1]?.trim()
  return {
    slug,
    title: (fm.title ?? heading ?? slug).slice(0, 120),
    description: fm.description.slice(0, 500),
    kind: ITEM_KIND[fm.kind],
    author: fm.author.toLowerCase(),
    industries: fm.industries,
    submissionId: fm.submission ?? null,
    body: body.data,
  }
}

export type PrivacyFinding = { kind: 'personnummer' | 'orgnummer' | 'bank' | 'email' | 'phone'; sample: string }

/**
 * A first screen for what must never be published: identity numbers,
 * account numbers, e-mail addresses and phone numbers. It flags for the
 * reviewer, who decides; it does not replace reading the text.
 */
export function privacyFindings(text: string): PrivacyFinding[] {
  const found: PrivacyFinding[] = []
  const add = (kind: PrivacyFinding['kind'], re: RegExp) => {
    for (const m of text.matchAll(re)) found.push({ kind, sample: m[0] })
  }
  add('personnummer', /\b(19|20)?\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[-+]?\d{4}\b/g)
  add('orgnummer', /\b[1-9]\d{5}-\d{4}\b/g)
  add('bank', /\bSE\d{2}(?:\s?\d{4}){5}\b|\b\d{3,4}-\d{4}\b(?=[^\d]*(bankgiro|bg))/gi)
  add('email', /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g)
  add('phone', /(?:\+46|\b0)7\d[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/g)
  // One entry per distinct hit, orgnummer and personnummer overlap on the same digits.
  return found.filter((f, i) => found.findIndex((g) => g.sample === f.sample) === i)
}

/** GitHub keeps a prefilled new-file URL working up to roughly this length. */
const MAX_URL = 7500

/**
 * Opens GitHub's editor with the file filled in, as the reviewer: GitHub
 * then offers to commit it to a new branch and open a pull request. Null
 * when the file is too long for a URL; the reviewer copies it instead.
 */
export function githubNewFileUrl(slug: string, content: string): string | null {
  const url = `https://github.com/${COMMUNITY_REPO}/new/main?filename=${encodeURIComponent(`${COMMUNITY_DIR}/${slug}/SKILL.md`)}&value=${encodeURIComponent(content)}`
  return url.length <= MAX_URL ? url : null
}

/** Where a published item lives in the repository. */
export function communityRepoUrl(slug: string): string {
  return `https://github.com/${COMMUNITY_REPO}/tree/main/${COMMUNITY_DIR}/${slug}`
}

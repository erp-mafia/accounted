import { createHash } from 'node:crypto'
import type { Skill } from '@/lib/agent-skills/types'
import { toSummary } from '@/lib/agent-skills/atoms'
import { stripFrontMatter } from '@/lib/agent-skills/front-matter'

/**
 * MCP Skills extension (io.modelcontextprotocol/skills, revision 2026-07-28).
 *
 * The same catalog resources/list and gnubok_load_skill serve (workflow skills
 * plus the top-level registry atoms), published the way a host loads a skill
 * natively: skills/list and skills/get return one entry per skill, and
 * resources/read serves its SKILL.md at skill://<slug>/SKILL.md.
 *
 * Each skill is one file. Atom references stay reachable through
 * gnubok_load_skill, as the atom bodies already say; they are not published
 * as supporting files, because a file inside a skill's directory would have
 * to be listed in that skill's manifest and approved with it.
 *
 * The SKILL.md is built here, not served as stored: the stored front matter
 * is replaced by one carrying exactly `name` and `description`, so the entry's
 * `frontmatter` and the file's front matter are the same object by
 * construction (hosts compare them field by field and refuse a mismatch).
 * Tool names in the text are projected per connection namespace, so the
 * digest and size are computed from the bytes this connection is served.
 */

export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills'

const SKILL_SCHEME = 'skill://'
const SKILL_FILE_SUFFIX = '/SKILL.md'

/** Agent Skills `name`: lowercase letters and digits in hyphen-separated runs, at most 64 characters. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKILL_NAME_MAX = 64
/** Agent Skills `description`: at most 1024 characters. */
const SKILL_DESCRIPTION_MAX = 1024

/** A skill as this connection is served it: the SKILL.md bytes and their digest. */
export interface McpSkillFile {
  slug: string
  /** skill://<slug>/SKILL.md */
  uri: string
  name: string
  description: string
  /** The whole SKILL.md: front matter, then the body. */
  text: string
  /** sha256:<64 lowercase hex> of the UTF-8 bytes of `text`. */
  digest: string
  /** Byte length of `text` in UTF-8. */
  size: number
}

export function skillFileUri(slug: string): string {
  return `${SKILL_SCHEME}${slug}${SKILL_FILE_SUFFIX}`
}

/** The slug a skill://<slug>/SKILL.md URI names, or null for any other URI. */
export function slugFromSkillFileUri(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri.startsWith(SKILL_SCHEME) || !uri.endsWith(SKILL_FILE_SUFFIX)) return null
  const slug = uri.slice(SKILL_SCHEME.length, -SKILL_FILE_SUFFIX.length)
  return slug || null
}

/**
 * The skill's name is the last segment of its slug ("vertical/konsult-it" is
 * named "konsult-it"), as the extension requires of the skill path. A slug
 * whose segments are not all valid skill names is not served: an own item
 * ("own/<id>") is per company and never reaches this catalog, and a registry
 * id with another shape would fail the host's checks.
 */
function servedName(slug: string): string | null {
  const segments = slug.split('/')
  const valid = segments.every((segment) => segment.length <= SKILL_NAME_MAX && SKILL_NAME.test(segment))
  return valid && segments[0] !== 'own' ? segments[segments.length - 1] : null
}

/** Projected before the cap: an accounted_ name is longer than its gnubok_ id. */
function servedDescription(skill: Skill, project: (text: string) => string): string {
  const text = project((skill.description ?? skill.summary ?? '').replace(/\s+/g, ' ').trim())
  return text.length <= SKILL_DESCRIPTION_MAX ? text : toSummary(text, SKILL_DESCRIPTION_MAX)
}

/**
 * Build the SKILL.md this connection is served for a skill, or null when the
 * skill cannot be served under the extension. `project` maps canonical tool
 * names to the connection's namespace (projectToolReferencesInText).
 */
export function buildSkillFile(skill: Skill, project: (text: string) => string): McpSkillFile | null {
  const name = servedName(skill.slug)
  if (!name) return null
  const description = servedDescription(skill, project)
  if (!description) return null
  // JSON string syntax is valid YAML double-quoted scalar syntax, so the
  // description round-trips exactly whatever characters it holds.
  const text = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${project(stripFrontMatter(skill.body))}`
  const bytes = Buffer.from(text, 'utf8')
  return {
    slug: skill.slug,
    uri: skillFileUri(skill.slug),
    name,
    description,
    text,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size: bytes.length,
  }
}

/** Every servable skill of a catalog, in catalog order. */
export function buildSkillFiles(skills: Skill[], project: (text: string) => string): McpSkillFile[] {
  return skills.flatMap((skill) => {
    const file = buildSkillFile(skill, project)
    return file ? [file] : []
  })
}

/** The Skill entry of skills/list and skills/get: front matter and the complete file manifest. */
export function skillEntry(file: McpSkillFile): Record<string, unknown> {
  return {
    uri: file.uri,
    frontmatter: { name: file.name, description: file.description },
    resources: [{ uri: file.uri, digest: file.digest, size: file.size }],
  }
}

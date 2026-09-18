import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'
import { SkillBodySchema } from '../../lib/agent-skills/validation'
import type { DiscoveredAtom } from './atom-discovery'

/** Reviewed registry entries and private submissions ultimately use this path. */
export async function discoverCommunitySkills(root: string): Promise<DiscoveredAtom[]> {
  const directory = join(root, 'registry/entries')
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
  const atoms: DiscoveredAtom[] = []
  for (const file of files.sort()) {
    if (!/^[a-z0-9][a-z0-9-]*\.mdx?$/.test(file)) continue
    const text = await readFile(join(directory, file), 'utf8')
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!frontmatter) throw new Error(`Invalid registry frontmatter: ${file}`)
    const entry = yaml.load(frontmatter[1]) as Record<string, unknown>
    const slug = file.replace(/\.mdx?$/, '')
    const bodyPath = `registry/skills/${slug}/SKILL.md`
    const exists = await stat(join(root, bodyPath)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (!exists) {
      if (entry.mcp_exposed === true) throw new Error(`Missing skill body: ${bodyPath}`)
      continue
    }
    if (entry.kind !== 'skill' || entry.slug !== slug) throw new Error(`Invalid community skill entry: ${file}`)
    if (entry.mcp_exposed !== undefined && typeof entry.mcp_exposed !== 'boolean') throw new Error(`mcp_exposed must be boolean: ${file}`)
    const reviewedAt = entry.reviewedAt === undefined ? null : z.iso.date().parse(entry.reviewedAt)
    if (entry.mcp_exposed && !reviewedAt) throw new Error(`MCP publication requires reviewedAt: ${file}`)
    const body = SkillBodySchema.parse(await readFile(join(root, bodyPath), 'utf8'))
    atoms.push({ id: `community/${slug}`, tier: 'community', slug,
      title: z.string().min(1).max(120).parse(entry.title), description: z.string().min(1).max(500).parse(entry.description),
      body, body_path: bodyPath, parent_atom_id: null, estimated_tokens: Math.ceil(body.length / 4),
      sni_prefixes: [], trigger_signals: {}, frontmatter_version: 1, schema_version: 1,
      mcp_exposed: entry.mcp_exposed === true && entry.status === 'live', reviewed_at: reviewedAt,
    })
  }
  return atoms
}

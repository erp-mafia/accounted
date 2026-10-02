/** Internal demo of one instruction's page with example data. Auth-free (/sandbox). */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { SandboxItem } from './item'

// A knowledge pack's page shows the pack's real text, read from the repo's skill files
// (in the app it comes from agent_atom_registry, which is generated from the same files).
const PACK_DIRS: Record<string, string> = { horizontal: '', vertical: 'industry', modifier: 'modifier' }

async function packBody(segment: string): Promise<string | null> {
  const match = /^kunskap\.(horizontal|vertical|modifier)\.([a-z0-9-]+)$/.exec(segment)
  if (!match) return null
  const [, tier, slug] = match
  try {
    const file = await readFile(path.join(process.cwd(), '.claude', 'skills', PACK_DIRS[tier], slug, 'SKILL.md'), 'utf8')
    return file.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  } catch {
    return null
  }
}

export default async function AgentSandboxPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const segment = decodeURIComponent(id)
  const body = await packBody(segment)
  return <SandboxItem segment={segment} packBody={body ? { id: segment.slice('kunskap.'.length).replace('.', '/'), body } : null} />
}

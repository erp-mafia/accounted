import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { workflowSkills } from '../skills'
import { dataResources } from '../resources'
import { toCanonicalToolName } from '../tool-namespace'
import { discoverAtoms } from '@/scripts/lib/atom-discovery'

/**
 * The Claude Code plugin (claude-plugin/) ships thin wrapper skills whose value
 * is that every slug, resource URI, and tool name they mention resolves against
 * this MCP server. A rename on the server side must fail here, not in a user's
 * chat session.
 */

const repoRoot = join(__dirname, '..', '..', '..', '..')
const skillsDir = join(repoRoot, 'claude-plugin', 'skills')
const commandsDir = join(repoRoot, 'claude-plugin', 'commands')

function readPluginSkills(): { file: string; body: string }[] {
  return readdirSync(skillsDir).map((dir) => {
    const file = join(skillsDir, dir, 'SKILL.md')
    return { file: `${dir}/SKILL.md`, body: readFileSync(file, 'utf8') }
  })
}

// Slash commands (commands/*.md) reference the same server surface as the
// skills and get the same guard; /accounted:setup is the install-time entry
// (issue #1814) that hands off to the onboarding skill.
function readPluginCommands(): { file: string; body: string }[] {
  return readdirSync(commandsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: `commands/${f}`, body: readFileSync(join(commandsDir, f), 'utf8') }))
}

const pluginSkills = [...readPluginSkills(), ...readPluginCommands()]
const serverSource = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8')

describe('claude-plugin wrapper references', () => {
  it('ships the seven v1 skills and the setup command', () => {
    expect(pluginSkills.map((s) => s.file).sort()).toEqual([
      'bookkeep/SKILL.md',
      'check/SKILL.md',
      'commands/setup.md',
      'month-close/SKILL.md',
      'payroll/SKILL.md',
      'start/SKILL.md',
      'vat/SKILL.md',
      'year-end/SKILL.md',
    ])
  })

  it('every accounted_load_skill slug resolves to a workflow skill or a registry atom', async () => {
    const workflowSlugs = new Set(workflowSkills.map((s) => s.slug))
    const atomIds = new Set((await discoverAtoms(repoRoot)).map((a) => a.id))
    for (const { file, body } of pluginSkills) {
      for (const [, slug] of body.matchAll(/accounted_load_skill\("([^"]+)"\)/g)) {
        const known = workflowSlugs.has(slug) || atomIds.has(slug)
        expect(known, `${file} references unknown skill slug "${slug}"`).toBe(true)
      }
    }
  })

  it('every Accounted:// resource URI exists on the server', () => {
    const uris = new Set(dataResources.map((r) => r.uri))
    for (const { file, body } of pluginSkills) {
      for (const [uri] of body.matchAll(/Accounted:\/\/[a-z/-]+/g)) {
        expect(uris.has(uri), `${file} references unknown resource "${uri}"`).toBe(true)
      }
    }
  })

  it('every accounted_* tool name resolves to a canonical server tool', () => {
    for (const { file, body } of pluginSkills) {
      for (const [tool] of body.matchAll(/accounted_[a-z_]+/g)) {
        const canonicalTool = toCanonicalToolName(tool)
        expect(
          serverSource.includes(`name: '${canonicalTool}'`),
          `${file} references unknown tool "${tool}"`,
        ).toBe(true)
      }
    }
  })
})

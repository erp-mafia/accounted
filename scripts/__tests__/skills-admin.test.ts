import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }))
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), unlink: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
import { createClient } from '@supabase/supabase-js'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { runSkillsAdmin } from '../skills-admin'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const body = 'Explain the evidence. Stage changes for approval.'
const bodyHash = createHash('sha256').update(body).digest('hex')
const submission = { id, body, submission_body_hash: bodyHash, name: 'Review workflow', description: 'Explain scoped proposals.', author_handle: 'public-author', share_confirmed_at: '2026-09-17', share_status: 'submitted', company_id: 'PRIVATE-COMPANY', created_by: 'PRIVATE-USER', published_atom_id: null }
const entry = { author: submission.author_handle, submissionHash: bodyHash, title: submission.name, description: submission.description, mcp_exposed: true, reviewedAt: '2026-09-17' }
const env = { SKILLS_SUPABASE_URL: 'https://metjnjrhvujscngnpzdv.supabase.co', SKILLS_SERVICE_ROLE_KEY: 'test-only' }
const run = (args: string[]) => runSkillsAdmin([...args, '--project', 'metjnjrhvujscngnpzdv'], env, '/fixture')
const markdown = (data: object) => `---\n${yaml.dump(data)}---\n\nPublic summary.\n`

beforeEach(() => {
  vi.clearAllMocks(); reset()
  vi.mocked(createClient).mockReturnValue(supabase as never)
  vi.mocked(writeFile).mockResolvedValue(undefined)
  vi.mocked(unlink).mockResolvedValue(undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('local human-gated skill review', () => {
  it('requires explicit matching credentials and specific production write approval', async () => {
    await expect(runSkillsAdmin(['list', '--project', 'different'], env)).rejects.toThrow('matching project')
    await expect(runSkillsAdmin(['disable', '--project', 'pwxtzglxptnnvjrpixpg', '--slug', 'community/test'], { ...env, SKILLS_SUPABASE_URL: 'https://pwxtzglxptnnvjrpixpg.supabase.co' })).rejects.toThrow('production write approval')
    expect(supabase.from).not.toHaveBeenCalled()
  })
  it('exports only reviewed public fields, never tenant or user identifiers', async () => {
    enqueue({ data: submission })
    await run(['prepare', '--id', id, '--slug', 'review-workflow', '--reviewed-at', '2026-09-17', '--review-confirmed'])
    const writes = vi.mocked(writeFile).mock.calls
    expect(writes).toHaveLength(3)
    const content = writes.map((call) => String(call[1])).join('\n')
    expect(content).toContain('public-author')
    expect(content).toContain(bodyHash)
    expect(content).not.toContain('PRIVATE-')
    expect(content).not.toContain(id)
    expect(writes.every((call) => (call[2] as { flag: string }).flag === 'wx')).toBe(true)
    expect(findCall('company_skills', 'update')).toBeUndefined()
    expect(execFileSync).not.toHaveBeenCalled()
  })
  it('rejects changed submitted text before any public file is written', async () => {
    enqueue({ data: { ...submission, body: 'Changed after consent' } })
    await expect(run(['prepare', '--id', id, '--slug', 'review-workflow', '--reviewed-at', '2026-09-17', '--review-confirmed'])).rejects.toThrow('frozen submission')
    expect(writeFile).not.toHaveBeenCalled()
  })
  it('kills a deployed submission even before publication status was recorded', async () => {
    enqueue({ data: { ...submission, share_status: 'withdrawn' } }); enqueue({ data: null })
    vi.mocked(readFile).mockResolvedValue(markdown(entry))
    await run(['withdraw', '--id', id, '--slug', 'review-workflow'])
    expect(findCall('agent_atom_registry', 'update')?.[0]).toEqual({ is_active: false, mcp_exposed: false })
    expect(findCalls('agent_atom_registry', 'eq')).toContainEqual(['id', 'community/review-workflow'])
    expect(unlink).toHaveBeenCalledTimes(2)
  })
  it('refuses to disable or remove somebody else\'s entry', async () => {
    enqueue({ data: { ...submission, share_status: 'withdrawn' } })
    vi.mocked(readFile).mockResolvedValue(markdown({ ...entry, author: 'somebody-else' }))
    await expect(run(['withdraw', '--id', id, '--slug', 'wrong-slug'])).rejects.toThrow('not this submission')
    expect(findCall('agent_atom_registry', 'update')).toBeUndefined()
    expect(unlink).not.toHaveBeenCalled()
  })
  it('does not report an open PR as published', async () => {
    enqueue({ data: submission })
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ state: 'OPEN', mergeCommit: null, files: [] }))
    await expect(run(['published', '--id', id, '--slug', 'review-workflow', '--pr', '123'])).rejects.toThrow('not merged')
    expect(findCall('company_skills', 'update')).toBeUndefined()
  })
  it('requires merged attribution and deployed body before marking published', async () => {
    enqueue({ data: submission }); enqueue({ data: { body, reviewed_at: '2026-09-17T00:00:00+00:00' } }); enqueue({ data: { id } })
    vi.mocked(execFileSync)
      .mockReturnValueOnce(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'commit' }, files: [{ path: 'registry/skills/review-workflow/SKILL.md' }, { path: 'registry/entries/review-workflow.mdx' }] }))
      .mockReturnValueOnce(JSON.stringify({ content: Buffer.from(body).toString('base64') }))
      .mockReturnValueOnce(JSON.stringify({ content: Buffer.from(markdown(entry)).toString('base64') }))
    await run(['published', '--id', id, '--slug', 'review-workflow', '--pr', '123'])
    expect(findCall('company_skills', 'update')?.[0]).toMatchObject({ share_status: 'published', published_atom_id: 'community/review-workflow', reviewed_at: '2026-09-17T00:00:00+00:00' })
    expect(findCalls('company_skills', 'eq')).toContainEqual(['submission_body_hash', bodyHash])
    expect(findCalls('company_skills', 'eq')).toContainEqual(['share_status', 'submitted'])
  })
})

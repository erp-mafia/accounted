#!/usr/bin/env npx tsx
/** Local reviewer CLI. Never loads .env.local or accepts a GitHub token. */
import { createClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import yaml from 'js-yaml'
import { z } from 'zod'
import { SkillBodySchema } from '../lib/agent-skills/validation'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'erp-mafia/accounted'
const hash = (body: string) => createHash('sha256').update(body).digest('hex')
const gh = (parameters: string[]) => execFileSync('gh', parameters, { encoding: 'utf8', maxBuffer: 1024 * 1024 })

export async function runSkillsAdmin(args: string[], env: Record<string, string | undefined> = process.env, root = ROOT) {
  function option(name: string): string {
    const index = args.indexOf(`--${name}`)
    const value = index >= 0 ? args[index + 1] : undefined
    if (!value || value.startsWith('--')) throw new Error(`Missing --${name}`)
    return value
  }
  const command = args[0]
  if (!command || command === '--help') {
    console.log('Commands: list; show --id; prepare --id --slug --reviewed-at --review-confirmed; record-pr --id --pr; published --id --slug --pr; withdraw --id --slug; disable|enable --slug; reviewed --slug --date --review-confirmed. All commands require --project <Supabase ref>. Mutations against production also require --production-write-approved. Credentials: SKILLS_SUPABASE_URL and SKILLS_SERVICE_ROLE_KEY, explicitly supplied by the reviewer. No .env files are loaded.')
    return
  }
  if (!['list', 'show', 'prepare', 'record-pr', 'published', 'withdraw', 'disable', 'enable', 'reviewed'].includes(command)) throw new Error('Unknown command')
  const url = env.SKILLS_SUPABASE_URL
  const key = env.SKILLS_SERVICE_ROLE_KEY
  const project = option('project')
  if (!url || !key || new URL(url).hostname !== `${project}.supabase.co`) throw new Error('Explicit matching project URL and reviewer credentials required')
  if (!['list', 'show', 'prepare'].includes(command) && project === 'pwxtzglxptnnvjrpixpg' && !args.includes('--production-write-approved')) throw new Error('Specific production write approval required')
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  if (command === 'list') {
    const { data, error } = await db.from('company_skills').select('id, name, share_status, author_handle, submission_body_hash, published_atom_id, review_url, updated_at').in('share_status', ['submitted', 'withdrawn']).order('updated_at').limit(100)
    if (error) throw error
    console.log(JSON.stringify(data, null, 2))
    return
  }
  if (['disable', 'enable', 'reviewed'].includes(command)) {
    const slug = z.string().regex(/^(horizontal|vertical|modifier|community)\/[a-z0-9/-]+$/).parse(option('slug'))
    if (command === 'reviewed' && !args.includes('--review-confirmed')) throw new Error('Review confirmation required')
    if (command === 'reviewed' && slug.startsWith('community/')) throw new Error('Community review dates describe publication, not ongoing Accounted review')
    const update = command === 'reviewed'
      ? db.from('agent_atom_registry').update({ reviewed_at: z.iso.date().parse(option('date')) })
      : db.from('agent_atom_registry').update({ is_active: command === 'enable' })
    const { data, error } = await update.eq('id', slug).select('id').single()
    if (error) throw error
    console.log(`${command}: ${data.id}`)
    return
  }
  const id = z.string().uuid().parse(option('id'))
  const { data: row, error } = await db.from('company_skills').select('*').eq('id', id).is('atom_id', null).single()
  if (error) throw error
  if (command === 'show') { console.log(JSON.stringify(row, null, 2)); return }
  if (!['submitted', 'withdrawn'].includes(row.share_status)) throw new Error('Submission is no longer pending review or withdrawal')
  if (command === 'record-pr') {
    const number = z.coerce.number().int().positive().parse(option('pr'))
    gh(['pr', 'view', String(number), '--repo', REPO, '--json', 'number'])
    const { error: updateError } = await db.from('company_skills').update({ review_url: `https://github.com/${REPO}/pull/${number}` })
      .eq('id', id).eq('share_status', row.share_status).eq('submission_body_hash', row.submission_body_hash).select('id').single()
    if (updateError) throw updateError
    return
  }
  const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/).parse(option('slug'))
  const atomId = `community/${slug}`
  const bodyPath = `registry/skills/${slug}/SKILL.md`
  const entryPath = `registry/entries/${slug}.mdx`
  if (command === 'withdraw') {
    if (row.share_status !== 'withdrawn') throw new Error('Author has not withdrawn this submission')
    if (row.published_atom_id && row.published_atom_id !== atomId) throw new Error('Published slug mismatch')
    const entryText = await readFile(join(root, entryPath), 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e })
    if (entryText) {
      const entry = yaml.load(/^---\n([\s\S]*?)\n---/.exec(entryText)?.[1] ?? '') as Record<string, unknown>
      if (entry.author !== row.author_handle || entry.submissionHash !== row.submission_body_hash) throw new Error('Entry is not this submission; refuse removal')
    }
    // Publication can deploy before the reviewer records published_atom_id.
    // Either durable publication evidence or the matching entry identifies it.
    if (row.published_atom_id || entryText) {
      const { error: disableError } = await db.from('agent_atom_registry').update({ is_active: false, mcp_exposed: false }).eq('id', atomId)
      if (disableError) throw disableError
    }
    if (entryText) {
      await unlink(join(root, entryPath))
      await unlink(join(root, bodyPath))
      console.log('Removed the local entry and skill body; recoverable in git. Run skills:generate and propose the withdrawal PR. The registry kill switch is already off.')
    }
    return
  }
  if (row.share_status !== 'submitted' || !row.share_confirmed_at || !row.author_handle || hash(row.body) !== row.submission_body_hash) throw new Error('Consent or frozen submission evidence is missing')
  const body = SkillBodySchema.parse(row.body)
  if (command === 'prepare') {
    if (!args.includes('--review-confirmed')) throw new Error('Human privacy and accounting review confirmation required')
    const date = z.iso.date().parse(option('reviewed-at'))
    const entry = {
      title: row.name, description: row.description, slug, kind: 'skill', author: row.author_handle,
      status: 'live', lang: 'sv', personas: ['finance', 'byra'], publishedAt: date, updatedAt: date,
      reviewedAt: date, mcp_exposed: true, submissionHash: row.submission_body_hash,
      repoUrl: `https://github.com/${REPO}/tree/main/registry/skills/${slug}`,
    }
    // No tenant/user identifiers or private metadata leave the database.
    await mkdir(join(root, dirname(bodyPath)), { recursive: true })
    await writeFile(join(root, bodyPath), body, { flag: 'wx' })
    await writeFile(join(root, entryPath), `---\n${yaml.dump(entry)}---\n\n${row.description}\n`, { flag: 'wx' })
    const authorPath = join(root, 'registry/authors', `${row.author_handle}.mdx`)
    try { await writeFile(authorPath, `---\n${yaml.dump({ handle: row.author_handle, name: row.author_handle, kind: 'community' })}---\n\nCommunity contributor.\n`, { flag: 'wx' }) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
    console.log(`Prepared ${entryPath} and ${bodyPath}. Run validate:registry, skills:generate and the compliance review before opening a PR. No PR was opened.`)
    return
  }
  const number = z.coerce.number().int().positive().parse(option('pr'))
  const pr = JSON.parse(gh(['pr', 'view', String(number), '--repo', REPO, '--json', 'state,mergeCommit,files'])) as { state: string; mergeCommit: { oid: string } | null; files: { path: string }[] }
  if (pr.state !== 'MERGED' || !pr.mergeCommit?.oid || !pr.files.some((file) => file.path === bodyPath) || !pr.files.some((file) => file.path === entryPath)) throw new Error('The skill publication PR is not merged')
  const mergedContent = JSON.parse(gh(['api', `repos/${REPO}/contents/${bodyPath}?ref=${pr.mergeCommit.oid}`])) as { content: string }
  if (hash(Buffer.from(mergedContent.content, 'base64').toString()) !== hash(body)) throw new Error('Merged body differs from the frozen submission')
  const mergedEntry = JSON.parse(gh(['api', `repos/${REPO}/contents/${entryPath}?ref=${pr.mergeCommit.oid}`])) as { content: string }
  const entryText = Buffer.from(mergedEntry.content, 'base64').toString()
  const entry = yaml.load(/^---\n([\s\S]*?)\n---/.exec(entryText)?.[1] ?? '') as Record<string, unknown>
  if (entry.author !== row.author_handle || entry.submissionHash !== row.submission_body_hash || entry.title !== row.name || entry.description !== row.description || entry.mcp_exposed !== true) throw new Error('Merged registry attribution differs from the frozen submission')
  const { data: atom, error: atomError } = await db.from('agent_atom_registry').select('body, reviewed_at').eq('id', atomId).eq('is_active', true).eq('mcp_exposed', true).single()
  const reviewedDate = z.iso.date().parse(entry.reviewedAt)
  if (atomError || !atom.reviewed_at || Date.parse(atom.reviewed_at) !== Date.parse(reviewedDate) || hash(atom.body) !== hash(body)) throw new Error('Merged skill is not yet deployed in this registry')
  const { error: updateError } = await db.from('company_skills').update({ share_status: 'published', published_atom_id: atomId, reviewed_at: atom.reviewed_at, review_url: `https://github.com/${REPO}/pull/${number}` })
    .eq('id', id).eq('share_status', row.share_status).eq('submission_body_hash', row.submission_body_hash).select('id').single()
  if (updateError) throw updateError
  console.log('Publication verified and recorded.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runSkillsAdmin(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : 'Review failed'); process.exitCode = 1 })

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileResponse } from '@/lib/api/file-response'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { buildBolagetMarkdown } from '@/lib/formation/documents/bolaget-md'
import { formationRoute } from '@/lib/formation/route'
import { FormationStateError, getFormation, isReady, openAnswers, parseStoredAnswers } from '@/lib/formation/store'
import { writeZip } from '@/lib/reports/zip-writer'

/**
 * GET /api/formation/:id/skill: the start-company skill for the founder's
 * own AI assistant, as a folder in a zip: the skill itself
 * (skills/accounted-start-company/SKILL.md) and `bolaget.md` with this
 * formation's answers, personnummer masked. Claude and other assistants
 * install a skill from such a folder.
 */
const SKILL_DIR = 'accounted-start-company'

export const GET = formationRoute<{ params: Promise<{ id: string }> }>('formation.skill', async (_request, { user, service }, { params }) => {
  const { id } = await params
  const formation = await getFormation(service, user.id, id)
  if (!formation) throw new FormationStateError('FORMATION_NOT_FOUND')
  if (!isReady(formation)) throw new FormationStateError('FORMATION_INCOMPLETE')

  const skill = await readFile(path.join(process.cwd(), 'skills', SKILL_DIR, 'SKILL.md'))
  const answers = openAnswers(parseStoredAnswers(formation.answers))
  const bolaget = buildBolagetMarkdown(answers, { today: todayIsoStockholm(), deedDate: formation.deed_date, registration: null })
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  for await (const chunk of writeZip([
    { name: `${SKILL_DIR}/SKILL.md`, data: new Uint8Array(skill) },
    { name: `${SKILL_DIR}/bolaget.md`, data: enc.encode(bolaget) },
  ])) {
    parts.push(chunk)
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return fileResponse(out, { filename: `${SKILL_DIR}.zip`, contentType: 'application/zip', cacheControl: 'private, no-store' })
})

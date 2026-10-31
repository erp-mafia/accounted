/**
 * The built company as the tests see it: the ids the build left behind, the
 * plan and answer key its seed gives, and read access through the same tools a
 * customer's agent reads with. Fails with the fix when nothing has been built.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createToolPgClient } from '@/tests/tool-pg/client'
import { computeAnswerKey } from './answer-key'
import type { SimState } from './build'
import { SimDoors } from './doors'
import { generateCompany } from './generate'

export const SIM_STATE_FILE = path.join('.local', 'sim', 'state.json')

export function loadSimCompany() {
  if (!fs.existsSync(SIM_STATE_FILE)) {
    throw new Error(`no simulated company: run npm run tools:pg:reset, then npm run sim:build (${SIM_STATE_FILE} is missing)`)
  }
  const state = JSON.parse(fs.readFileSync(SIM_STATE_FILE, 'utf8')) as SimState
  const full = generateCompany(state.seed, state.scale)
  // A build told to stop early is judged on the events it played.
  const plan = { ...full, events: full.events.slice(0, state.events) }
  const key = computeAnswerKey(plan)
  const supabase = createToolPgClient()
  const doors = new SimDoors(supabase, state.companyId, state.userId)
  return { state, plan, key, supabase, doors }
}

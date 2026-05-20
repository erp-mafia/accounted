#!/usr/bin/env npx tsx
/**
 * Smoke test: confirm the MCP server extension registers its tools into the
 * core agentToolRegistry when ensureInitialized() runs. Run after any change
 * that touches the extension loader or the agent tool surface.
 *
 * Usage: npx tsx scripts/smoke-agent-tools.ts
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { ensureInitialized } from '../lib/init'
import { agentToolRegistry } from '../lib/agent/tools/registry'

ensureInitialized()

const all = agentToolRegistry.getAll()
console.log(`agentToolRegistry has ${all.length} tools.`)

// Spot-check the tools the V1 intents need.
const expected = [
  'gnubok_search_tools',
  'gnubok_list_skills',
  'gnubok_load_skill',
  'gnubok_categorize_transaction',
  'gnubok_get_counterparty_templates',
  'gnubok_match_transaction_to_invoice',
  'gnubok_get_document_content',
]

let missing = 0
for (const name of expected) {
  const found = agentToolRegistry.has(name)
  console.log(`  ${found ? '✓' : '✗'} ${name}`)
  if (!found) missing++
}

if (missing > 0) {
  console.error(`\n${missing} expected tool(s) missing.`)
  process.exit(1)
}

console.log('\nAll expected tools registered.')

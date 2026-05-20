#!/usr/bin/env npx tsx
/**
 * Smoke test: send a 1-token request to Bedrock with both the Opus and
 * Sonnet model ids the agent uses. Confirms AWS creds + region work and
 * the models are enabled on the account before we exercise the full chat
 * loop with real user data.
 *
 * Usage: npx tsx scripts/smoke-bedrock.ts
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { getAnthropic, OPUS_MODEL, SONNET_MODEL } from '../lib/agent/composer/client'

async function ping(model: string): Promise<void> {
  const client = getAnthropic()
  const start = Date.now()
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Säg "hej" på svenska.' }],
    })
    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')
    console.log(`  ✓ ${model} — ${Date.now() - start}ms — "${text.trim()}"`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`  ✗ ${model} — ${message}`)
    process.exitCode = 1
  }
}

async function main() {
  console.log(`Region: ${process.env.AWS_REGION || 'eu-north-1'}`)
  console.log('Pinging Bedrock for both agent models…\n')
  await ping(SONNET_MODEL)
  await ping(OPUS_MODEL)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

#!/usr/bin/env npx tsx
/**
 * Smoke test for the configured AI backend, against the real API.
 *
 * Unit tests cover which provider and model id get resolved from the
 * environment; they cannot tell you whether the resulting request is one the
 * backend accepts. This script sends real traffic over all three shapes the
 * app actually uses, so a credential or parameter problem surfaces here rather
 * than in front of a user:
 *
 *   1. A plain `messages.create` on both agent model ids.
 *   2. A streamed turn carrying adaptive thinking, an effort level, a cached
 *      system prompt and a tool: the exact parameter set the chat loop sends.
 *   3. Document extraction end to end, when given a file.
 *
 * Works against whichever backend lib/ai/provider.ts resolves (AWS Bedrock or
 * the direct Anthropic API), so it doubles as the acceptance check when
 * switching between them.
 *
 * Usage:
 *   npx tsx scripts/smoke-ai.ts
 *   npx tsx scripts/smoke-ai.ts ./some-receipt.pdf   # also runs step 3
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  aiCredentialPrefix,
  hasAiCredentials,
  resolveAiProvider,
} from '../lib/ai/provider'
import {
  getAnthropic,
  EFFORT_DEEP,
  MAX_TOKENS_DEEP,
  OPUS_MODEL,
  SONNET_MODEL,
} from '../lib/agent/composer/client'
import { extractInvoiceFields } from '../extensions/general/invoice-inbox/lib/extract-invoice-fields'

let failures = 0

function fail(step: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`  x ${step}: ${message}`)
  failures++
}

/** Step 1: the simplest possible request, once per agent model id. */
async function ping(model: string): Promise<void> {
  const start = Date.now()
  try {
    const resp = await getAnthropic().messages.create({
      model,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Säg "hej" på svenska.' }],
    })
    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')
    console.log(`  ok ${model}: ${Date.now() - start}ms: "${text.trim()}"`)
  } catch (err) {
    fail(model, err)
  }
}

/**
 * Step 2: the chat loop's parameter set.
 *
 * Adaptive thinking, effort, an hour-long cache breakpoint and a tool are
 * accepted differently across backends, and they are what a plain ping does
 * not exercise. The question is deliberately one that needs a tool call, so a
 * silently ignored `tools` array shows up as a missing tool_use block rather
 * than a plausible-looking answer.
 */
async function streamingTurn(): Promise<void> {
  const start = Date.now()
  try {
    const stream = getAnthropic().messages.stream({
      model: SONNET_MODEL,
      max_tokens: MAX_TOKENS_DEEP,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: EFFORT_DEEP },
      system: [
        {
          type: 'text',
          text: 'Du är en svensk redovisningsassistent. Använd verktyget när du behöver ett kontosaldo.',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      tools: [
        {
          name: 'get_account_balance',
          description: 'Hämtar saldot för ett BAS-konto i innevarande räkenskapsår.',
          input_schema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'BAS-kontonummer, till exempel 1930.' },
            },
            required: ['account'],
          },
        },
      ],
      messages: [{ role: 'user', content: 'Vad är saldot på konto 1930?' }],
    })

    let deltas = 0
    stream.on('text', () => {
      deltas++
    })
    const message = await stream.finalMessage()

    const thinking = message.content.filter((b) => b.type === 'thinking').length
    const toolUse = message.content.filter((b) => b.type === 'tool_use').length
    const cacheWrite = message.usage.cache_creation_input_tokens ?? 0
    const cacheRead = message.usage.cache_read_input_tokens ?? 0

    console.log(
      `  ok streaming: ${Date.now() - start}ms, stop=${message.stop_reason}, ` +
        `textdeltan=${deltas}, thinking-block=${thinking}, tool_use=${toolUse}, ` +
        `cache write/read=${cacheWrite}/${cacheRead}`
    )
    if (toolUse === 0) {
      console.warn('     varning: inget tool_use-block, verktyget kan ha ignorerats')
    }
  } catch (err) {
    fail('streaming', err)
  }
}

/** Step 3: the real extraction path, including prompt, media block and JSON parse. */
async function extraction(path: string): Promise<void> {
  const start = Date.now()
  const mimeByExt: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }
  const mimeType = mimeByExt[extname(path).toLowerCase()]
  if (!mimeType) {
    fail('extraction', `okänd filändelse för ${path}, stöds: ${Object.keys(mimeByExt).join(', ')}`)
    return
  }

  try {
    const buffer = await readFile(path)
    const { data, rawText } = await extractInvoiceFields({
      buffer,
      mimeType,
      fileName: basename(path),
    })
    // extractInvoiceFields never throws: a null rawText means the call was
    // skipped or the reply did not parse, which is exactly the silent failure
    // this script exists to make loud.
    if (!rawText) {
      fail('extraction', 'tomt resultat (nycklar saknas, filtyp stöds inte, eller JSON-parsen föll)')
      return
    }
    console.log(
      `  ok extraction: ${Date.now() - start}ms, leverantör="${data.supplier.name ?? '-'}", ` +
        `nummer=${data.invoice.invoiceNumber ?? '-'}, datum=${data.invoice.invoiceDate ?? '-'}, ` +
        `typ=${data.documentKind ?? '-'}`
    )
  } catch (err) {
    fail('extraction', err)
  }
}

async function main(): Promise<void> {
  const provider = resolveAiProvider()
  console.log(`Leverantör:   ${provider}`)
  console.log(`Nyckel:       ${hasAiCredentials() ? `${aiCredentialPrefix()}…` : 'SAKNAS'}`)
  if (provider === 'bedrock') console.log(`Region:       ${process.env.AWS_REGION || 'eu-north-1'}`)
  console.log(`Modeller:     ${SONNET_MODEL} / ${OPUS_MODEL}`)

  if (!hasAiCredentials()) {
    console.error(
      '\nInga synliga nycklar. Sätt ANTHROPIC_API_KEY, eller AWS_ACCESS_KEY_ID +\n' +
        'AWS_SECRET_ACCESS_KEY för Bedrock. (Bedrock via instansprofil/IRSA syns\n' +
        'inte härifrån: kör i så fall vidare med AI_PROVIDER=bedrock.)'
    )
    process.exitCode = 1
    return
  }

  console.log('\n1. Enkla anrop, båda modellerna')
  await ping(SONNET_MODEL)
  if (OPUS_MODEL !== SONNET_MODEL) await ping(OPUS_MODEL)

  console.log('\n2. Streaming med thinking, effort, cache och verktyg')
  await streamingTurn()

  const path = process.argv[2]
  console.log('\n3. Dokumenttolkning')
  if (path) await extraction(path)
  else console.log('  – hoppas över, ingen fil angiven (npx tsx scripts/smoke-ai.ts <fil>)')

  console.log(failures === 0 ? '\nAllt grönt.' : `\n${failures} steg föll.`)
  if (failures > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

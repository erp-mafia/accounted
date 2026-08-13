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
 *   2a. A streamed turn with a tool, the shape the chat loop sends.
 *   2b. Adaptive thinking, an effort level and a cached system prompt: the
 *       rest of that parameter set, probed separately because one turn cannot
 *       falsify both tool use and thinking at once (see the note there).
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

type ComposerModule = typeof import('../lib/agent/composer/client')
type ExtractionModule = typeof import('../extensions/general/invoice-inbox/lib/extract-invoice-fields')

let getAnthropic: ComposerModule['getAnthropic']
let EFFORT_DEEP: ComposerModule['EFFORT_DEEP']
let MAX_TOKENS_DEEP: ComposerModule['MAX_TOKENS_DEEP']
let OPUS_MODEL: ComposerModule['OPUS_MODEL']
let SONNET_MODEL: ComposerModule['SONNET_MODEL']
let extractInvoiceFields: ExtractionModule['extractInvoiceFields']

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
 * Split in two because one turn cannot falsify both things at once. A question
 * that needs a tool gets answered by calling the tool, and adaptive thinking
 * correctly declines to reason about it, so a zero thinking-block count there
 * means nothing. Each probe therefore asks for one behaviour and nothing else.
 */
async function streamingWithTool(): Promise<void> {
  const start = Date.now()
  try {
    const stream = getAnthropic().messages.stream({
      model: SONNET_MODEL,
      max_tokens: MAX_TOKENS_DEEP,
      system: 'Du är en svensk redovisningsassistent. Använd verktyget när du behöver ett kontosaldo.',
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
    const toolUse = message.content.filter((b) => b.type === 'tool_use').length

    console.log(
      `  ok verktyg+streaming: ${Date.now() - start}ms, stop=${message.stop_reason}, ` +
        `textdeltan=${deltas}, tool_use=${toolUse}`
    )
    if (toolUse === 0) {
      console.warn('     varning: inget tool_use-block, verktyget kan ha ignorerats')
    }
  } catch (err) {
    fail('verktyg+streaming', err)
  }
}

/**
 * Step 2b: adaptive thinking, effort and prompt caching.
 *
 * The question needs several dependent steps (reverse charge, then a partial
 * deduction, then which boxes move), because adaptive thinking is supposed to
 * skip reasoning it does not need: asking something easy cannot distinguish
 * "declined to think" from "parameter ignored".
 *
 * The system prompt is padded past the 1024-token minimum cacheable prefix.
 * Below it the API caches nothing and reports no error, so a short prompt
 * makes the cache counters read zero no matter whether caching works.
 */
async function thinkingTurn(): Promise<void> {
  const start = Date.now()
  const filler = 'Svara alltid på svenska och hänvisa till BAS-konton med nummer. '.repeat(120)
  try {
    const stream = getAnthropic().messages.stream({
      model: SONNET_MODEL,
      max_tokens: MAX_TOKENS_DEEP,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: EFFORT_DEEP },
      system: [
        {
          type: 'text',
          text: `Du är en svensk redovisningsassistent. ${filler}`,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [
        {
          role: 'user',
          content:
            'Ett svenskt momsregistrerat bolag köper en konsulttjänst från Tyskland för 10 000 kr. ' +
            'Bolaget har blandad verksamhet med 60 procent avdragsrätt. Hur bokförs affären, ' +
            'och vilka rutor i momsdeklarationen påverkas?',
        },
      ],
    })

    const message = await stream.finalMessage()

    const thinkingBlocks = message.content.filter((b) => b.type === 'thinking')
    const thinkingChars = thinkingBlocks
      .map((b) => (b as { type: 'thinking'; thinking: string }).thinking?.length ?? 0)
      .reduce((a, b) => a + b, 0)
    const cacheWrite = message.usage.cache_creation_input_tokens ?? 0
    const cacheRead = message.usage.cache_read_input_tokens ?? 0

    console.log(
      `  ok thinking+cache: ${Date.now() - start}ms, stop=${message.stop_reason}, ` +
        `thinking-block=${thinkingBlocks.length}, thinking-tecken=${thinkingChars}, ` +
        `cache write/read=${cacheWrite}/${cacheRead}`
    )
    if (thinkingBlocks.length === 0) {
      console.warn(
        '     varning: inget thinking-block pa en fraga som kraver flera steg. ' +
          'Chattens "Tankte…"-block skulle da aldrig fyllas.'
      )
    } else if (thinkingChars === 0) {
      console.warn(
        '     varning: thinking-block utan text, sa display:"summarized" slog inte igenom.'
      )
    }
    if (cacheWrite === 0 && cacheRead === 0) {
      console.warn('     varning: ingenting cachat trots prefix over minimigransen')
    }
  } catch (err) {
    fail('thinking+cache', err)
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
    // documentKind arrived with the receipt-aware extraction work. Read it
    // defensively so this script still compiles against a checkout from
    // before that landed: the whole point of it is to be runnable anywhere
    // the app runs, including an older self-hosted deployment.
    const kind = (data as { documentKind?: string | null }).documentKind ?? '-'
    console.log(
      `  ok extraction: ${Date.now() - start}ms, leverantör="${data.supplier.name ?? '-'}", ` +
        `nummer=${data.invoice.invoiceNumber ?? '-'}, datum=${data.invoice.invoiceDate ?? '-'}, ` +
        `typ=${kind}`
    )
  } catch (err) {
    fail('extraction', err)
  }
}

async function main(): Promise<void> {
  // These modules resolve their model ids at import time. Load them only after
  // dotenv has populated the environment so .env.local provider and model
  // overrides are exercised by the smoke test.
  const [composer, extractionModule] = await Promise.all([
    import('../lib/agent/composer/client'),
    import('../extensions/general/invoice-inbox/lib/extract-invoice-fields'),
  ])
  getAnthropic = composer.getAnthropic
  EFFORT_DEEP = composer.EFFORT_DEEP
  MAX_TOKENS_DEEP = composer.MAX_TOKENS_DEEP
  OPUS_MODEL = composer.OPUS_MODEL
  SONNET_MODEL = composer.SONNET_MODEL
  extractInvoiceFields = extractionModule.extractInvoiceFields

  const provider = resolveAiProvider()
  const explicitProvider = (process.env.AI_PROVIDER ?? '').trim().toLowerCase()
  console.log(`Leverantör:   ${provider}`)
  console.log(`Nyckel:       ${hasAiCredentials() ? `${aiCredentialPrefix()}…` : 'SAKNAS'}`)
  if (provider === 'bedrock') console.log(`Region:       ${process.env.AWS_REGION || 'eu-north-1'}`)
  console.log(`Modeller:     ${SONNET_MODEL} / ${OPUS_MODEL}`)

  if (!hasAiCredentials() && explicitProvider !== 'bedrock') {
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

  console.log('\n2a. Streaming med verktyg')
  await streamingWithTool()

  console.log('\n2b. Adaptive thinking, effort och prompt-cache')
  await thinkingTurn()

  const path = process.argv[2]
  console.log('\n3. Dokumenttolkning')
  if (path) await extraction(path)
  else console.log(' - skipping, no file given (npx tsx scripts/smoke-ai.ts <file>)')

  console.log(failures === 0 ? '\nAllt grönt.' : `\n${failures} steg föll.`)
  if (failures > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

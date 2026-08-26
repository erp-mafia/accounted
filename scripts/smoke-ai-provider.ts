#!/usr/bin/env npx tsx
/**
 * Smoke test for the configured AI backend through the job-shaped service in
 * lib/ai: the self-hoster's "is AI wired up?" command. Works the same against
 * AWS Bedrock, the direct Anthropic API, and any OpenAI-compatible endpoint
 * (a Swedish inference provider on a sovereign self-host), because it only
 * ever talks to getAiService().
 *
 * Steps:
 *   0. Print the resolved status: provider, models per tier, PDF mode, vision,
 *      strict JSON, and (for rasterized PDFs) whether pdftoppm is installed.
 *      Exits 1 with the reason when nothing is configured.
 *   1. A tiny text generation on each distinct tier model.
 *   2. A schema-shaped answer (generateStructured).
 *   3. Document extraction end to end, when given a file (PDF, JPEG, PNG,
 *      WebP, GIF or HTML): the exact path an uploaded receipt takes, so a
 *      missing rasterizer, a text-only model or a rejected request surfaces
 *      here rather than as an empty inbox row.
 *
 * The chat loop (the in-app assistant) still speaks the Anthropic SDK
 * directly; its parameter set (adaptive thinking, effort, prompt cache, tools)
 * is probed by scripts/smoke-ai.ts on the Anthropic family only.
 *
 * Usage:
 *   npx tsx scripts/smoke-ai-provider.ts
 *   npx tsx scripts/smoke-ai-provider.ts ./some-receipt.pdf
 *
 * Environment: reads .env.local then .env (the Docker compose env file), so
 * run it from the checkout next to the env file your deployment uses.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
config({ path: '.env' })

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { promisify } from 'node:util'

type AiModule = typeof import('../lib/ai')
type ExtractionModule = typeof import('../extensions/general/invoice-inbox/lib/extract-invoice-fields')

let failures = 0

function fail(step: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`  x ${step}: ${message}`)
  failures++
}

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.htm': 'text/html',
}

async function probeRasterizer(): Promise<string> {
  const bin = process.env.AI_PDF_RASTERIZER_BIN ?? 'pdftoppm'
  try {
    const { stdout, stderr } = await promisify(execFile)(bin, ['-v'])
    const firstLine = `${stdout}${stderr}`.split('\n').find((l) => l.trim().length > 0) ?? 'found'
    return `found (${firstLine.trim()})`
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    return code === 'ENOENT'
      ? `MISSING (${bin} not on PATH: PDFs will be skipped with pdf_rasterizer_missing; install poppler-utils or set AI_PDF_MODE=native if the endpoint accepts PDF parts)`
      : `error (${err instanceof Error ? err.message : String(err)})`
  }
}

async function main(): Promise<void> {
  const ai: AiModule = await import('../lib/ai')
  const status = ai.getAiStatus()

  console.log(`Provider:     ${status.provider}`)
  if (status.provider === 'openai-compatible') {
    let host = '(AI_BASE_URL unset)'
    try {
      host = new URL(process.env.AI_BASE_URL ?? '').host
    } catch {
      // printed as unset
    }
    console.log(`Endpoint:     ${host}`)
  }
  console.log(`Configured:   ${status.configured ? 'yes' : `NO (${status.reason})`}`)
  console.log(`Models:       assistant=${status.models.assistant ?? '-'}  heavy=${status.models.heavy ?? '-'}  extraction=${status.models.extraction ?? '-'}`)
  console.log(`PDF mode:     ${status.pdfMode}${status.pdfMode === 'rasterize' ? `  pdftoppm: ${await probeRasterizer()}` : ''}`)
  console.log(`Capabilities: vision=${status.capabilities.imageInput} pdfNative=${status.capabilities.pdfNative} strictJson=${status.capabilities.strictJsonSchema}`)
  console.log(`Assistant:    ${status.assistantAvailable ? 'available' : 'not available on this backend (extraction and single-call AI still run)'}`)
  console.log()

  if (!status.configured) {
    console.error(
      status.reason === 'no_credentials'
        ? 'No AI credentials found. Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (Bedrock), ANTHROPIC_API_KEY (direct API), or AI_BASE_URL + AI_API_KEY (OpenAI-compatible endpoint).'
        : 'No model id configured. An OpenAI-compatible endpoint has no default: set AI_MODEL (and optionally AI_EXTRACTION_MODEL for a vision model).'
    )
    process.exit(1)
  }

  const service = ai.getAiService()

  // 1. Text generation per distinct tier model.
  console.log('1. Text generation, one call per distinct tier model')
  const seen = new Set<string>()
  for (const tier of ['assistant', 'heavy', 'extraction'] as const) {
    const model = service.modelFor(tier)
    if (seen.has(model)) continue
    seen.add(model)
    const start = Date.now()
    try {
      const result = await service.generateText({
        tier,
        prompt: 'Säg "hej" på svenska, ett ord.',
        maxTokens: 32,
      })
      console.log(`  ok ${tier} (${model}): ${Date.now() - start}ms: "${result.text.slice(0, 40)}"  tokens in/out=${result.usage.inputTokens ?? '?'}/${result.usage.outputTokens ?? '?'}`)
    } catch (err) {
      fail(`${tier} (${model})`, err)
    }
  }

  // 2. Schema-shaped answer.
  console.log('2. Structured output')
  {
    const start = Date.now()
    try {
      const result = await service.generateStructured({
        tier: 'assistant',
        prompt: 'Return a Swedish one-word greeting and the ISO 639-1 code of its language.',
        maxTokens: 200,
        schema: {
          name: 'greeting',
          description: 'a greeting and its language code',
          jsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { greeting: { type: 'string' }, language: { type: 'string' } },
            required: ['greeting', 'language'],
          },
        },
      })
      const value = result.value as { greeting?: unknown; language?: unknown }
      if (typeof value?.greeting !== 'string' || typeof value?.language !== 'string') {
        throw new Error(`unexpected shape: ${JSON.stringify(result.value).slice(0, 120)}`)
      }
      console.log(`  ok structured: ${Date.now() - start}ms: ${JSON.stringify(value)}`)
    } catch (err) {
      fail('structured', err)
    }
  }

  // 3. Document extraction.
  const file = process.argv[2]
  if (file) {
    console.log('3. Document extraction')
    const mimeType = MIME_BY_EXT[extname(file).toLowerCase()]
    if (!mimeType) {
      fail('extraction', new Error(`unsupported extension "${extname(file)}": use pdf, jpg, png, webp, gif or html`))
    } else {
      const start = Date.now()
      try {
        const extraction: ExtractionModule = await import(
          '../extensions/general/invoice-inbox/lib/extract-invoice-fields'
        )
        const buffer = await readFile(file)
        const result = await extraction.extractInvoiceFields({
          buffer,
          mimeType,
          fileName: basename(file),
        })
        if (result.skipped) {
          throw new Error(
            `skipped (${result.skipped}): no model call was made. ` +
              (result.skipped === 'ai_no_vision'
                ? 'The configured model is declared text-only (AI_VISION=false); pick a vision model for AI_EXTRACTION_MODEL.'
                : result.skipped === 'pdf_rasterizer_missing'
                  ? 'Install poppler-utils (pdftoppm) or set AI_PDF_MODE=native.'
                  : '')
          )
        }
        if (!result.rawText) {
          throw new Error('the model answered but nothing parseable came back (see the warning above)')
        }
        const d = result.data
        console.log(
          `  ok extraction (${result.model}): ${Date.now() - start}ms: supplier="${d.supplier.name ?? '-'}", ` +
            `date=${d.invoice.invoiceDate ?? '-'}, total=${d.totals.total ?? '-'} ${d.invoice.currency}, kind=${d.documentKind ?? '-'}`
        )
      } catch (err) {
        fail('extraction', err)
      }
    }
  } else {
    console.log('3. Document extraction: skipped (pass a file path to run it)')
  }

  console.log()
  if (failures > 0) {
    console.error(`${failures} step(s) failed.`)
    process.exit(1)
  }
  console.log('All green.')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})

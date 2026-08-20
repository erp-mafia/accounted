import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Guards the public privacy and DPA pages against drifting away from what the
 * code actually does (#1674). A prospect compared our security claims with a
 * stale published DPA that listed Anthropic and OpenAI as US processors; the
 * in-repo pages were right, but nothing pinned them to the code. These tests
 * anchor every AI and session-replay disclosure to the source of truth:
 *
 * - lib/ai/provider.ts: hosted inference is Claude on Amazon Bedrock by
 *   credential precedence, default region eu-north-1 (AWS_REGION overrides).
 *   A direct Anthropic API path exists for self-hosted deployments, and an
 *   OpenAI-compatible protocol client for operator-configured BYO endpoints
 *   (AI_BASE_URL); nothing defaults to or calls OpenAI's hosted API.
 * - instrumentation-client.ts + lib/analytics/replay-masking.ts: session
 *   replay masking is deny-by-default with no input-mask exceptions.
 *
 * The pages are server components and this repo deliberately has no component
 * test harness (CLAUDE.md: scope is lib/ + app/api/), so these assert on the
 * page source, the same pattern as
 * app/(auth)/register/__tests__/invite-email-prefill.test.ts.
 */
const ROOT = path.resolve(__dirname, '../../../..')

function read(rel: string): string {
  return fs.readFileSync(path.resolve(ROOT, rel), 'utf8')
}

/** Source with comment lines dropped, so prose about a pattern is never mistaken for the pattern. */
function code(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n')
}

const PRIVACY = read('app/(public)/privacy/page.tsx')
const DPA = read('app/(public)/dpa/page.tsx')
const PROVIDER = read('lib/ai/provider.ts')
const CLIENT = read('instrumentation-client.ts')
const PKG = JSON.parse(read('package.json')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** The AWS/Bedrock row of the sub-processor table. */
function bedrockRow(): string {
  const anchor = PRIVACY.indexOf('Amazon Web Services (AWS)')
  expect(anchor, 'no AWS row in the sub-processor table').toBeGreaterThan(-1)
  const start = PRIVACY.lastIndexOf('<tr', anchor)
  return PRIVACY.slice(start, PRIVACY.indexOf('</tr>', anchor))
}

/** The PostHog row of the sub-processor table. */
function posthogRow(): string {
  const anchor = PRIVACY.indexOf('PostHog')
  expect(anchor, 'no PostHog row in the sub-processor table').toBeGreaterThan(-1)
  const start = PRIVACY.lastIndexOf('<tr', anchor)
  return PRIVACY.slice(start, PRIVACY.indexOf('</tr>', anchor))
}

describe('AI provider disclosures match the code', () => {
  it('has no code path that sends data to OpenAI the company', () => {
    // The only openai-named dependency is the protocol client for
    // operator-configured self-host endpoints (AI_BASE_URL); it must never
    // default to OpenAI's hosted API.
    const deps = { ...PKG.dependencies, ...PKG.devDependencies }
    expect(Object.keys(deps).filter((name) => name.toLowerCase().includes('openai'))).toEqual([
      '@ai-sdk/openai-compatible',
    ])
    expect(code(PROVIDER)).not.toContain('api.openai.com')
    expect(code(read('lib/ai/services/openai-compatible.ts'))).not.toContain('api.openai.com')
    // The openai-compatible provider is only reachable when the operator
    // points AI_BASE_URL somewhere; without it the provider is unconfigured.
    expect(code(PROVIDER)).toMatch(/openai-compatible'\) return !!process\.env\.AI_BASE_URL/)
  })

  it('never mentions OpenAI on the privacy or DPA page', () => {
    // A published artifact once listed OpenAI as a processor; no code path
    // calls OpenAI, so any mention on these pages is factually wrong.
    expect(PRIVACY.toLowerCase()).not.toContain('openai')
    expect(DPA.toLowerCase()).not.toContain('openai')
  })

  it('ships the Bedrock SDK the disclosure describes', () => {
    expect(PKG.dependencies?.['@anthropic-ai/bedrock-sdk']).toBeTruthy()
  })

  it('discloses the exact region the provider defaults to', () => {
    // lib/ai/provider.ts pins hosted inference to eu-north-1 unless AWS_REGION
    // overrides it; the pages must claim that region, not a generic "EU".
    expect(code(PROVIDER)).toContain("process.env.AWS_REGION || 'eu-north-1'")
    expect(bedrockRow()).toContain('eu-north-1')
    expect(bedrockRow()).toContain('Stockholm')
    expect(DPA).toContain('eu-north-1')
  })

  it('describes the Bedrock row with claims provable from code, no sub-processor verdict', () => {
    // The prospect read a bare AWS row next to a DPA listing Anthropic as a US
    // processor. The row must say what the code shows: AI requests go to
    // Amazon Bedrock, and the models are Anthropic's Claude running inside
    // Bedrock. Whether Anthropic is an underbiträde of AWS is a contractual
    // question between AWS and Anthropic that this repo cannot verify, so the
    // page must not assert it either way; that wording is founder/legal's.
    const row = bedrockRow()
    const normalized = row.replace(/\s+/g, ' ')
    expect(normalized).toContain('AI-anropen skickas till Amazon Bedrock')
    expect(normalized).toContain(
      'modellerna som används är Anthropics Claude-modeller, körda inom Bedrock',
    )
    expect(row).not.toContain('underbiträde')
  })

  it('keeps the DPA pointing at the privacy policy as the single sub-processor list', () => {
    expect(DPA).toContain('href="/privacy"')
    // The DPA must not grow its own (divergent) vendor list: /privacy owns the
    // sub-processor table, and its Bedrock row is where the Claude models are
    // described.
    expect(DPA).not.toContain('Anthropic')
  })
})

describe('session replay disclosure matches the masking config', () => {
  it('is actually deny-by-default in the PostHog init', () => {
    const client = code(CLIENT)
    expect(client).toContain('maskAllInputs: true')
    expect(client).toContain("maskTextSelector: '*'")
    expect(client).toContain('maskTextFn: replayMaskText')
    // No maskInputFn: rrweb masks every input value with no exceptions. If one
    // is ever added, the "utan undantag" wording below becomes a lie.
    expect(client).not.toContain('maskInputFn')
  })

  it('states the deny-by-default guarantee, not just a masking feature', () => {
    const row = posthogRow()
    const normalized = row.replace(/\s+/g, ' ')
    expect(normalized).toContain('maskering standardläget')
    expect(normalized).toContain('kan inte stängas av')
    expect(normalized).toContain('maskeras utan undantag')
    // The failure mode for untagged new UI is over-masking, never leakage
    // (lib/analytics/replay-masking.ts).
    expect(normalized).toContain('övermaskering')
  })
})

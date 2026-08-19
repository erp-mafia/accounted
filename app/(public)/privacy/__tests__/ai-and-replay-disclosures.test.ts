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
 * - lib/ai/provider.ts: hosted inference is Claude on Amazon Bedrock, default
 *   region eu-north-1. There is no OpenAI code path at all.
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
  it('has no OpenAI dependency or code path to disclose', () => {
    const deps = { ...PKG.dependencies, ...PKG.devDependencies }
    expect(Object.keys(deps).filter((name) => name.toLowerCase().includes('openai'))).toEqual([])
    expect(code(PROVIDER).toLowerCase()).not.toContain('openai')
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

  it('names Anthropic inside the Bedrock row so the table cannot contradict the footnote', () => {
    // The prospect read "Claude via Bedrock, delas inte med Anthropic" next to
    // a table with a bare AWS row and a DPA listing Anthropic as a US
    // processor. The row itself must say the models are Anthropic's, run
    // inside Bedrock, and that Anthropic receives nothing.
    const row = bedrockRow()
    expect(row).toContain('Anthropic')
    expect(row).toContain('Bedrock')
    expect(row).toContain('delas inte med')
    expect(row).toContain('inte underbiträde')
    // The footnote below the table makes the same claim in the same words.
    expect(PRIVACY).toContain('delas inte med Anthropic')
  })

  it('keeps the DPA pointing at the privacy policy as the single sub-processor list', () => {
    expect(DPA).toContain('href="/privacy"')
    // The DPA must not grow its own (divergent) vendor list: Anthropic is a
    // model vendor, not a sub-processor, and belongs only in the privacy
    // page's Bedrock row.
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

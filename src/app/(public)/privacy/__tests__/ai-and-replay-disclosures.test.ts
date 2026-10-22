import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { RECIPIENTS, recipientsFor } from '@/lib/legal/subprocessors'
import { LEGAL_DOCUMENTS, LEGAL_PATHS } from '@/lib/legal/documents'

/**
 * Guards the public legal pages against drifting away from what the code
 * actually does (#1674). A prospect compared our security claims with a stale
 * published DPA that listed Anthropic and OpenAI as US processors; nothing
 * pinned the pages to the code. These tests anchor the disclosures to the
 * source of truth:
 *
 * - lib/ai/provider.ts: hosted inference is Claude on Amazon Bedrock by
 *   credential precedence, default region eu-north-1 (AWS_REGION overrides),
 *   with the `eu.` cross-region inference profile. A direct Anthropic API
 *   path exists for self-hosted deployments, and an OpenAI-compatible protocol
 *   client for operator-configured BYO endpoints (AI_BASE_URL); nothing
 *   defaults to or calls OpenAI's hosted API.
 * - lib/analytics/client.ts + lib/analytics/replay-masking.ts: session
 *   replay masking is deny-by-default with no input-mask exceptions.
 * - lib/legal/subprocessors.ts: the single recipient list behind
 *   /subprocessors and the recipient table on /privacy.
 *
 * The pages are server components and this repo deliberately has no component
 * test harness (CLAUDE.md: scope is lib/ + app/api/), so page wording is
 * asserted on the page source, and the recipient list on the module itself.
 */
const ROOT = path.resolve(__dirname, '../../../..')

function read(rel: string): string {
  return fs.readFileSync(path.resolve(ROOT, rel), 'utf8')
}

/** ROOT is src/; migrations and scripts live above it at the repo root. */
const REPO_ROOT = path.resolve(ROOT, '..')

function readRepo(rel: string): string {
  return fs.readFileSync(path.resolve(REPO_ROOT, rel), 'utf8')
}

/** Source with comment lines dropped, so prose about a pattern is never mistaken for the pattern. */
function code(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n')
}

/** Whitespace folded, so assertions survive line wrapping in JSX. */
function flat(src: string): string {
  return src.replace(/\s+/g, ' ')
}

const PRIVACY = read('app/(public)/privacy/page.tsx')
const DPA = read('app/(public)/dpa/page.tsx')
const TERMS = read('app/(public)/terms/page.tsx')
const SUBPROCESSORS_PAGE = read('app/(public)/subprocessors/page.tsx')
const PROVIDER = read('lib/ai/provider.ts')
// PostHog's init, started only on consent (2026-10-21).
const CLIENT = read('lib/analytics/client.ts')
const PKG = JSON.parse(read('../package.json')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function recipient(namePart: string) {
  const row = RECIPIENTS.find((r) => r.name.includes(namePart))
  expect(row, `no ${namePart} row in lib/legal/subprocessors.ts`).toBeTruthy()
  return row!
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

  it('never mentions OpenAI on any legal page or in the recipient list', () => {
    // A published artifact once listed OpenAI as a processor; no code path
    // calls OpenAI, so any mention is factually wrong.
    for (const src of [PRIVACY, DPA, TERMS, SUBPROCESSORS_PAGE, JSON.stringify(RECIPIENTS)]) {
      expect(src.toLowerCase()).not.toContain('openai')
    }
  })

  it('ships the Bedrock SDK the disclosure describes', () => {
    expect(PKG.dependencies?.['@anthropic-ai/bedrock-sdk']).toBeTruthy()
  })

  it('discloses the region the provider defaults to and the EU-wide inference profile', () => {
    // Requests leave from eu-north-1 unless AWS_REGION overrides it, and the
    // `eu.` profile lets Bedrock serve them in any AWS EU region: the row
    // must say both, not "Stockholm only".
    expect(code(PROVIDER)).toContain("process.env.AWS_REGION || 'eu-north-1'")
    expect(code(PROVIDER)).toContain('`eu.anthropic.${bareModelId}`')
    const aws = recipient('Amazon Bedrock')
    expect(aws.location).toContain('eu-north-1')
    expect(aws.location).toContain('Stockholm')
    expect(aws.location).toContain('AWS EU-regioner')
  })

  it('describes the Bedrock row with claims provable from code, no sub-processor verdict', () => {
    // The row must say what the code shows: AI requests go to Amazon Bedrock,
    // and the models are Anthropic's Claude running inside Bedrock. Whether
    // Anthropic is an underbiträde of AWS is a contractual question between
    // AWS and Anthropic that this repo cannot verify, so the row must not
    // assert it either way; that wording is founder/legal's.
    const aws = recipient('Amazon Bedrock')
    expect(aws.purpose).toContain('AI-anropen skickas till Amazon Bedrock')
    expect(aws.purpose).toContain(
      'modellerna som används är Anthropics Claude-modeller, körda inom Bedrock',
    )
    expect(JSON.stringify(aws)).not.toContain('underbiträde')
  })

  it('keeps one recipient list: the DPA and privacy pages render it, never their own', () => {
    expect(DPA).toContain('href="/subprocessors"')
    expect(PRIVACY).toContain('href="/subprocessors"')
    expect(SUBPROCESSORS_PAGE).toContain('<RecipientTable view="dpa" />')
    expect(PRIVACY).toContain('<RecipientTable view="privacy" />')
    // A vendor named in a page's own prose next to the shared table is how
    // the lists diverged before; the DPA names none.
    expect(DPA).not.toContain('Anthropic')
    expect(DPA).not.toContain('Supabase')
  })

  it('splits the list by role without dropping anyone', () => {
    const dpa = recipientsFor('dpa').map((r) => r.name)
    const privacy = recipientsFor('privacy').map((r) => r.name)
    for (const r of RECIPIENTS) {
      expect(dpa.includes(r.name) || privacy.includes(r.name), r.name).toBe(true)
    }
    // Hosting carries both the customer's books and our own account data.
    expect(dpa.some((n) => n.startsWith('Supabase'))).toBe(true)
    expect(privacy.some((n) => n.startsWith('Supabase'))).toBe(true)
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
    const page = flat(PRIVACY)
    expect(page).toContain('maskering standardläget')
    expect(page).toContain('kan inte stängas av')
    expect(page).toContain('maskeras utan undantag')
    // The failure mode for untagged new UI is over-masking, never leakage
    // (lib/analytics/replay-masking.ts).
    expect(page).toContain('övermaskering')
  })
})

/**
 * The anonymised-statistics disclosure makes three factual promises about
 * what the calibration corpus contains. Each is only true as long as the
 * write path stays as narrow as the prose says, so pin them to it:
 * re-adding company_id, an amount or any free text to the insert must fail
 * here rather than quietly turn the published page into a false statement.
 */
describe('anonymised statistics disclosure', () => {
  const OUTCOME_ROUTE = code(read('app/api/agent/categorize/outcome/route.ts'))

  it('the page claims the row carries no company_id, amount or free text', () => {
    expect(PRIVACY).toContain('Anonymiserad statistik')
    expect(flat(PRIVACY)).toContain('varken företags-ID, belopp eller fritext')
  })

  it('the outcome route writes no company_id and no amount', () => {
    const insert = OUTCOME_ROUTE.slice(OUTCOME_ROUTE.indexOf('categorize_calibration_samples'))
    expect(insert).not.toMatch(/company_id\s*:/)
    expect(insert).not.toMatch(/amount\s*:/)
  })

  it('the corpus columns stay the anonymous set the page describes', () => {
    const migration = readRepo('supabase/migrations/20260922173222_calibration_samples_anonymous.sql')
    expect(migration).toMatch(/DROP COLUMN company_id/)
    expect(migration).toMatch(/DROP COLUMN amount/)
    expect(migration).toMatch(/DROP COLUMN data_analysis_opt_in/)
  })

  it('evaluation runs never default to live customer books', () => {
    const backtest = code(readRepo('scripts/backtest-categorize.ts'))
    expect(backtest).toContain('BACKTEST_COMPANY_IDS')
    expect(backtest).toContain('is_sandbox')
  })

  it('the counterparty directory threshold and kinds are the ones the pages state', () => {
    // Both pages say: at least two companies, and only merchants, authorities,
    // banks and payment rails, never private persons.
    const directory = code(read('lib/parties/resolver/directory.ts'))
    expect(directory).toContain('PROMOTION_MIN_COMPANIES = 2')
    expect(directory).toContain("new Set(['merchant', 'authority', 'bank', 'rail'])")
    expect(flat(PRIVACY)).toContain('minst två företag')
    expect(flat(DPA)).toContain('minst två företag')
  })
})

describe('payroll and retention disclosures match the code', () => {
  it('names the special categories payroll actually stores', () => {
    // Absence types include sick and pregnancy leave (health data) and a
    // union-fee deduction line reveals trade union membership: the DPA must
    // say so instead of claiming no art. 9 data.
    const absence = readRepo('supabase/migrations/20260529200000_salary_absence_add_unpaid_leave.sql')
    expect(absence).toContain("'sick'")
    expect(code(read('lib/salary/recurring-lines.ts'))).toContain("net_deduction_union: 'Fackavgift'")
    const dpa = flat(DPA)
    expect(dpa).toContain('sjukfrånvaro')
    expect(dpa).toContain('fackavgift')
    expect(dpa).toContain('Kundens anställda')
  })

  it('states the telemetry retention the cleanup cron enforces', () => {
    const cron = code(read('app/api/events/cleanup/cron/route.ts'))
    expect(cron).toContain('TELEMETRY_RETENTION_DAYS = 180')
    expect(flat(PRIVACY)).toContain('180 dagar')
  })

  it('describes the sign-in the product has, never a magic link', () => {
    for (const src of [PRIVACY, DPA, SUBPROCESSORS_PAGE]) {
      expect(src.toLowerCase()).not.toContain('magic link')
    }
    expect(flat(DPA)).toContain('TOTP')
  })

  it('serves every legal page without a session', () => {
    const middleware = code(read('lib/supabase/middleware.ts'))
    expect(middleware).toContain('LEGAL_PATHS.includes(pathname)')
    expect(LEGAL_PATHS.sort()).toEqual(
      Object.values(LEGAL_DOCUMENTS)
        .map((d) => d.path)
        .sort(),
    )
  })
})

/**
 * Consent and the company's data choices (2026-10-21). The pages say
 * analytics starts only on consent, that AI and pooling can be switched off
 * and that content is used only when the company opts in; each claim is
 * pinned to the code that makes it true.
 */
describe('consent and data choices match the code', () => {
  const INSTRUMENTATION = code(read('instrumentation-client.ts'))
  const IDENTIFY = code(read('components/AnalyticsIdentify.tsx'))
  const METER = code(read('lib/ai/meter.ts'))
  const DIRECTORY = code(read('lib/parties/resolver/directory.ts'))
  const MIGRATION = readRepo('supabase/migrations/20261021170000_legal_acceptances_and_data_choices.sql')

  it('starts PostHog only from AnalyticsIdentify, on unless the person switched it off', () => {
    // Founder decision 2026-10-22: on by default, opt-out in settings. The
    // page must say opt-out and legitimate interest, never consent.
    expect(INSTRUMENTATION).not.toContain('posthog.init')
    expect(INSTRUMENTATION).not.toContain("from 'posthog-js'")
    expect(IDENTIFY).toContain('if (!analyticsConsent) return')
    expect(IDENTIFY).toContain('initAnalytics()')
    expect(code(read('app/(dashboard)/layout.tsx'))).toContain('analyticsConsent={acceptance.analyticsConsent !== false}')
    const page = flat(PRIVACY)
    expect(page).toContain('påslagna när du är inloggad, och du kan när som helst stänga av dem')
    expect(page).not.toContain('startar först när du har godkänt dem')
  })

  it('the AI switch is enforced where every model call passes', () => {
    expect(METER).toContain('throw new AiSwitchedOffError(companyId)')
    expect(flat(PRIVACY)).toContain('då skickas inget av företagets innehåll till AI-tjänsten')
    expect(flat(DPA)).toContain('Kunden kan stänga av AI-funktionerna i Tjänsten')
  })

  it('pooling opt-outs are left out of the shared directory, and contribution is off by default', () => {
    expect(DIRECTORY).toContain('companiesWithPoolingOff')
    expect(MIGRATION).toContain("v_default := p_key <> 'data:contribution'")
    expect(flat(PRIVACY)).toContain('då räknas företagets tolkningar inte in')
    expect(flat(DPA)).toContain('om inte Kunden har slagit på Bidra med innehåll i Tjänsten')
  })

  it('claims recorded acceptances only while the acceptance prompt is on', () => {
    expect(MIGRATION).toContain('CREATE TABLE public.legal_acceptances')
    const gate = code(read('components/legal/LegalAcceptanceGate.tsx'))
    const promptOn = gate.includes('PROMPT_ENABLED = true')
    expect(gate).toMatch(/PROMPT_ENABLED = (true|false)/)
    expect(flat(DPA).includes('Tjänsten sparar vem som godkände vilken version och när')).toBe(promptOn)
  })
})

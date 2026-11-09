/**
 * Proof for the MR privacy scanner (issue #155). Every personnummer below is
 * from Skatteverket's published test lists (testpersonnummer and
 * testsamordningsnummer open data), never a number that could belong to a
 * person. Names and domains are invented.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  emailAllowed,
  findPrivacyIssues,
  luhnValid,
  parseCustomerNames,
  plausibleDate,
  readCustomerNames,
  readMergeRequest,
  scan,
  stripAuthorTrailers,
} from '../../check-mr-privacy.mjs'

type Issue = { rule: string; line: number; masked: string }
type NameList = ReturnType<typeof parseCustomerNames>['names']

const NOW = new Date('2026-11-08T12:00:00Z')
const issues = (text: string, names: NameList = []): Issue[] => findPrivacyIssues(text, names, NOW)
const rules = (text: string, names: NameList = []) => issues(text, names).map((issue) => issue.rule)
// The checker reads process.env; NODE_ENV is a required key of ProcessEnv in this repo's typings.
const env = (vars: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', ...vars })

// Skatteverket test numbers: 195001182046 and 189001019802 (testpersonnummer),
// 202601612381 (testsamordningsnummer 2026).
const TEST_PNR_12 = '195001182046'
const TEST_PNR_OLD = '189001019802'
const TEST_SAMORDNING_12 = '202601612381'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('personnummer', () => {
  it.each([
    ['12 digits', TEST_PNR_12],
    ['12 digits with a dash', '19500118-2046'],
    ['10 digits with a dash', '500118-2046'],
    ['10 digits without a separator', '5001182046'],
    ['a plus for someone over 100', '900101+9802'],
    ['a samordningsnummer, 12 digits', TEST_SAMORDNING_12],
    ['a samordningsnummer, 10 digits with a dash', '260161-2381'],
  ])('blocks %s', (_label, number) => {
    expect(rules(`fix: payroll for ${number}.`)).toEqual(['personnummer'])
  })

  it('blocks a planted test number in a long description, and masks it', () => {
    const description = `## What\n\n${'Context line.\n'.repeat(200)}Employee | 19500118-2046 | moved\n`
    const found = issues(description)
    expect(found).toEqual([{ rule: 'personnummer', line: 203, masked: '########-####' }])
    expect(JSON.stringify(found)).not.toContain('2046')
  })

  it('checks the check digit and the date', () => {
    expect(luhnValid('5001182046')).toBe(true)
    expect(luhnValid('9001019802')).toBe(true)
    expect(luhnValid('2601612381')).toBe(true)
    expect(luhnValid('5001182047')).toBe(false)
    expect(plausibleDate(undefined, '50', '01', '18')).toBe(true)
    expect(plausibleDate(undefined, '26', '01', '61')).toBe(true)
    expect(plausibleDate(undefined, '50', '13', '18')).toBe(false)
    expect(plausibleDate(undefined, '50', '02', '30')).toBe(false)
    expect(plausibleDate('19', '50', '02', '29')).toBe(false)
    expect(plausibleDate('20', '99', '01', '18', NOW)).toBe(false)
    expect(plausibleDate('16', '55', '01', '18', NOW)).toBe(false)
  })

  it.each([
    ['a wrong check digit', '500118-2047'],
    ['an impossible month', '501318-2046'],
    ['an org number, which is public', '559900-0006'],
    ['an org number without a dash', '5599000006'],
    ['a 12 digit number dated in the future', '20990118-2046'],
    ['a migration version', '20261104002931'],
    ['a GitLab pipeline id', 'Pipeline 3034721906 green'],
    ['a pipeline id that looks like a date', 'pipeline 5001182046 green'],
    ['a list of pipeline ids', 'pipelines 3034721906 and 5001182046 green'],
    ['a job id', 'job: 5001182046'],
    ['an MR reference', '!5001182046'],
    ['an issue reference', '#5001182046'],
    ['a gitlab.com URL', 'https://gitlab.com/group/project/-/pipelines/5001182046'],
    ['a decimal', 'ratio 0.5001182046'],
    ['a longer digit run', '15001182046'],
    ['part of a word', 'sub_5001182046abc'],
  ])('passes %s', (_label, text) => {
    expect(rules(text)).toEqual([])
  })
})

describe('earlier false positives', () => {
  it.each([
    ['a pipeline id', 'Pipeline 3034721906 green, ready to merge'],
    ['an ISO 20022 message name', 'Payment files are pain.001.001.03'],
    ['a decimal pair', 'rates 0.25 / 0.12'],
    ['a date range', 'fiscal year 2026-01-01 - 2026-12-31'],
    ['a slash date', 'from 01/01/2026'],
    ['our support address', 'Write to support@accounted.se'],
    ['a git remote', 'git@gitlab.com:group/project.git'],
    ['a GitHub noreply author', '12345+someone@users.noreply.github.com'],
    ['a noreply sender', 'noreply@mail.provider-example.io'],
    ['reserved example domains', 'anna@example.se, bo@kund.example, li@bolag.test'],
    ['a crm ticket and BAS accounts', 'crm#1356: book 1930 against 2641 and 3001'],
    ['words that hold a short name', 'created a benchmark for Erikssons'],
    ['a phone number, a rule that is gone', 'call +46 70 123 45 67 or 08-123 456 78'],
  ])('passes %s', (_label, text) => {
    expect(rules(text)).toEqual([])
  })

  it('strips author and sign-off trailers before scanning', () => {
    const text = 'fix: safe change\n\nSigned-off-by: Contributor <someone@mailbox-example.se>\nCo-Authored-By: Person <person@customer-example.se>'
    expect(stripAuthorTrailers(text)).not.toMatch(/Co-Authored-By|Signed-off-by/)
    expect(rules(text)).toEqual([])
  })
})

describe('email', () => {
  it('blocks an address outside our domains and masks it', () => {
    const found = issues('Reply sent to\nkontakt@acme-havsbad.se today')
    expect(found).toEqual([{ rule: 'email', line: 2, masked: 'k***@a***.se' }])
    expect(JSON.stringify(found)).not.toContain('kontakt')
    expect(JSON.stringify(found)).not.toContain('acme-havsbad')
  })

  it('allows our own domains and their subdomains only', () => {
    expect(emailAllowed('faktura@inbox.gnubok.se')).toBe(true)
    expect(emailAllowed('security@arcim.io')).toBe(true)
    expect(emailAllowed('someone@accounted.se.attacker-example.com')).toBe(false)
    expect(emailAllowed('someone@notaccounted.se')).toBe(false)
  })
})

describe('links', () => {
  it.each([
    ['a PostHog conversation', 'https://eu.posthog.com/project/1/conversations/abc', 'support_link'],
    ['a Gmail thread', 'https://mail.google.com/mail/u/0/#inbox/abc', 'support_link'],
    ['a Discord channel', 'https://discord.com/channels/123/456', 'support_link'],
    ['an app link with a record id', 'https://app.accounted.se/invoices/123e4567-e89b-12d3-a456-426614174000', 'app_deep_link'],
  ])('blocks %s and prints only the host', (_label, url, rule) => {
    const found = issues(`see ${url}`)
    expect(found.map((issue) => issue.rule)).toEqual([rule])
    expect(found[0].masked).not.toContain('abc')
    expect(found[0].masked).not.toContain('123e4567')
  })

  it('passes an app link without an id', () => {
    expect(rules('https://app.accounted.se/settings/billing')).toEqual([])
  })
})

describe('customer names', () => {
  const { names, skipped } = parseCustomerNames('Acme Havsbad AB\nTed\nNordvik Snickeri\nSkog och Mark')

  it('skips a name with a word shorter than 4 characters and counts it', () => {
    expect(names).toHaveLength(2)
    expect(skipped).toBe(2)
  })

  it('matches a name as a whole phrase, with or without its legal form', () => {
    expect(rules('Investigate Acme Havsbad AB import', names)).toEqual(['customer_name'])
    expect(rules('Investigate Acme  Havsbad import', names)).toEqual(['customer_name'])
    expect(rules('NORDVIK SNICKERI books', names)).toEqual(['customer_name'])
  })

  it('needs the first letter of each word as written, and whole words', () => {
    expect(rules('acme havsbad import', names)).toEqual([])
    expect(rules('Acme havsbad import', names)).toEqual([])
    expect(rules('Acme Havsbadet import', names)).toEqual([])
    expect(rules('AcmeHavsbad import', names)).toEqual([])
    expect(rules('Acme import, Havsbad export', names)).toEqual([])
    expect(rules('Ted created a benchmark', names)).toEqual([])
  })

  it('never prints the name', () => {
    const found = issues('Investigate Acme Havsbad', names)
    expect(found).toEqual([{ rule: 'customer_name', line: 1, masked: '[name 1 of the list]' }])
  })

  it('reads the list from the variable, a File variable path, base64 or a JSON array', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-privacy-'))
    tempDirs.push(dir)
    const file = path.join(dir, 'names')
    fs.writeFileSync(file, 'Acme Havsbad AB\nNordvik Snickeri\n')
    expect(readCustomerNames(env({ MR_PRIVACY_CUSTOMER_NAMES: 'Acme Havsbad AB\nNordvik Snickeri' })).names).toHaveLength(2)
    expect(readCustomerNames(env({ MR_PRIVACY_CUSTOMER_NAMES: file })).names).toHaveLength(2)
    const encoded = Buffer.from('Acme Havsbad AB\nNordvik Snickeri').toString('base64')
    expect(readCustomerNames(env({ MR_PRIVACY_CUSTOMER_NAMES_B64: encoded }))).toMatchObject({ source: 'MR_PRIVACY_CUSTOMER_NAMES_B64' })
    expect(readCustomerNames(env({ MR_PRIVACY_CUSTOMER_NAMES: '["Acme Havsbad AB"]' })).names).toHaveLength(1)
    expect(readCustomerNames(env())).toEqual({ source: null, names: [], skipped: 0 })
  })
})

describe('MR description coverage', () => {
  const ciEnv = env({
    CI_JOB_TOKEN: 'job-token',
    CI_API_V4_URL: 'https://gitlab.example/api/v4',
    CI_PROJECT_ID: '42',
    CI_MERGE_REQUEST_IID: '7',
    CI_MERGE_REQUEST_TITLE: 'ci: title',
    CI_MERGE_REQUEST_DESCRIPTION: 'x'.repeat(2700),
    CI_MERGE_REQUEST_DESCRIPTION_IS_TRUNCATED: 'true',
  })

  it('reads the full description from the API with the job token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ title: 'ci: title', description: 'y'.repeat(9000) }) })
    const mr = await readMergeRequest({}, ciEnv, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledWith('https://gitlab.example/api/v4/projects/42/merge_requests/7', expect.objectContaining({ headers: { 'JOB-TOKEN': 'job-token' } }))
    expect(mr.description).toHaveLength(9000)
    expect(mr.notes.join('\n')).toContain('full description (9000 characters)')
  })

  it('says so when the API refuses and the variable was cut', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) })
    const mr = await readMergeRequest({}, ciEnv, fetchImpl)
    expect(mr.description).toHaveLength(2700)
    expect(mr.notes.join('\n')).toContain('HTTP 403')
    expect(mr.notes.join('\n')).toContain('only its first 2700 characters were scanned')
  })

  it('falls back when the API cannot be reached', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const mr = await readMergeRequest({}, ciEnv, fetchImpl)
    expect(mr.notes.join('\n')).toContain('could not be reached')
  })
})

describe('scan mode', () => {
  it('measures a list of texts and prints counts and masked findings only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-privacy-'))
    tempDirs.push(dir)
    const file = path.join(dir, 'texts.json')
    fs.writeFileSync(
      file,
      JSON.stringify([
        'Pipeline 3034721906 green',
        { label: 'MR!1 description', text: `Employee ${TEST_PNR_OLD.slice(2, 8)}+${TEST_PNR_OLD.slice(8)} moved` },
        { label: 'MR!2 title', text: 'fix: reply to kontakt@acme-havsbad.se' },
      ]),
    )
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => void out.push(line))
    vi.spyOn(console, 'error').mockImplementation((line: string) => void out.push(line))
    expect(scan(file, env())).toBe(1)
    const printed = out.join('\n')
    expect(printed).toContain('Scanned 3 text(s): 2 finding(s) in 2 text(s) (personnummer 1, email 1).')
    expect(printed).toContain('MR!1 description, line 1: personnummer: ######+####')
    expect(printed).toContain('no customer name list')
    expect(printed).not.toContain('9802')
    expect(printed).not.toContain('kontakt')
  })
})

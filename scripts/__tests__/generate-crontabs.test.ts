import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCrontab,
  readVercelCrons,
  scheduleFor,
  EXCLUDED_PATHS,
  EXTRA_JOBS,
  SCHEDULE_OVERRIDES,
  VARIANTS,
  type CrontabVariant,
  type VercelCron,
} from '../generate-crontabs'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

const crons = readVercelCrons(readFileSync(join(ROOT, 'vercel.json'), 'utf8'))

function crontabText(variant: CrontabVariant): string {
  return readFileSync(join(ROOT, 'docker', `crontab.${variant}`), 'utf8')
}

/**
 * Independent parser: deliberately NOT the generator's renderer, so a bug in
 * the generator cannot hide the very drift this test exists to catch.
 */
function parseCrontab(text: string): { path: string; schedule: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const match = line.match(/^(\S+(?:\s+\S+){4})\s+(.*)$/)
      if (!match) throw new Error(`crontab line is not "<5-field schedule> <command>": ${line}`)
      const [, schedule, command] = match
      const pathMatch = command.match(/\$\{APP_URL\}(\/\S*)$/)
      if (!pathMatch) throw new Error(`crontab command does not end in \${APP_URL}<path>: ${command}`)
      return { schedule, path: pathMatch[1] }
    })
}

const expectedPaths = crons.map((c) => c.path).filter((p) => !(p in EXCLUDED_PATHS))
const expectedPathsFor = (variant: CrontabVariant) => [
  ...expectedPaths,
  ...EXTRA_JOBS[variant].map((job) => job.path),
]

describe('docker crontabs mirror vercel.json', () => {
  it.each(VARIANTS)('crontab.%s covers exactly the vercel.json path set minus exclusions, plus its EXTRA_JOBS', (variant) => {
    const actual = parseCrontab(crontabText(variant)).map((job) => job.path)

    // Sorted comparison gives a readable diff of what is missing / extra;
    // the order assertion below covers sequence separately.
    expect([...actual].sort()).toEqual([...expectedPathsFor(variant)].sort())
  })

  it.each(VARIANTS)('crontab.%s keeps vercel.json order, EXTRA_JOBS last', (variant) => {
    expect(parseCrontab(crontabText(variant)).map((job) => job.path)).toEqual(expectedPathsFor(variant))
  })

  it.each(VARIANTS)('crontab.%s runs its EXTRA_JOBS on their declared cadence', (variant) => {
    const actual = new Map(parseCrontab(crontabText(variant)).map((job) => [job.path, job.schedule]))
    for (const job of EXTRA_JOBS[variant]) {
      expect(actual.get(job.path), `schedule for extra job ${job.path}`).toBe(job.schedule)
    }
  })

  it.each(VARIANTS)('crontab.%s runs every path on its vercel.json cadence', (variant) => {
    const actual = new Map(parseCrontab(crontabText(variant)).map((job) => [job.path, job.schedule]))

    for (const cron of crons) {
      if (cron.path in EXCLUDED_PATHS) continue
      expect(actual.get(cron.path), `schedule for ${cron.path} in crontab.${variant}`).toBe(
        scheduleFor(cron, variant),
      )
    }
  })

  it.each(VARIANTS)('crontab.%s is byte-identical to the generator output', (variant) => {
    // Fails when someone hand-edits a crontab, or edits vercel.json without
    // running `npm run crontabs:generate`.
    expect(crontabText(variant)).toBe(buildCrontab(crons, variant))
  })

  it('emits LF line endings and a trailing newline (supercronic + .gitattributes)', () => {
    for (const variant of VARIANTS) {
      const raw = readFileSync(join(ROOT, 'docker', `crontab.${variant}`))
      expect(raw.includes(0x0d), `CR byte in crontab.${variant}`).toBe(false)
      expect(raw[raw.length - 1], `trailing newline in crontab.${variant}`).toBe(0x0a)
    }
  })

  it('keeps the two variants identical apart from the variant header line and the EXTRA_JOBS tail', () => {
    const hosted = crontabText('hosted').split('\n')
    const selfHosted = crontabText('self-hosted').split('\n')
    const shared = Math.min(hosted.length, selfHosted.length)
    const differing = hosted.slice(0, shared).filter((line, i) => line !== selfHosted[i])

    // Any real divergence in the shared prefix must come from
    // SCHEDULE_OVERRIDES, which is empty today. If that changes, widen this
    // expectation deliberately.
    expect(differing).toEqual([expect.stringContaining('# Variant: hosted')])

    // The self-hosted file may only be longer by its EXTRA_JOBS block: one
    // blank line, one comment line, one line per extra job.
    const extraLines = EXTRA_JOBS['self-hosted'].length
    const hostedExtraLines = EXTRA_JOBS.hosted.length
    expect(selfHosted.length - hosted.length).toBe(
      (extraLines > 0 ? extraLines + 2 : 0) - (hostedExtraLines > 0 ? hostedExtraLines + 2 : 0),
    )
  })
})

describe('EXTRA_JOBS', () => {
  it('names real cron routes that vercel.json does not schedule, each with a reason', () => {
    const scheduled = new Set(crons.map((c) => c.path))
    for (const variant of VARIANTS) {
      for (const job of EXTRA_JOBS[variant]) {
        expect(job.reason.trim().length, `${job.path} needs a reason`).toBeGreaterThan(0)
        expect(job.schedule.trim().split(/\s+/).length, `${job.path} needs a 5-field schedule`).toBe(5)
        expect(scheduled.has(job.path), `${job.path} is now in vercel.json: drop the extra entry`).toBe(false)
        expect(
          existsSync(join(ROOT, 'app', ...job.path.split('/').filter(Boolean), 'route.ts')),
          `${job.path} has no route.ts`,
        ).toBe(true)
      }
    }
  })
})

describe('exclusion and override tables', () => {
  it('lists no path that vercel.json no longer schedules', () => {
    const known = new Set(crons.map((c) => c.path))

    for (const path of Object.keys(EXCLUDED_PATHS)) {
      expect(known.has(path), `EXCLUDED_PATHS entry ${path} is stale`).toBe(true)
    }
    for (const variant of VARIANTS) {
      for (const path of Object.keys(SCHEDULE_OVERRIDES[variant])) {
        expect(known.has(path), `SCHEDULE_OVERRIDES.${variant} entry ${path} is stale`).toBe(true)
      }
    }
  })

  it('states a reason for every exclusion', () => {
    for (const [path, reason] of Object.entries(EXCLUDED_PATHS)) {
      expect(reason.trim().length, `exclusion ${path} needs a stated reason`).toBeGreaterThan(0)
    }
  })

  it('honours an exclusion and a per-variant override', () => {
    const sample: VercelCron[] = [
      { path: '/api/keep/cron', schedule: '0 1 * * *' },
      { path: '/api/drop/cron', schedule: '0 2 * * *' },
    ]
    const rendered = buildCrontab(sample, 'self-hosted', {
      excluded: { '/api/drop/cron': 'vercel-only, cannot work self-hosted' },
      overrides: { hosted: {}, 'self-hosted': { '/api/keep/cron': '*/30 * * * *' } },
      extraJobs: { hosted: [], 'self-hosted': [] },
    })
    const jobs = parseCrontab(rendered)

    expect(jobs).toEqual([{ path: '/api/keep/cron', schedule: '*/30 * * * *' }])
    expect(rendered).not.toContain('/api/drop/cron')
  })

  it('renders extra jobs after the vercel.json jobs under their own comment line', () => {
    const rendered = buildCrontab([{ path: '/api/keep/cron', schedule: '0 1 * * *' }], 'self-hosted', {
      excluded: {},
      overrides: { hosted: {}, 'self-hosted': {} },
      extraJobs: {
        hosted: [],
        'self-hosted': [{ path: '/api/only-here/cron', schedule: '17 * * * *', reason: 'test' }],
      },
    })
    expect(parseCrontab(rendered)).toEqual([
      { path: '/api/keep/cron', schedule: '0 1 * * *' },
      { path: '/api/only-here/cron', schedule: '17 * * * *' },
    ])
    expect(rendered).toContain('# self-hosted-only jobs, not in vercel.json')
    // hosted gets no tail at all when it has no extra jobs
    const hosted = buildCrontab([{ path: '/api/keep/cron', schedule: '0 1 * * *' }], 'hosted', {
      excluded: {},
      overrides: { hosted: {}, 'self-hosted': {} },
      extraJobs: { hosted: [], 'self-hosted': [] },
    })
    expect(hosted).not.toContain('not in vercel.json')
  })

  it('renders the curl invocation with unexpanded shell variables', () => {
    const rendered = buildCrontab([{ path: '/api/x/cron', schedule: '0 1 * * *' }], 'hosted', {
      excluded: {},
      overrides: { hosted: {}, 'self-hosted': {} },
    })
    expect(rendered).toContain(
      'curl -sf -H "Authorization: Bearer ${CRON_SECRET}" ${APP_URL}/api/x/cron',
    )
  })
})

describe('readVercelCrons', () => {
  it('rejects a schedule that is not five fields', () => {
    expect(() =>
      readVercelCrons(JSON.stringify({ crons: [{ path: '/api/x/cron', schedule: '0 3 * *' }] })),
    ).toThrow(/5-field/)
  })

  it('rejects a path outside /api/', () => {
    expect(() =>
      readVercelCrons(JSON.stringify({ crons: [{ path: 'api/x/cron', schedule: '0 3 * * *' }] })),
    ).toThrow(/must start with \/api\//)
  })

  it('rejects a duplicate path', () => {
    expect(() =>
      readVercelCrons(
        JSON.stringify({
          crons: [
            { path: '/api/x/cron', schedule: '0 3 * * *' },
            { path: '/api/x/cron', schedule: '0 4 * * *' },
          ],
        }),
      ),
    ).toThrow(/duplicate/)
  })
})

/**
 * Ratchet: a cron route that nothing schedules is dead code that looks alive.
 * Every app/api/**\/cron route must either be in vercel.json (and therefore in
 * both crontabs) or be named here with a reason.
 */
const INTENTIONALLY_UNSCHEDULED: Readonly<Record<string, string>> = {
  '/api/invoices/reminders/cron':
    'Feature switched off: the route is a tombstone that logs and returns 503 { disabled: true }.',
  '/api/extensions/push-notifications/cron':
    'Pre-existing gap: the docstring says daily 09:00 UTC but no schedule exists anywhere. Needs a vercel.json entry, which is outside the crontab-parity change.',
  '/api/extensions/stripe/sync/cron':
    'Pre-existing gap: the docstring says every 15 minutes but no schedule exists anywhere. Needs a vercel.json entry, which is outside the crontab-parity change.',
}

function findCronRoutes(dir: string, urlPrefix: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    // Dynamic segments cannot be scheduled: a cron needs a concrete URL.
    if (entry.name.startsWith('[')) continue
    const urlPath = `${urlPrefix}/${entry.name}`
    if (entry.name === 'cron' && existsSync(join(dir, entry.name, 'route.ts'))) {
      found.push(urlPath)
    }
    found.push(...findCronRoutes(join(dir, entry.name), urlPath))
  }
  return found
}

describe('every cron route has a schedule', () => {
  it('leaves no unscheduled cron route undocumented', () => {
    const routes = findCronRoutes(join(ROOT, 'app', 'api'), '/api')
    const scheduled = new Set([
      ...crons.map((c) => c.path),
      ...VARIANTS.flatMap((variant) => EXTRA_JOBS[variant].map((job) => job.path)),
    ])

    const orphans = routes.filter((r) => !scheduled.has(r) && !(r in INTENTIONALLY_UNSCHEDULED))
    expect(
      orphans,
      'These cron routes are scheduled nowhere. Add them to vercel.json (then run ' +
        '`npm run crontabs:generate`), or list them in INTENTIONALLY_UNSCHEDULED with a reason.',
    ).toEqual([])
  })

  it('lists no route in INTENTIONALLY_UNSCHEDULED that has since been scheduled or deleted', () => {
    const routes = new Set(findCronRoutes(join(ROOT, 'app', 'api'), '/api'))
    const scheduled = new Set(crons.map((c) => c.path))

    for (const [path, reason] of Object.entries(INTENTIONALLY_UNSCHEDULED)) {
      expect(reason.trim().length, `${path} needs a reason`).toBeGreaterThan(0)
      expect(routes.has(path), `${path} no longer exists: drop the entry`).toBe(true)
      expect(scheduled.has(path), `${path} is now in vercel.json: drop the entry`).toBe(false)
    }
  })
})

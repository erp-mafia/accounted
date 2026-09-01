#!/usr/bin/env npx tsx
/**
 * Crontab generator: emits docker/crontab.hosted and docker/crontab.self-hosted
 * from the `crons` array in vercel.json.
 *
 * vercel.json is the single source of truth for what runs on a schedule. The
 * Docker deployments run the same HTTP endpoints through supercronic, so their
 * crontabs are generated from that array instead of hand-maintained.
 *
 * Hand-maintaining them is exactly what went wrong: seven of sixteen jobs were
 * missing from Docker entirely (recurring invoices never sent, webhooks never
 * dispatched, idempotency_keys grew unbounded), /api/tax-deadlines/cron had
 * degraded from daily to "0 0 2 1 *" (once a year, on 2 January), and
 * /api/documents/verify/cron ran weekly against a daily vercel.json.
 *
 * Usage:
 *   npx tsx scripts/generate-crontabs.ts   # rewrite both crontabs
 *   npm run crontabs:generate              # same, via package.json
 *
 * scripts/__tests__/generate-crontabs.test.ts fails CI if the committed files
 * drift from vercel.json again.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const ROOT = dirname(dirname(__filename))
const VERCEL_JSON_PATH = join(ROOT, 'vercel.json')
const DOCKER_DIR = join(ROOT, 'docker')

export type CrontabVariant = 'hosted' | 'self-hosted'

export const VARIANTS: readonly CrontabVariant[] = ['hosted', 'self-hosted']

export interface VercelCron {
  path: string
  schedule: string
}

/** The compose file that bind-mounts each variant, quoted in the file header. */
const MOUNTED_BY: Record<CrontabVariant, string> = {
  hosted: 'docker-compose.hosted.yml',
  'self-hosted': 'docker-compose.yml',
}

/**
 * The invocation. `${CRON_SECRET}` and `${APP_URL}` are expanded by the shell
 * supercronic runs each job under; both come from the cron service's
 * environment in docker-compose.yml. Not a template literal on purpose: the
 * `${...}` must reach the file verbatim.
 */
const CURL_PREFIX = 'curl -sf -H "Authorization: Bearer ${CRON_SECRET}" ${APP_URL}'

/**
 * Paths in vercel.json deliberately NOT emitted into the Docker crontabs, each
 * with its reason. A silent omission is drift; this table is the only
 * sanctioned way to leave a scheduled endpoint out of a self-hosted install.
 *
 * Empty, and that is the reviewed answer rather than an oversight:
 *
 *  - Extension endpoints stay in, including extensions the self-hosted preset
 *    does not enable. docker/extensions.self-hosted.json turns on eight
 *    extensions, but the preset only drives the runtime registry: the
 *    Dockerfile builds the whole app/ tree, so every extension cron route is
 *    compiled into the image either way. And every one of them answers HTTP
 *    200 with a no-op body when its extension is unconfigured (skatteverket
 *    checks SKATTEVERKET_ENABLED, stripe checks STRIPE_SECRET_KEY plus
 *    STRIPE_CONNECT_CLIENT_ID, cloud-backup and enable-banking simply find no
 *    rows). An unused extension therefore costs one cheap request at its
 *    cadence, and a self-hoster who enables it later does not have to discover
 *    that the schedule was never there. This also matches the pre-existing
 *    intent: the hand-written crontabs already listed enable-banking and
 *    skattekonto, both of which are now in the self-hosted preset (unconfigured extensions no-op).
 *  - /api/sandbox/cleanup/cron stays in. The sandbox is a database flag
 *    (company_settings.is_sandbox), not a hosted-only build flag, and the
 *    cleanup_expired_sandbox_users RPC ships in supabase/migrations
 *    (20260311120000_sandbox_support.sql), so a self-hosted database has it.
 *    With no sandbox users it deletes 0 rows and returns 200.
 */
export const EXCLUDED_PATHS: Readonly<Record<string, string>> = {}

/**
 * Per-variant schedule overrides, path to cron expression. This is where a
 * deliberate hosted/self-hosted divergence gets recorded, so it reads as a
 * decision with a reason instead of as drift in a hand-edited file.
 *
 * Empty on both variants: every job currently runs the vercel.json cadence
 * everywhere. Two candidates were considered and rejected:
 *
 *  - /api/documents/verify/cron ran weekly ("0 3 * * 0") in the hand-written
 *    crontabs against a daily vercel.json. Not a load concession: the run is
 *    capped at 200 documents (DOCUMENT_VERIFY_BATCH_SIZE) and walks a
 *    nulls-first queue, so weekly drains the WORM integrity queue seven times
 *    slower on a check that exists to satisfy BFL 7-year retention. The weekly
 *    cadence also sat in crontab.hosted, which is not a small box (the two
 *    files were byte-identical), so it cannot have been a self-hosted
 *    concession. Treated as drift and realigned to daily.
 *  - /api/webhooks/dispatch/cron at "* * * * *" is 1440 requests/day that
 *    self-hosted was not making before. Left at parity anyway: the retry
 *    ladder in lib/webhooks/dispatcher.ts opens with a 60-second first retry,
 *    which a coarser tick would silently stretch, and each tick is one indexed
 *    query that returns immediately when nothing is due. See the load note in
 *    the generated file header.
 */
export const SCHEDULE_OVERRIDES: Readonly<
  Record<CrontabVariant, Readonly<Record<string, string>>>
> = {
  hosted: {},
  'self-hosted': {},
}

/**
 * Jobs that exist in ONE variant only and therefore have no vercel.json entry
 * (vercel.json is the hosted schedule). Each carries its reason, the same
 * discipline as EXCLUDED_PATHS: a self-hosted-only endpoint that silently
 * lacked a schedule would be dead code that looks alive.
 *
 * Rendered after the vercel.json jobs under their own comment line. The
 * crontab drift test checks both halves: the vercel.json mirror AND that
 * every EXTRA_JOBS path is a real cron route that vercel.json does NOT
 * schedule (the moment it does, the entry must go).
 */
export interface ExtraJob {
  path: string
  schedule: string
  reason: string
}

export const EXTRA_JOBS: Readonly<Record<CrontabVariant, readonly ExtraJob[]>> = {
  hosted: [],
  'self-hosted': [
    {
      path: '/api/connector/sync/cron',
      schedule: '17 * * * *',
      reason:
        'Self-hosted only: refreshes the source=connector capability grants from the instance\'s ' +
        'GNUBOK_CONNECTOR_KEY (hourly; grants carry a 72h offline grace). Hosted has no connector ' +
        'key, so the route is not in vercel.json; an instance without a key answers not_configured.',
    },
  ],
}

/** Read and shape-check the `crons` array. */
export function readVercelCrons(vercelJson: string): VercelCron[] {
  const parsed = JSON.parse(vercelJson) as { crons?: VercelCron[] }
  const crons = parsed.crons ?? []

  for (const cron of crons) {
    if (typeof cron.path !== 'string' || !cron.path.startsWith('/api/')) {
      throw new Error(`vercel.json: cron path must start with /api/, got ${JSON.stringify(cron.path)}`)
    }
    if (typeof cron.schedule !== 'string' || cron.schedule.trim().split(/\s+/).length !== 5) {
      throw new Error(
        `vercel.json: ${cron.path} needs a 5-field cron expression, got ${JSON.stringify(cron.schedule)}`,
      )
    }
  }

  const seen = new Set<string>()
  for (const cron of crons) {
    if (seen.has(cron.path)) throw new Error(`vercel.json: duplicate cron path ${cron.path}`)
    seen.add(cron.path)
  }

  return crons
}

/** The schedule a given variant should run a path on. */
export function scheduleFor(cron: VercelCron, variant: CrontabVariant): string {
  return SCHEDULE_OVERRIDES[variant][cron.path] ?? cron.schedule
}

function buildHeader(variant: CrontabVariant): string[] {
  return [
    '# AUTO-GENERATED: do not edit. Run `npm run crontabs:generate` to regenerate.',
    '#',
    `# Variant: ${variant} (bind-mounted by ${MOUNTED_BY[variant]}).`,
    '# Source of truth: the `crons` array in vercel.json. Paths, order and',
    '# cadence mirror it exactly; scripts/__tests__/generate-crontabs.test.ts',
    '# fails CI if this file drifts from it.',
    '#',
    '# Consumed by supercronic (docker/cron.Dockerfile), bind-mounted read-only',
    '# at /etc/supercronic/crontab. Times are UTC: the cron container sets no TZ',
    '# and Alpine defaults to UTC, same as Vercel Cron. supercronic skips a tick',
    '# whose previous run is still going (overlapping is off by default), so a',
    '# slow endpoint cannot pile up.',
    '#',
    '# Extension endpoints are listed unconditionally, including extensions this',
    "# image's preset does not enable. Each answers 200 with a no-op body when",
    '# its extension is unconfigured, so an unused one costs a single cheap',
    '# request, and enabling it later needs no crontab change.',
    '#',
    '# Load note: /api/webhooks/dispatch/cron runs every minute, 1440 requests a',
    '# day. Each tick is one indexed query that returns immediately when no',
    '# delivery is due, and the per-minute cadence is what makes the dispatcher',
    '# 60-second first retry actually happen after 60 seconds. Change it only',
    '# through SCHEDULE_OVERRIDES in scripts/generate-crontabs.ts, never by',
    '# editing this file.',
    '',
  ]
}

/** Render one crontab. Always LF, always newline-terminated. */
export function buildCrontab(
  crons: VercelCron[],
  variant: CrontabVariant,
  options: {
    excluded?: Readonly<Record<string, string>>
    overrides?: Readonly<Record<CrontabVariant, Readonly<Record<string, string>>>>
    extraJobs?: Readonly<Record<CrontabVariant, readonly ExtraJob[]>>
  } = {},
): string {
  const excluded = options.excluded ?? EXCLUDED_PATHS
  const overrides = options.overrides ?? SCHEDULE_OVERRIDES

  const jobs = crons
    .filter((cron) => !(cron.path in excluded))
    .map((cron) => ({
      path: cron.path,
      schedule: overrides[variant][cron.path] ?? cron.schedule,
    }))

  const extraJobs = (options.extraJobs ?? EXTRA_JOBS)[variant]

  // Align the commands: pad to the widest schedule plus two spaces, the same
  // column convention the hand-written files used.
  const width = [...jobs, ...extraJobs].reduce((max, job) => Math.max(max, job.schedule.length), 0) + 2

  const lines = [
    ...buildHeader(variant),
    ...jobs.map((job) => `${job.schedule.padEnd(width)}${CURL_PREFIX}${job.path}`),
    ...(extraJobs.length > 0
      ? [
          '',
          `# ${variant}-only jobs, not in vercel.json: see EXTRA_JOBS in scripts/generate-crontabs.ts`,
          ...extraJobs.map((job) => `${job.schedule.padEnd(width)}${CURL_PREFIX}${job.path}`),
        ]
      : []),
  ]

  return `${lines.join('\n')}\n`
}

function main(): void {
  const crons = readVercelCrons(readFileSync(VERCEL_JSON_PATH, 'utf8'))

  for (const path of Object.keys(EXCLUDED_PATHS)) {
    if (!crons.some((cron) => cron.path === path)) {
      throw new Error(`EXCLUDED_PATHS lists ${path}, which is not in vercel.json. Remove the stale entry.`)
    }
  }
  for (const variant of VARIANTS) {
    for (const path of Object.keys(SCHEDULE_OVERRIDES[variant])) {
      if (!crons.some((cron) => cron.path === path)) {
        throw new Error(
          `SCHEDULE_OVERRIDES.${variant} lists ${path}, which is not in vercel.json. Remove the stale entry.`,
        )
      }
    }
  }

  for (const variant of VARIANTS) {
    for (const job of EXTRA_JOBS[variant]) {
      if (crons.some((cron) => cron.path === job.path)) {
        throw new Error(
          `EXTRA_JOBS.${variant} lists ${job.path}, which vercel.json now schedules. Remove the extra entry.`,
        )
      }
    }
  }

  for (const variant of VARIANTS) {
    const target = join(DOCKER_DIR, `crontab.${variant}`)
    writeFileSync(target, buildCrontab(crons, variant), 'utf8')
    const emitted = crons.filter((cron) => !(cron.path in EXCLUDED_PATHS)).length + EXTRA_JOBS[variant].length
    const overridden = Object.keys(SCHEDULE_OVERRIDES[variant]).length
    console.log(
      `Wrote docker/crontab.${variant}: ${emitted} jobs` +
        (overridden > 0 ? `, ${overridden} schedule override(s)` : ''),
    )
  }

  const skipped = Object.keys(EXCLUDED_PATHS)
  if (skipped.length > 0) {
    console.log(`Excluded ${skipped.length} path(s): ${skipped.join(', ')}`)
  } else {
    console.log('No exclusions: every vercel.json cron runs on Docker too.')
  }
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main()
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

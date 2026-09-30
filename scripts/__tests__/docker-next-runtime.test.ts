import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * #3164: the self-host container served its Next.js bundle from a 400 MB
 * tmpfs at /app/.next. The bundle grew past that (470 MB in the image built
 * from e35560c), the entrypoint's cp hit ENOSPC under `set -e`, and the
 * restart policy looped it, so every install was down and cron never started.
 * A bigger tmpfs is no fix: its pages count against mem_limit (1g) and cannot
 * be reclaimed, so it trades ENOSPC for an OOM kill as the bundle keeps
 * growing. /app/.next is a named volume now, and because a volume outlives the
 * container, the entrypoint empties it before every copy.
 *
 * These tests hold that contract at PR time. The end-to-end proof is
 * scripts/self-host/smoke-boot.sh, which docker-publish.yml runs against the
 * built image before `latest` moves.
 */
const ROOT = process.cwd()
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8')

type ComposeService = {
  tmpfs?: string[]
  volumes?: string[]
  read_only?: boolean
  cap_drop?: string[]
  mem_limit?: string
}
type ComposeFile = { services: Record<string, ComposeService>; volumes?: Record<string, unknown> }

const compose = yaml.load(read('docker-compose.yml')) as ComposeFile
const app = compose.services.app

describe('docker-compose.yml: where the app serves its bundle from', () => {
  it('does not put /app/.next on a tmpfs, whatever its size', () => {
    const nextTmpfs = (app.tmpfs ?? []).filter((entry) => entry.split(':')[0] === '/app/.next')
    expect(nextTmpfs).toEqual([])
  })

  it('mounts a named volume at /app/.next that the file declares', () => {
    const mount = (app.volumes ?? []).find((entry) => entry.split(':')[1] === '/app/.next')
    expect(mount, 'no volume mounted at /app/.next').toBeDefined()
    const source = mount!.split(':')[0]
    // A bare name, not a host path: a bind mount would need a host directory
    // owned by uid 1001, which `cap_drop: ALL` cannot fix up at start.
    expect(source).toMatch(/^[a-z0-9][a-z0-9_.-]*$/)
    expect(Object.keys(compose.volumes ?? {})).toContain(source)
  })

  it('keeps the hardening the unprivileged entrypoint was built for', () => {
    expect(app.read_only).toBe(true)
    expect(app.cap_drop).toEqual(['ALL'])
    expect(app.mem_limit).toBeDefined()
  })
})

describe('docker/Dockerfile: the mount point the volume is seeded from', () => {
  it('creates /app/.next owned by nextjs with mode 750', () => {
    // Docker seeds a new named volume with the owner and mode of the image
    // directory it covers; that is what lets the entrypoint, running as
    // nextjs under cap_drop ALL, write into it.
    const dockerfile = read('docker/Dockerfile')
    expect(dockerfile).toMatch(/chown nextjs:nodejs [^\n]*\/app\/\.next(\s|$)/m)
    expect(dockerfile).toMatch(/chmod 750 \/app\/\.next(\s|$)/m)
  })
})

/**
 * The entrypoint hardcodes /app and /opt/gnubok-template, so its populate
 * section (everything between its "Populate" and "Replace" headers: the part
 * #3164 changed) is cut out, pointed at a temp root and run with sh. The rest
 * of the script (busybox sed -i, exec) is exercised by the smoke boot.
 */
function populateSection(root: string): string {
  const src = read('docker/docker-entrypoint.sh')
  const start = src.indexOf('# ─── Populate')
  const end = src.indexOf('# ─── Replace build-time placeholder')
  expect(start, 'populate header not found').toBeGreaterThan(-1)
  expect(end, 'replace header not found').toBeGreaterThan(start)
  return (
    'set -e\n' +
    src
      .slice(start, end)
      .replaceAll('/opt/gnubok-template', `${root}/opt/gnubok-template`)
      .replace(/(?<![\w.])\/app\//g, `${root}/app/`)
  )
}

function runPopulate(root: string, extraPath?: string): { status: number; stderr: string } {
  const script = path.join(root, 'populate.sh')
  writeFileSync(script, populateSection(root))
  const env = {
    PATH: extraPath ? `${extraPath}:${process.env.PATH ?? ''}` : (process.env.PATH ?? ''),
    NODE_ENV: 'test' as const,
  }
  try {
    execFileSync('sh', [script], { env, stdio: 'pipe' })
    return { status: 0, stderr: '' }
  } catch (err) {
    return {
      status: (err as { status?: number }).status ?? -1,
      stderr: String((err as { stderr?: Buffer }).stderr ?? ''),
    }
  }
}

describe('docker/docker-entrypoint.sh: populating /app/.next', () => {
  let root = ''

  function setUp() {
    root = mkdtempSync(path.join(tmpdir(), 'accounted-entrypoint-'))
    const template = path.join(root, 'opt/gnubok-template')
    mkdirSync(path.join(template, '.next/server/chunks'), { recursive: true })
    mkdirSync(path.join(template, 'public'), { recursive: true })
    writeFileSync(path.join(template, '.next/BUILD_ID'), 'new-build\n')
    writeFileSync(path.join(template, '.next/server/chunks/new.js'), 'module.exports = 2\n')
    writeFileSync(path.join(template, 'public/sw.js'), 'self.x = 1\n')
    mkdirSync(path.join(root, 'app/.next'), { recursive: true })
    mkdirSync(path.join(root, 'app/public'), { recursive: true })
  }

  afterEach(() => {
    if (!root) return
    // The previous start's copy is write-protected on purpose; give the
    // directories their write bit back so the temp tree can be removed.
    try {
      execFileSync('chmod', ['-R', 'u+w', root])
    } catch {
      // best effort
    }
    rmSync(root, { recursive: true, force: true })
    root = ''
  })

  it("replaces the previous start's write-protected copy instead of layering onto it", () => {
    setUp()
    // What a volume holds after a start of an older image: its chunks, with
    // the write bits the immutability step removed, directories included.
    const stale = path.join(root, 'app/.next/server/chunks/old-release.js')
    mkdirSync(path.dirname(stale), { recursive: true })
    writeFileSync(stale, 'module.exports = 1\n')
    writeFileSync(path.join(root, 'app/.next/BUILD_ID'), 'old-build\n')
    chmodSync(stale, 0o444)
    chmodSync(path.join(root, 'app/.next/BUILD_ID'), 0o444)
    chmodSync(path.join(root, 'app/.next/server/chunks'), 0o555)
    chmodSync(path.join(root, 'app/.next/server'), 0o555)

    const result = runPopulate(root)

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(existsSync(stale)).toBe(false)
    expect(readFileSync(path.join(root, 'app/.next/BUILD_ID'), 'utf8')).toBe('new-build\n')
    expect(existsSync(path.join(root, 'app/.next/server/chunks/new.js'))).toBe(true)
    expect(existsSync(path.join(root, 'app/.next/cache'))).toBe(true)
    expect(existsSync(path.join(root, 'app/public/sw.js'))).toBe(true)
  })

  it('sets the mount roots to mode 750 even when an older image created the volume at 755', () => {
    setUp()
    // Docker copies the image directory's mode into a named volume only at
    // creation, and images before #3164 had /app/.next at 755.
    chmodSync(path.join(root, 'app/.next'), 0o755)
    chmodSync(path.join(root, 'app/public'), 0o755)

    const result = runPopulate(root)

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(statSync(path.join(root, 'app/.next')).mode & 0o777).toBe(0o750)
    expect(statSync(path.join(root, 'app/public')).mode & 0o777).toBe(0o750)
  })

  it('stops with one readable error, naming the fix, when /app/.next cannot hold the bundle', () => {
    setUp()
    // The target reports 1 KB free, as a too-small tmpfs from an old compose
    // file effectively does once the bundle outgrows it.
    const stubs = path.join(root, 'stubs')
    mkdirSync(stubs)
    const df = path.join(stubs, 'df')
    writeFileSync(
      df,
      '#!/bin/sh\n' +
        'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"\n' +
        'echo "tmpfs 400 399 1 100% /app/.next"\n',
    )
    chmodSync(df, 0o755)

    const result = runPopulate(root, stubs)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ERROR: ')
    expect(result.stderr).toContain('/app/.next has 0 MB free')
    // The message names the volume the compose file actually declares.
    const volume = (app.volumes ?? []).find((entry) => entry.split(':')[1] === '/app/.next')!
    expect(result.stderr).toContain(`${volume.split(':')[0]} volume`)
    // Refused before copying: no per-file write errors, nothing half-copied.
    expect(result.stderr).not.toContain('cp:')
    expect(existsSync(path.join(root, 'app/.next/BUILD_ID'))).toBe(false)
  })
})

describe('docker-publish.yml: the boot smoke test gates `latest`', () => {
  type Step = { name?: string; run?: string; uses?: string; id?: string }
  const workflow = yaml.load(read('.github/workflows/docker-publish.yml')) as {
    jobs: Record<string, { steps: Step[]; needs?: string | string[] }>
  }

  it('boots every per-platform build with smoke-boot.sh before merge tags it', () => {
    const steps = workflow.jobs.build.steps
    const buildIndex = steps.findIndex((step) => step.id === 'build')
    const smokeIndex = steps.findIndex((step) => (step.run ?? '').includes('scripts/self-host/smoke-boot.sh'))
    expect(buildIndex).toBeGreaterThan(-1)
    expect(smokeIndex).toBeGreaterThan(buildIndex)
    // `merge` is the only job that applies tags, and it waits for `build`.
    expect(workflow.jobs.merge.needs).toBe('build')
  })

  it('smoke-boot.sh parses and boots the repo compose file, not hand-copied flags', () => {
    const script = path.join(ROOT, 'scripts/self-host/smoke-boot.sh')
    expect(() => execFileSync('bash', ['-n', script])).not.toThrow()
    const src = readFileSync(script, 'utf8')
    expect(src).toContain('set -euo pipefail')
    expect(src).toContain('"$REPO_ROOT/docker-compose.yml"')
    // A restart re-runs the entrypoint over a populated, write-protected
    // volume: the path every restart and upgrade takes.
    expect(src).toMatch(/compose restart app/)
  })
})

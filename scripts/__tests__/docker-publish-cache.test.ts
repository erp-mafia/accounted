import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The shipped image's final stage runs `apk upgrade` so Alpine security fixes
 * published after the pinned base digest still land. buildx replays a RUN
 * layer from the registry cache whenever its instruction text and parent are
 * unchanged, which is always the case here: the digest is pinned. Without a
 * cache exclusion for that stage the upgrade silently stops happening and
 * the daily Trivy scan stays red on OS packages nobody changed (#2055,
 * #2490). This test keeps the exclusion and the stage name in sync.
 */
const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8')

function dockerStages(dockerfile: string) {
  const stages: { name: string; body: string[] }[] = []
  for (const line of dockerfile.split('\n')) {
    const from = /^FROM\s+\S+\s+AS\s+(\S+)/i.exec(line)
    if (from) {
      stages.push({ name: from[1], body: [] })
    } else if (stages.length > 0) {
      stages[stages.length - 1].body.push(line)
    }
  }
  return stages
}

describe('docker-publish.yml layer cache vs. Dockerfile apk upgrade', () => {
  const stages = dockerStages(read('Dockerfile'))
  const shipped = stages[stages.length - 1]
  const workflow = read('.github/workflows/docker-publish.yml')

  it('the shipped stage still upgrades Alpine packages', () => {
    expect(shipped.body.some((l) => /apk\s+upgrade/.test(l))).toBe(true)
  })

  it('excludes every apk-upgrading stage that ships from the buildx cache', () => {
    const filters = /^\s*no-cache-filters:\s*(.+)$/m.exec(workflow)
    expect(filters, 'no-cache-filters missing from the build step').not.toBeNull()
    const excluded = filters![1].split(',').map((s) => s.trim())
    expect(excluded).toContain(shipped.name)
  })
})

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAnthropic, SONNET_MODEL } from './client'

// Cache pre-warm after composition: fire a max_tokens: 1 request with the
// assembled atom bodies so the Block 1 cache prefix lands warm before the
// user's first chat turn. Best-effort — if this fails, the loop still works,
// just with a cold first turn.
//
// Note: we use max_tokens: 1 (not 0). The Anthropic API requires at least
// 1 output token. Pre-warm cost is dominated by input processing, so a
// single output token is negligible.
//
// Plan ref: §6 (cache pre-warming), §10 (caching strategy).

export async function preWarmAtomCache(opts: {
  atomBodyPaths: string[]
  ttl?: '5m' | '1h'
}): Promise<void> {
  const { atomBodyPaths, ttl = '1h' } = opts

  if (atomBodyPaths.length === 0) return

  const repoRoot = process.cwd()
  const bodies: string[] = []
  for (const rel of atomBodyPaths) {
    try {
      const content = await readFile(join(repoRoot, rel), 'utf8')
      bodies.push(content)
    } catch {
      // A missing body file is non-fatal; pre-warm with what we have.
    }
  }

  if (bodies.length === 0) return

  const anthropic = getAnthropic()
  try {
    await anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 1,
      system: [
        {
          type: 'text',
          text: bodies.join('\n\n---\n\n'),
          cache_control: { type: 'ephemeral', ttl },
        },
      ],
      messages: [{ role: 'user', content: 'warmup' }],
    })
  } catch {
    // Fire-and-forget — pre-warm failure must never block the composer.
  }
}

import { getAnthropic, SONNET_MODEL } from './client'

// Cache pre-warm after composition: fire a max_tokens: 1 request with the
// assembled atom bodies so the Block 1 cache prefix lands warm before the
// user's first chat turn. Best-effort: if this fails, the loop still works,
// just with a cold first turn.
//
// Bodies come from the DB (agent_atom_registry.body), not disk, so pre-warm
// no longer depends on .claude/skills being present at runtime. In dev before
// `npm run skills:generate` has seeded bodies, the list is empty and pre-warm
// simply no-ops (a cold first turn, which is acceptable for a dev convenience).
//
// Note: we use max_tokens: 1 (not 0). The Anthropic API requires at least
// 1 output token. Pre-warm cost is dominated by input processing, so a
// single output token is negligible.
//
// Plan ref: §6 (cache pre-warming), §10 (caching strategy).

export async function preWarmAtomCache(opts: {
  atomBodies: string[]
  ttl?: '5m' | '1h'
}): Promise<void> {
  const { atomBodies, ttl = '1h' } = opts

  const bodies = atomBodies.filter((b) => b && b.length > 0)
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
    // Fire-and-forget: pre-warm failure must never block the composer.
  }
}

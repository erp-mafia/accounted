import { randomUUID } from 'node:crypto'
import { Refusal, TTL_MS } from './policy.mjs'

/** Browser state stays in memory. IDs alone never authorize access. */
export class Sessions {
  constructor(adapter, { ttl = TTL_MS, max = 4, now = Date.now } = {}) {
    this.adapter = adapter; this.ttl = ttl; this.max = max; this.now = now; this.rows = new Map()
  }
  async create(owner, organizationNumber) {
    await this.sweep()
    const existing = [...this.rows.values()].find(row => row.owner === owner)
    if (existing) return this.public(existing)
    if (this.rows.size >= this.max) throw new Refusal('CAPACITY', 429)
    const row = { id: randomUUID(), owner, expiresAt: this.now() + this.ttl, state: 'starting', busy: false }
    this.rows.set(row.id, row)
    // Reserve before opening Chromium, including concurrent requests by the same owner.
    row.opening = this.adapter.open(organizationNumber).then(async browser => {
      if (!this.rows.has(row.id)) { await browser.close(); return }
      row.browser = browser; row.state = 'login'
    }).catch(() => { row.state = 'failed'; row.error = 'BANK_UNAVAILABLE' })
    return this.public(row)
  }
  get(id, owner) {
    const row = this.rows.get(id)
    if (!row || row.owner !== owner) throw new Refusal('NOT_FOUND', 404)
    if (row.expiresAt <= this.now()) { void this.remove(id, owner); throw new Refusal('EXPIRED', 410) }
    return row
  }
  public(row) {
    return { id: row.id, expiresAt: new Date(row.expiresAt).toISOString(), state: row.state,
      ...(row.error ? { error: row.error } : {}) }
  }
  async use(id, owner, fn) {
    const row = this.get(id, owner)
    if (row.busy || row.state === 'starting') throw new Refusal('BUSY', 409)
    if (!row.browser) throw new Refusal('BANK_UNAVAILABLE', 502)
    row.busy = true
    try { return await fn(row) } finally { row.busy = false }
  }
  async remove(id, owner) {
    const row = this.rows.get(id)
    if (!row || row.owner !== owner) throw new Refusal('NOT_FOUND', 404)
    this.rows.delete(id)
    await row.browser?.close().catch(() => {})
    row.file = undefined
  }
  async sweep() {
    await Promise.all([...this.rows.values()].filter(row => row.expiresAt <= this.now()).map(row => this.remove(row.id, row.owner)))
  }
  async close() { await Promise.all([...this.rows.values()].map(row => this.remove(row.id, row.owner))) }
}

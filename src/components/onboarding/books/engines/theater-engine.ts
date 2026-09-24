/**
 * The import theater: the company's chart of accounts grows as a tree on a
 * canvas while the server writes. Four groups (tillgångar, skulder,
 * intäkter, kostnader) hang off the company; the heaviest accounts of each
 * group land as nodes; verifikat run the spine from the hub to their
 * account and ring it; counterparties hang off the accounts they belong
 * to. A register stage lets a provider join as a source node whose
 * invoices ride to the accounts they were matched to.
 *
 * Ported from the founder-approved prototype (artifact 325788b7). Canvas
 * only, no React: the component owns the element and calls the api.
 * Colours and the font come from the app's tokens at start, so dark mode
 * and the brand font follow without configuration.
 */

export interface TheaterAccount {
  number: string
  name: string
  weight: number
}

export interface TheaterParty {
  name: string
  account: string
  weight: number
  role?: string
}

export interface TheaterOptions {
  canvas: HTMLCanvasElement
  company: string
  accounts: TheaterAccount[]
  counterparties: TheaterParty[]
  onCount?: (landed: number) => void
  /** Draw the settled tree at once (reduced motion, or a re-mount after the import). */
  settled?: boolean
  groupLabels?: Partial<Record<TheaterGroup, string>>
  reviewLabel?: string
}

export interface RegisterStageConfig {
  source: string
  ms?: number
  /** [account number, invoice count] pairs: where the invoices land. */
  invoices: [string, number][]
  /** Counterparties only the register knew: they spawn as new outer nodes. */
  parties?: TheaterParty[]
  onProgress?: (r: { matched: number; review: number; done: boolean }) => void
}

export interface TheaterApi {
  spawnAccounts(): number
  feedVouchers(ms: number, total: number): void
  spawnCounterparties(): number
  pulse(): void
  registerStage(cfg: RegisterStageConfig): void
  /** Retarget the live feed's total (the real count arrived mid-run). */
  setFeedTotal(total: number): void
  /**
   * Hold the landed count at what the import job has actually written.
   * Particles keep flowing (the work is real), the number only advances
   * when the worker reports another chunk; pulse() releases it at the end.
   */
  setFeedCap(cap: number): void
  /**
   * The step is over: no more idle flows, no breathing, and once the last
   * ring and spark have faded the frame loop stops on a still tree. The
   * canvas keeps its final frame; stop() still tears everything down.
   */
  settle(): void
  stop(): void
}

export type TheaterGroup = 'tillgangar' | 'skulder' | 'intakter' | 'kostnader'

interface Group {
  side: -1 | 1
  row: -1 | 1
  label: string
  name: string
}

const GROUPS: Record<TheaterGroup, Group> = {
  tillgangar: { side: -1, row: -1, label: 'TILLGÅNGAR', name: 'tillgångar' },
  kostnader: { side: -1, row: 1, label: 'KOSTNADER', name: 'kostnader' },
  skulder: { side: 1, row: -1, label: 'SKULDER', name: 'skulder' },
  intakter: { side: 1, row: 1, label: 'INTÄKTER', name: 'intäkter' },
}

export function groupOfAccount(nr: string): TheaterGroup {
  const c = nr.charAt(0)
  return c === '1' ? 'tillgangar' : c === '2' ? 'skulder' : c === '3' ? 'intakter' : 'kostnader'
}

function rand(seed: string): number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296
}

function ease(v: number): number {
  return 1 - Math.pow(1 - v, 3)
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`
}

/** Resolve an hsl token from :root; the fallback keeps the canvas readable if a token is missing. */
export function tokenColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v ? `hsl(${v})` : fallback
}

export interface Palette {
  ink: string
  mut: string
  hair: string
  sage: string
  ochre: string
  attn: string
  paper: string
}

export function readPalette(canvas: HTMLCanvasElement): Palette {
  const ink = getComputedStyle(canvas).color || '#171717'
  return {
    ink,
    mut: tokenColor('--muted-foreground', '#666666'),
    hair: tokenColor('--border', '#dad9d5'),
    sage: tokenColor('--success', '#4d8066'),
    ochre: tokenColor('--warning', '#c58f3a'),
    attn: tokenColor('--attn', '#82602b'),
    paper: tokenColor('--background', '#ffffff'),
  }
}

export function canvasFont(canvas: HTMLCanvasElement): string {
  const f = getComputedStyle(canvas).fontFamily
  return f && f !== 'inherit' ? f : 'system-ui, sans-serif'
}

/* Layout units are px on an 860 x 480 stage; k scales them to the real stage. */
const SPAN = 1.15
const R0 = 118
const R1 = 300
const RMAX = 335

interface Node {
  kind: 'hub' | 'anchor' | 'account' | 'outer' | 'bank'
  x: number
  y: number
  r: number
  w: number
  side: number
  row: number
  born: number | null
  parent?: Node
  ph: number
  label: string
  nr?: string | null
  name?: string
  count?: number
  group?: TheaterGroup
  th?: number
  members?: TheaterAccount[] | null
  bend?: number
  showLabel?: boolean
  hit?: number
  role?: string
}

interface Edge {
  a: Node
  b: Node
  soft?: boolean
}

interface Spark {
  a: Node
  b: Node
  t0: number
}

interface Flow {
  a: Node
  m: Node
  b: Node
  p: number
  v: number
  quiet?: boolean
}

interface Ring {
  n: Node
  t0: number
  color?: string
}

interface BankFlow {
  m: boolean
  target: Node | null
  p: number
  v: number
  jit: number
  rx: number
  ry: number
}

interface BankStage {
  cfg: { total: number; matched: number; ms: number }
  targets: { node: Node; n: number }[] | null
  cb?: RegisterStageConfig['onProgress']
  node: Node
  until: number
  spawned: number
  matched: number
  review: number
  flow: BankFlow[]
  rest: { x: number; y: number; t0: number }[]
  acc: number
  lastCb: number
  done: boolean
  startAt: number
}

export function createTheater(opts: TheaterOptions): TheaterApi {
  const canvas = opts.canvas
  const onCount = opts.onCount ?? (() => {})
  const C = readPalette(canvas)
  const FONT = canvasFont(canvas)
  const groupLabel = (g: TheaterGroup) => opts.groupLabels?.[g] ?? GROUPS[g].label
  const reviewLabel = opts.reviewLabel ?? 'att granska'
  const clumpBelow = 20
  const maxAccounts = 7
  const maxCpsPerGroup = 4
  const maxCps = 16

  const nodes: Node[] = []
  const edges: Edge[] = []
  const byNr: Record<string, Node> = {}
  const hub: Node = { kind: 'hub', x: 0, y: 0, r: 5.5, w: 0, side: 0, row: 0, born: null, ph: 0, label: opts.company }
  nodes.push(hub)
  const anchors: Partial<Record<TheaterGroup, Node>> = {}
  ;(Object.keys(GROUPS) as TheaterGroup[]).forEach((g) => {
    const G = GROUPS[g]
    const a: Node = { kind: 'anchor', group: g, x: G.side * 80, y: G.row * 40, r: 0, w: 0, side: G.side, row: G.row, born: null, parent: hub, ph: rand(g) * 6.28, label: groupLabel(g) }
    nodes.push(a)
    anchors[g] = a
    edges.push({ a: hub, b: a })
  })

  const accounts = opts.accounts.filter((a) => a.weight > 0)
  let maxW = 0
  accounts.forEach((a) => { maxW = Math.max(maxW, a.weight) })
  if (maxW === 0) maxW = 1
  ;(Object.keys(GROUPS) as TheaterGroup[]).forEach((g) => {
    const G = GROUPS[g]
    const all = accounts.filter((a) => groupOfAccount(a.number) === g).sort((a, b) => b.weight - a.weight)
    const keep = all.filter((a, i) => a.weight >= clumpBelow && i < maxAccounts)
    const small = all.filter((a, i) => a.weight < clumpBelow || i >= maxAccounts)
    const items: { nr: string | null; name: string; count: number; label: string; members: TheaterAccount[] | null }[] =
      keep.map((a) => ({ nr: a.number, name: a.name, count: a.weight, label: `${a.number} ${trunc(a.name, 22)}`, members: null }))
    if (small.length) {
      let sum = 0
      small.forEach((a) => { sum += a.weight })
      items.push({ nr: null, name: `Övriga ${G.name}`, count: sum, label: `Övriga ${G.name} (${small.length})`, members: small })
    }
    // A group with nothing at all still gets a quiet anchor: the tree keeps its four arms.
    const th0 = Math.atan2(G.row, G.side)
    const n = items.length
    items.forEach((it, i) => {
      const w = Math.pow(it.count / maxW, 0.45)
      const seed = it.label
      const th = th0 - SPAN / 2 + SPAN * ((i * 0.618034 + rand(`${seed}a`) * 0.18) % 1)
      const rad = R0 + (n > 1 ? i / (n - 1) : 0.5) * (R1 - R0) + (rand(`${seed}r`) - 0.5) * 50
      const node: Node = { kind: 'account', nr: it.nr, name: it.name, count: it.count, group: g, x: Math.cos(th) * rad, y: Math.sin(th) * rad, th, r: 1.5 + w * 3.1, w: 0.3 + w, side: G.side, row: G.row, born: null, parent: anchors[g], ph: rand(`${seed}p`) * 6.28, label: it.label, members: it.members, bend: (rand(`${seed}b`) - 0.5) * 36 }
      nodes.push(node)
      if (it.nr) byNr[it.nr] = node
      else it.members?.forEach((a) => { byNr[a.number] = node })
      edges.push({ a: anchors[g] as Node, b: node })
    })
  })

  // Counterparties: their own column outside the accounts, one slot each.
  const twigs: Record<string, number> = {}
  const perGroup: Partial<Record<TheaterGroup, number>> = {}
  function placeParty(c: TheaterParty, p: Node): Node {
    const g = p.group as TheaterGroup
    const G = GROUPS[g]
    const kth = (twigs[c.account] = (twigs[c.account] ?? 0) + 1)
    const th = (p.th ?? 0) + (kth - 1.5) * 0.22 + (rand(`${c.name}a`) - 0.5) * 0.2
    const rad = Math.hypot(p.x, p.y) + 42 + kth * 10 + rand(`${c.name}r`) * 18
    return { kind: 'outer', name: c.name, role: c.role ?? 'motpart', count: c.weight, group: g, x: Math.cos(th) * rad, y: Math.sin(th) * rad, th, r: 1.0 + Math.min(1, c.weight / 62) * 1.6, w: 0.2, side: G.side, row: G.row, born: null, parent: p, ph: rand(`${c.name}p`) * 6.28, label: trunc(c.name, 18), bend: (rand(`${c.name}b`) - 0.5) * 20 }
  }
  opts.counterparties.slice().sort((a, b) => b.weight - a.weight).slice(0, maxCps).forEach((c) => {
    const p = byNr[c.account]
    if (!p || p.members) return
    const g = p.group as TheaterGroup
    perGroup[g] = (perGroup[g] ?? 0) + 1
    if ((perGroup[g] ?? 0) > maxCpsPerGroup) return
    const node = placeParty(c, p)
    nodes.push(node)
    edges.push({ a: p, b: node })
  })

  const labelBoxes: { x0: number; y0: number; x1: number; y1: number }[] = []
  function labelBox(n: Node) {
    const tw = n.label.length * (n.kind === 'account' ? 5.9 : 5.6)
    const rr = n.r * 1.5
    const lx = n.x + n.side * (rr + 6)
    const x0 = n.side < 0 ? lx - tw : lx
    return { x0: x0 - 4, y0: n.y - 8, x1: x0 + tw + 4, y1: n.y + 8 }
  }
  function labelFits(n: Node): boolean {
    const box = labelBox(n)
    const ok = !labelBoxes.some((o) => box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0)
    if (ok) labelBoxes.push(box)
    return ok
  }
  function clamp(n: Node) {
    const tw = n.label.length * 5.8 + 14
    const maxX = 425 - tw
    if (n.x * n.side < 62) n.x = 62 * n.side
    if (n.x * n.side > maxX) n.x = maxX * n.side
    if (n.y * n.row < 22) n.y = 22 * n.row
    if (n.y * n.row > 226) n.y = 226 * n.row
    const rr = Math.hypot(n.x, n.y)
    if (rr > RMAX) { n.x *= RMAX / rr; n.y *= RMAX / rr }
  }
  ;(function relax() {
    // Names need 15 px of vertical air unless far apart sideways; every node stays in its quadrant.
    const movable = nodes.filter((n) => n.kind === 'account' || n.kind === 'outer')
    for (let iter = 0; iter < 90; iter++) {
      for (let i = 0; i < movable.length; i++) {
        for (let j = i + 1; j < movable.length; j++) {
          const a = movable[i], b = movable[j]
          if (a.group !== b.group) continue
          const dx = b.x - a.x, dy = b.y - a.y
          const ex = dx / 150, ey = dy / 16
          const d = Math.hypot(ex, ey)
          if (d >= 1 || d === 0) continue
          const push = (1 - d) * 0.5
          const sy = dy === 0 ? (rand(a.label + b.label) < 0.5 ? -1 : 1) : Math.sign(dy)
          a.y -= sy * push * 16 * 0.9
          b.y += sy * push * 16 * 0.9
          a.x -= Math.sign(dx || 1) * push * 6
          b.x += Math.sign(dx || 1) * push * 6
        }
      }
      movable.forEach(clamp)
    }
    movable.forEach((n) => { n.th = Math.atan2(n.y, n.x) })
    movable
      .slice()
      .sort((a, b) => Number(a.kind === 'outer') - Number(b.kind === 'outer') || b.w - a.w)
      .forEach((n) => { n.showLabel = labelFits(n) })
  })()

  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const settled = !!opts.settled
  const eng = {
    sparks: [] as Spark[],
    flow: [] as Flow[],
    rings: [] as Ring[],
    t0: performance.now(),
    pulse: 0,
    landed: 0,
    perParticle: 8,
    feedUntil: 0,
    feedTotal: 0,
    feedCap: Infinity,
    doneAt: 0,
    timers: [] as number[],
    alive: true,
    last: 0,
    spawnAcc: 0,
    quietAcc: 0,
    lastCount: 0,
    bank: null as BankStage | null,
    raf: 0,
  }
  hub.born = performance.now()
  if (reduced || settled) nodes.forEach((n) => { n.born = performance.now() - 5000 })
  if (!settled && !reduced) {
    ;(Object.keys(anchors) as TheaterGroup[]).forEach((g) => {
      eng.timers.push(window.setTimeout(() => {
        const a = anchors[g]
        if (!a || !eng.alive) return
        a.born = performance.now()
        eng.sparks.push({ a: hub, b: a, t0: performance.now() })
      }, 420))
    })
  }

  function spawnKind(kind: Node['kind'], spacing: number): number {
    const list = nodes.filter((n) => n.kind === kind).sort((a, b) => b.w - a.w)
    if (reduced || settled) {
      list.forEach((n) => { n.born = performance.now() - 5000 })
      return 0
    }
    list.forEach((n, i) => {
      eng.timers.push(window.setTimeout(() => {
        if (!eng.alive) return
        n.born = performance.now()
        eng.sparks.push({ a: n.parent ?? hub, b: n, t0: performance.now() })
      }, i * spacing))
    })
    return list.length * spacing
  }

  const api: TheaterApi = {
    spawnAccounts: () => spawnKind('account', 60),
    feedVouchers: (ms, total) => {
      eng.feedTotal = total
      if (reduced) {
        eng.landed = Math.min(total, eng.feedCap)
        onCount(eng.landed)
        return
      }
      eng.feedUntil = performance.now() + ms
      eng.perParticle = Math.max(1, Math.round(total / 160))
    },
    spawnCounterparties: () => spawnKind('outer', 60),
    pulse: () => {
      // The import is done: release the count and end the feed, so the
      // particles settle instead of flowing for the rest of the window.
      eng.pulse = performance.now()
      eng.feedUntil = eng.pulse
      eng.feedCap = Infinity
      eng.landed = eng.feedTotal || eng.landed
      onCount(eng.landed)
    },
    setFeedTotal: (total) => {
      eng.feedTotal = total
      eng.perParticle = Math.max(1, Math.round(total / 160))
    },
    settle: () => {
      eng.doneAt = performance.now()
      eng.feedUntil = eng.doneAt
    },
    setFeedCap: (cap) => {
      eng.feedCap = Math.max(0, cap)
      if (eng.landed > eng.feedCap) eng.landed = eng.feedCap
      if (reduced) {
        eng.landed = Math.min(eng.feedTotal, eng.feedCap)
        onCount(eng.landed)
      }
    },
    registerStage: (cfg) => {
      // The provider joins the tree as a source node; its invoices ride to
      // the accounts they belong to (all of them land: they are matched to
      // the verifikat already here); every counterparty the vouchers already
      // knew is confirmed with a ring; the ones only the register knew spawn.
      const now = performance.now()
      const src: Node = { kind: 'bank', x: -412, y: 0, r: 4.5, w: 0, side: -1, row: 0, born: now, ph: 0, label: cfg.source }
      nodes.push(src)
      edges.push({ a: hub, b: src })
      eng.sparks.push({ a: hub, b: src, t0: now })
      const tgts: { node: Node; n: number }[] = []
      cfg.invoices.forEach(([nr, n]) => {
        const node = byNr[nr]
        if (node && n > 0) tgts.push({ node, n })
      })
      const total = tgts.reduce((s, t) => s + t.n, 0)
      const ms = cfg.ms ?? 3000
      eng.bank = { cfg: { total, matched: total, ms }, targets: tgts.length ? tgts : null, cb: cfg.onProgress, node: src, until: now + ms, spawned: 0, matched: 0, review: 0, flow: [], rest: [], acc: 0, lastCb: 0, done: total === 0, startAt: now + 900 }
      if (total === 0) cfg.onProgress?.({ matched: 0, review: 0, done: true })
      const known = nodes.filter((n) => n.kind === 'outer' && n.born != null)
      known.forEach((n, i) => {
        eng.timers.push(window.setTimeout(() => {
          if (!eng.alive) return
          n.hit = performance.now()
          if (eng.rings.length < 60) eng.rings.push({ n, t0: performance.now(), color: C.sage })
        }, 700 + i * 90))
      })
      ;(cfg.parties ?? []).forEach((c, i) => {
        const p = byNr[c.account]
        if (!p || p.members) return
        const node = placeParty(c, p)
        clamp(node)
        node.showLabel = labelFits(node)
        nodes.push(node)
        edges.push({ a: p, b: node })
        eng.timers.push(window.setTimeout(() => {
          if (!eng.alive) return
          node.born = performance.now()
          eng.sparks.push({ a: p, b: node, t0: performance.now() })
        }, 900 + known.length * 90 + i * 220))
      })
    },
    stop: () => {
      eng.alive = false
      eng.timers.forEach((id) => window.clearTimeout(id))
      if (eng.raf) cancelAnimationFrame(eng.raf)
      document.removeEventListener('visibilitychange', onVisible)
    },
  }

  let mouse: { x: number; y: number } | null = null
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect()
    mouse = { x: e.clientX - r.left, y: e.clientY - r.top }
  })
  canvas.addEventListener('mouseleave', () => { mouse = null })

  function onVisible() {
    if (!document.hidden && eng.alive) {
      eng.last = 0
      eng.raf = requestAnimationFrame(draw)
    }
  }
  document.addEventListener('visibilitychange', onVisible)

  function draw() {
    if (!eng.alive || !canvas.isConnected) return
    if (document.hidden) return
    const wrap = canvas.parentElement
    const W = wrap?.clientWidth ?? 0, H = wrap?.clientHeight ?? 0
    if (!W || !H) { eng.raf = requestAnimationFrame(draw); return }
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const now = performance.now()
    const dt = Math.min(0.05, (now - (eng.last || now)) / 1000)
    eng.last = now
    const k = Math.min(W / 860, H / 480)
    const cx = W / 2, cy = H / 2
    const t = (now - eng.t0) / 1000
    const age = (n: Node) => (n.born == null ? 0 : Math.min(1, (now - n.born) / 520))
    const grow = reduced ? 1 : 1 + 0.012 * Math.sin(now / 3200)
    const local = (n: Node) => {
      const d = n.kind === 'hub' ? 0 : n.kind === 'anchor' ? 1.2 : 2.2
      return { x: (n.x * grow + Math.sin(now / 2900 + n.ph) * d * 0.6) * k, y: (n.y * grow + Math.cos(now / 3700 + n.ph * 1.3) * d * 0.5) * k }
    }
    const world = (n: Node) => { const p = local(n); return { x: cx + p.x, y: cy + p.y } }
    const bl = 400 * k
    ctx.save()
    ctx.translate(cx, cy)
    const ripple = now % 6000 < 2400 ? ((now % 6000) / 2400) * 400 * k : -1
    function curveTo(pa: { x: number; y: number }, pb: { x: number; y: number }, bend: number, p: number) {
      const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2
      const dx = pb.x - pa.x, dy = pb.y - pa.y
      const len = Math.hypot(dx, dy) || 1
      const cxp = mx - (dy / len) * bend * k, cyp = my + (dx / len) * bend * k
      ctx!.beginPath()
      ctx!.moveTo(pa.x, pa.y)
      const steps = 12
      for (let s = 1; s <= steps; s++) {
        const u = (s / steps) * p
        const x = (1 - u) * (1 - u) * pa.x + 2 * (1 - u) * u * cxp + u * u * pb.x
        const y = (1 - u) * (1 - u) * pa.y + 2 * (1 - u) * u * cyp + u * u * pb.y
        ctx!.lineTo(x, y)
      }
    }
    edges.forEach((e) => {
      if (e.a.born == null || e.b.born == null) return
      const p = ease(age(e.b))
      const pa = local(e.a), pb = local(e.b)
      const mid = Math.hypot((pa.x + pb.x) / 2, (pa.y + pb.y) / 2)
      const glow = ripple < 0 ? 0 : Math.max(0, 1 - Math.abs(mid - ripple) / (50 * k))
      ctx.strokeStyle = C.hair
      ctx.lineWidth = e.soft ? 0.6 : 0.8
      ctx.globalAlpha = (e.soft ? 0.45 : 0.8) + 0.2 * glow
      curveTo(pa, pb, e.b.bend ?? 0, p)
      ctx.stroke()
    })
    ctx.globalAlpha = 1
    eng.sparks = eng.sparks.filter((sp) => {
      const p = (now - sp.t0) / 520
      if (p >= 1) return false
      const pa = local(sp.a), pb = local(sp.b)
      const q = ease(p)
      ctx.fillStyle = C.ink
      ctx.globalAlpha = 0.9 * (1 - p * 0.5)
      ctx.beginPath()
      ctx.arc(pa.x + (pb.x - pa.x) * q, pa.y + (pb.y - pa.y) * q, 1.4 * k, 0, Math.PI * 2)
      ctx.fill()
      return true
    })
    ctx.globalAlpha = 1
    // Verifikat: born at the hub, they run the spine to their account and land there.
    const feeding = now < eng.feedUntil
    // Settled: the pulse rings get 900 ms, then the tree goes still.
    const done = eng.doneAt > 0 && now - eng.doneAt > 900
    eng.spawnAcc += dt * 45
    const spawnN = Math.floor(eng.spawnAcc)
    eng.spawnAcc -= spawnN
    for (let sp = 0; sp < spawnN; sp++) {
      if (!feeding || eng.flow.length >= 80) break
      const live = nodes.filter((n) => n.kind === 'account' && n.born != null)
      if (!live.length) break
      let pickW = Math.random() * live.reduce((s, n) => s + (n.count ?? 0), 0)
      let target = live[0]
      for (let i = 0; i < live.length; i++) { pickW -= live[i].count ?? 0; if (pickW <= 0) { target = live[i]; break } }
      eng.flow.push({ a: hub, m: target.parent ?? hub, b: target, p: 0, v: 0.85 + Math.random() * 0.6 })
    }
    eng.quietAcc += dt * 20
    const quietN = Math.floor(eng.quietAcc)
    eng.quietAcc -= quietN
    for (let qn = 0; qn < quietN; qn++) {
      if (feeding || done || t <= 2.5 || eng.flow.length >= 40 || reduced) break
      const outer = nodes.filter((n) => n.kind === 'outer' && n.born != null)
      if (!outer.length) break
      const o = outer[Math.floor(Math.random() * outer.length)]
      if (!o.parent || !o.parent.parent) break
      eng.flow.push({ a: o, m: o.parent, b: o.parent.parent, p: 0, v: 0.36 + Math.random() * 0.36, quiet: true })
    }
    eng.flow = eng.flow.filter((f) => {
      f.p += f.v * dt
      if (f.p >= 1) {
        if (!f.quiet) {
          eng.landed = Math.min(eng.feedTotal, eng.feedCap, eng.landed + eng.perParticle)
          if (now - eng.lastCount > 120) { eng.lastCount = now; onCount(eng.landed) }
          f.b.hit = now
          if (eng.rings.length < 60) eng.rings.push({ n: f.b, t0: now })
        }
        return false
      }
      const pa = local(f.a), pm = local(f.m), pb = local(f.b)
      let q: number, x: number, y: number
      if (f.p < 0.4) { q = f.p / 0.4; x = pa.x + (pm.x - pa.x) * q; y = pa.y + (pm.y - pa.y) * q }
      else { q = (f.p - 0.4) / 0.6; x = pm.x + (pb.x - pm.x) * q; y = pm.y + (pb.y - pm.y) * q }
      ctx.fillStyle = f.quiet ? C.mut : C.ink
      ctx.globalAlpha = (f.quiet ? 0.45 : 0.8) * Math.sin(Math.min(1, f.p * 3) * Math.PI / 2)
      ctx.beginPath()
      ctx.arc(x, y, (f.quiet ? 1.0 : 1.3) * k, 0, Math.PI * 2)
      ctx.fill()
      return true
    })
    ctx.globalAlpha = 1
    eng.rings = eng.rings.filter((rg) => {
      const p = (now - rg.t0) / 720
      if (p >= 1) return false
      const q = local(rg.n)
      const rr = (rg.n.r * 1.5 + 3 + 14 * ease(p)) * k
      ctx.strokeStyle = rg.color ?? C.ink
      ctx.lineWidth = 0.8
      ctx.globalAlpha = (rg.color ? 0.6 : 0.35) * (1 - p)
      ctx.beginPath()
      ctx.arc(q.x, q.y, rr, 0, Math.PI * 2)
      ctx.stroke()
      return true
    })
    ctx.globalAlpha = 1
    nodes.forEach((n) => {
      if (n.born == null || n.kind === 'anchor' || n.kind === 'bank') return
      const p = ease(age(n))
      const q = local(n)
      const splat = p < 1 ? 1 + 0.35 * Math.sin(p * Math.PI) : 1
      const hit = n.hit ? Math.max(0, 1 - (now - n.hit) / 500) : 0
      const breathe = (done ? 1 : 1 + 0.08 * Math.sin(now / 2400 + n.ph)) + 0.35 * hit
      const r = n.r * p * k * 1.5 * splat * breathe
      ctx.fillStyle = C.ink
      ctx.globalAlpha = n.kind === 'outer' ? 0.55 : 0.9
      ctx.beginPath()
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2)
      ctx.fill()
    })
    ctx.globalAlpha = 1
    if (eng.bank) {
      const B = eng.bank
      const bn = B.node
      const pb = local(bn)
      const pB = ease(age(bn))
      // The source node: an outlined circle, its name beneath.
      ctx.strokeStyle = C.mut
      ctx.lineWidth = 1
      ctx.globalAlpha = pB
      ctx.beginPath()
      ctx.arc(pb.x, pb.y, bn.r * k * 1.5 * (pB < 1 ? 1 + 0.35 * Math.sin(pB * Math.PI) : 1), 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillStyle = C.ink
      ctx.font = `500 11px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillText(bn.label, pb.x, pb.y + 20)
      ctx.globalAlpha = 1
      const feedingB = now > B.startAt && B.spawned < B.cfg.total
      if (feedingB) B.acc += dt * (B.cfg.total / (B.cfg.ms / 1000))
      const nB = Math.floor(B.acc)
      const liveB = nodes.filter((n) => n.kind === 'account')
      const totalCount = liveB.reduce((s, n) => s + (n.count ?? 0), 0)
      for (let bi = 0; bi < nB; bi++) {
        if (!feedingB || B.flow.length >= 160 || B.spawned >= B.cfg.total) break
        B.acc -= 1
        const isMatch = (B.spawned * 7919) % B.cfg.total < B.cfg.matched
        B.spawned++
        let target: Node | null = null
        if (isMatch) {
          if (B.targets) {
            const idx = B.spawned - 1
            let accT = 0
            for (let ti = 0; ti < B.targets.length; ti++) { accT += B.targets[ti].n; if (idx < accT) { target = B.targets[ti].node; break } }
            if (!target) target = B.targets[B.targets.length - 1].node
          } else if (liveB.length && totalCount > 0) {
            let pw = Math.random() * totalCount
            target = liveB[0]
            for (let li = 0; li < liveB.length; li++) { pw -= liveB[li].count ?? 0; if (pw <= 0) { target = liveB[li]; break } }
          } else if (liveB.length) {
            target = liveB[Math.floor(Math.random() * liveB.length)]
          }
        }
        B.flow.push({ m: isMatch && !!target, target, p: 0, v: 0.9 + Math.random() * 0.4, jit: (Math.random() - 0.5) * 34, rx: (Math.random() - 0.5) * 80, ry: (Math.random() - 0.5) * 18 })
      }
      B.flow = B.flow.filter((f) => {
        f.p += f.v * dt
        let x: number, y: number, q: number
        if (f.p < 0.45) { q = f.p / 0.45; x = pb.x * (1 - q); y = pb.y * (1 - q) + f.jit * k * Math.sin(q * Math.PI) }
        else {
          q = (f.p - 0.45) / 0.55
          if (f.m && f.target) {
            const pa = local(f.target.parent ?? hub), pt = local(f.target)
            if (q < 0.4) { const q1 = q / 0.4; x = pa.x * q1; y = pa.y * q1 }
            else { const q2 = (q - 0.4) / 0.6; x = pa.x + (pt.x - pa.x) * q2; y = pa.y + (pt.y - pa.y) * q2 }
          } else {
            const ex = f.rx * k, ey = (150 + f.ry) * k
            const qe = ease(q)
            x = ex * qe; y = ey * qe
          }
        }
        if (f.p >= 1) {
          if (f.m && f.target) {
            B.matched++
            f.target.hit = now
            if (eng.rings.length < 60) eng.rings.push({ n: f.target, t0: now, color: C.sage })
          } else {
            B.review++
            B.rest.push({ x: f.rx, y: 150 + f.ry, t0: now })
          }
          if (now - B.lastCb > 120) { B.lastCb = now; B.cb?.({ matched: B.matched, review: B.review, done: false }) }
          return false
        }
        ctx.fillStyle = f.m ? C.ink : C.ochre
        ctx.globalAlpha = 0.85 * Math.sin(Math.min(1, f.p * 4) * Math.PI / 2)
        ctx.beginPath()
        ctx.arc(x, y, 1.4 * k, 0, Math.PI * 2)
        ctx.fill()
        return true
      })
      ctx.globalAlpha = 1
      B.rest.forEach((r) => {
        const a = Math.min(1, (now - r.t0) / 400)
        ctx.fillStyle = C.ochre
        ctx.globalAlpha = 0.85 * a
        ctx.beginPath()
        ctx.arc(r.x * k + Math.sin(now / 2600 + r.x) * 0.6, r.y * k + Math.cos(now / 3100 + r.y) * 0.5, 1.7 * k, 0, Math.PI * 2)
        ctx.fill()
      })
      ctx.globalAlpha = 1
      if (B.review > 0) {
        ctx.fillStyle = C.attn
        ctx.font = `500 11px ${FONT}`
        ctx.textAlign = 'center'
        ctx.fillText(`${B.review} ${reviewLabel}`, 0, 176 * k)
      }
      if (!B.done && B.spawned >= B.cfg.total && B.flow.length === 0) {
        B.done = true
        eng.pulse = now
        B.cb?.({ matched: B.matched, review: B.review, done: true })
      }
    }
    ctx.font = `10.5px ${FONT}`
    nodes.forEach((n) => {
      if (n.born == null || !n.showLabel) return
      const p = ease(age(n))
      const a = Math.max(0, p * 1.4 - 0.4)
      if (a <= 0) return
      const q = local(n)
      const rr = n.r * k * 1.5
      const isAcc = n.kind === 'account'
      if (!isAcc) ctx.font = `10px ${FONT}`
      ctx.textAlign = n.side < 0 ? 'right' : 'left'
      ctx.fillStyle = isAcc ? C.ink : C.mut
      ctx.globalAlpha = a * (isAcc ? 0.88 : 0.8)
      ctx.fillText(n.label, q.x + n.side * (rr + 6), q.y + 3.5)
      ctx.globalAlpha = 1
      if (!isAcc) ctx.font = `10.5px ${FONT}`
    })
    // The four groups head their columns.
    ;(Object.keys(anchors) as TheaterGroup[]).forEach((g) => {
      const a = anchors[g]
      if (!a || a.born == null) return
      const p = ease(age(a))
      const G = GROUPS[g]
      ctx.fillStyle = C.mut
      ctx.font = `600 9px ${FONT}`
      ctx.textAlign = G.side < 0 ? 'left' : 'right'
      ctx.globalAlpha = p
      ctx.fillText(a.label, G.side * (bl - 2), G.row * (H / 2 - 10) + (G.row < 0 ? 4 : 0))
      ctx.globalAlpha = 1
    })
    ctx.fillStyle = C.ink
    ctx.beginPath()
    ctx.arc(0, 0, 5.5 * k * 1.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    ctx.font = `500 13px ${FONT}`
    ctx.textAlign = 'center'
    const nw = ctx.measureText(hub.label).width
    ctx.fillStyle = C.paper
    ctx.globalAlpha = 0.9
    ctx.fillRect(cx - nw / 2 - 6, cy + 22, nw + 12, 18)
    ctx.globalAlpha = 1
    ctx.fillStyle = C.ink
    ctx.fillText(hub.label, cx, cy + 35)
    if (eng.pulse) {
      const pp = Math.min(1, (now - eng.pulse) / 1000)
      if (pp < 1) {
        ctx.strokeStyle = C.sage
        ctx.globalAlpha = (1 - pp) * 0.5
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.arc(cx, cy, 14 + pp * 380 * k, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = 1
      }
    }
    // Hover: the detail behind the name.
    if (mouse) {
      let best: Node | null = null
      let bd = 12 * k
      nodes.forEach((n) => {
        if (n.born == null || n.kind === 'anchor' || n.kind === 'hub' || n.kind === 'bank') return
        const q = world(n)
        const d = Math.hypot(q.x - mouse!.x, q.y - mouse!.y)
        if (d < bd) { bd = d; best = n }
      })
      if (best) {
        const bn = best as Node
        const q = world(bn)
        const line1 = bn.kind === 'account' ? (bn.nr ? `${bn.nr} ${bn.name}` : bn.name ?? '') : bn.name ?? ''
        const line2 = bn.kind === 'account'
          ? (bn.members ? `${bn.members.map((m) => m.number).join(', ')} · ${bn.count} verifikat` : `${bn.count} verifikat`)
          : `${bn.role} · ${bn.count} verifikat`
        ctx.font = `500 11px ${FONT}`
        const w1 = ctx.measureText(line1).width
        ctx.font = `10.5px ${FONT}`
        const w2 = ctx.measureText(line2).width
        const bw = Math.max(w1, w2) + 16, bh = 34
        const bx = Math.min(W - bw - 4, Math.max(4, q.x - bw / 2))
        let by = q.y - bh - 10
        if (by < 4) by = q.y + 12
        ctx.fillStyle = C.paper
        ctx.strokeStyle = C.hair
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.roundRect(bx, by, bw, bh, 6)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = C.ink
        ctx.font = `500 11px ${FONT}`
        ctx.textAlign = 'left'
        ctx.fillText(line1, bx + 8, by + 14)
        ctx.fillStyle = C.mut
        ctx.font = `10.5px ${FONT}`
        ctx.fillText(line2, bx + 8, by + 27)
      }
    }
    // Still frame: nothing left in motion, or four seconds past settle
    // whatever is left. The frame just drawn stays on the canvas.
    const quietNow = !eng.flow.length && !eng.rings.length && !eng.sparks.length
    if (done && (quietNow || now - eng.doneAt > 4000)) { eng.raf = 0; return }
    eng.raf = requestAnimationFrame(draw)
  }
  eng.raf = requestAnimationFrame(draw)
  return api
}

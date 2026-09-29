export const meta = {
  name: 'design-scan',
  description: 'Scan an app area against the Accounted design system; adversarially verify findings; report the survivors.',
  phases: [
    { title: 'Enumerate' },
    { title: 'Scan' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
}

// Usage: Workflow({ name: 'design-scan', args: { area: 'bookkeeping' } })
// Pattern: fan-out (one agent per page) -> adversarial verify (skeptic per finding) -> synthesize.
// This workflow only PRODUCES verified findings. The calling session dedupes + files any
// GitHub issues (workflow agents shouldn't take high-privilege outward actions).

const area = (args && args.area) || 'dashboard'

const DESIGN_CONTRACT = `Judge strictly against .claude/rules/design.md (the LOCKED Accounted design system):
editorial monochrome; spacing tokens only (1,2,3,4,6,8,10,12: p-5/2.5/hardcoded px are violations);
status colors via <Badge variant> only (no bg-blue-100 / bg-emerald-500/10 as chrome); use the
primitives PageHeader/Table/EmptyState/Skeleton/InfoTooltip (hand-rolled equivalents are violations);
Hedvig serif display must NOT be font-medium; financial numbers need tabular-nums; motion is
transition-colors only (no press-scale/hover-lift/spring); a11y WCAG AA, aria-label on icon buttons,
visible focus, touch targets >=40px. Locked 2026-07 migration conventions (numbered list in design.md):
frame layout with pill Buttons (per-call-site rounded-* overrides are violations); cards flat and
shadow-free (shadow-* on a card is a violation; overlays keep shadows); one-line table rows (sub-rows
are violations); chips mark exceptions only (same Badge on every row is a violation); attention is one
.attn sentence, banners are violations; help behind the "?" popover after the H1; one context picker
far right in the toolbar (FyPicker/ContextPicker); confirm-up-front dialogs, not outcome text written
into the page; .stagger-enter on list entry; settings tabs use the Fonster row language (flat hairline
rows, switches, dirty-only sticky save bar). A "finding" must cite file:line and the exact rule it breaks.`

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'file', 'rule', 'problem', 'fix', 'severity'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string', description: 'path:line' },
          rule: { type: 'string', description: 'which design.md rule it breaks' },
          problem: { type: 'string' },
          fix: { type: 'string', description: 'concrete before -> after' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isReal', 'reason'],
  properties: {
    isReal: { type: 'boolean', description: 'true only if a real regression against the LOCKED system, not a nitpick or a matter of taste' },
    reason: { type: 'string' },
  },
}

// 1. Enumerate the pages/components in the area.
phase('Enumerate')
const PAGE_LIST_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pages'],
  properties: { pages: { type: 'array', items: { type: 'string' }, description: 'route or component file paths in this area' } },
}
const enumerated = await agent(
  `List the distinct page/route files and their primary child components for the "${area}" area of this Next.js app ` +
  `(look under app/(dashboard)/${area} and components/${area} and any obviously related components). ` +
  `Return concrete file paths a reviewer should open. Keep it to the ~8 most important.`,
  { label: `enumerate:${area}`, phase: 'Enumerate', schema: PAGE_LIST_SCHEMA }
)
const pages = (enumerated?.pages || []).slice(0, 8)
log(`Scanning ${pages.length} pages/components in "${area}"`)

// 2+3. Pipeline: scan each page, then adversarially verify each finding as soon as that page's scan lands.
const perPage = await pipeline(
  pages,
  (file) => agent(
    `Review this file for design-system compliance and UX quality: ${file}\n\n${DESIGN_CONTRACT}\n\n` +
    `Read the file (and imports it renders). Report only concrete, defensible findings with file:line.`,
    { label: `scan:${file}`, phase: 'Scan', schema: FINDINGS_SCHEMA }
  ),
  (scan, file) => parallel((scan?.findings || []).map((f) => () =>
    agent(
      `Adversarially verify this design finding. Default to isReal=false unless it is clearly a real ` +
      `regression against the LOCKED design system (not taste, not a pre-existing site-wide pattern).\n\n` +
      `${DESIGN_CONTRACT}\n\nFinding: ${JSON.stringify(f)}\nFile: ${file}`,
      { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA }
    ).then((v) => ({ ...f, verdict: v }))
  ))
)

// 4. Synthesize: keep only verified findings, rank by severity, cap at 6.
phase('Synthesize')
const sevRank = { high: 0, medium: 1, low: 2 }
const confirmed = perPage
  .flat()
  .filter(Boolean)
  .filter((f) => f.verdict?.isReal)
  .sort((a, b) => (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3))

const kept = confirmed.slice(0, 6)
const dropped = confirmed.length - kept.length
if (dropped > 0) log(`Capped: reporting ${kept.length} findings, dropped ${dropped} lower-severity ones (raise the cap to see them).`)

return {
  area,
  pagesScanned: pages.length,
  findings: kept,
  note: 'Dedupe these against open and closed issues (state:all) before filing any; see .claude/loops.md for the fingerprint convention.',
}

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

// Offline only: combines the two read-only SQL exports. No credentials,
// network, or mutation capability. Selection is explicit per company.
const [previewPath, linksPath, selectionPath, outputPath] = process.argv.slice(2)
if (!outputPath) throw new Error('Usage: build-repair-review.mjs preview.json links.json selection.json output.json')
const preview = JSON.parse(readFileSync(previewPath, 'utf8'))
const links = JSON.parse(readFileSync(linksPath, 'utf8'))
const selection = JSON.parse(readFileSync(selectionPath, 'utf8'))
const groups = preview.groups ?? preview
if (!Array.isArray(groups) || !Array.isArray(links)) throw new Error('Expected SQL-export arrays')
const candidates = [], excluded = []
for (const group of groups) {
  const policy = selection[group.company_id]
  if (!group.complete_content_matches || group.entries.length !== 2 || !['earlier','later'].includes(policy)) {
    excluded.push({...group,reason:!group.complete_content_matches ? 'Different accounting content' : 'Explicit two-copy selection required'})
    continue
  }
  const sorted = [...group.entries].sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id))
  const reverse = sorted[policy === 'earlier' ? 0 : 1]
  const keep = sorted[policy === 'earlier' ? 1 : 0]
  candidates.push({companyId:group.company_id,periodId:group.fiscal_period_id,
    sourceSeries:group.source_voucher_series,sourceNumber:group.source_voucher_number,
    reverse,keep,contentHash:reverse.content_hash,
    reverseLinks:links.filter(link=>link.entry_id===reverse.id),keepLinks:links.filter(link=>link.entry_id===keep.id)})
}
const review = {version:1,generatedAt:new Date().toISOString(),sourceCapturedAt:preview.generatedAt,
  treatment:'storno',productionApproved:false,selection,candidates,excluded}
review.reviewHash = createHash('sha256').update(JSON.stringify(review)).digest('hex')
writeFileSync(outputPath,JSON.stringify(review,null,2)+'\n')
console.log(JSON.stringify({candidates:candidates.length,excluded:excluded.length,reviewHash:review.reviewHash}))

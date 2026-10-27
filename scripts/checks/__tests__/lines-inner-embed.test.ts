/**
 * Proof that the lines-inner-embed guard catches a journal_entry_lines read
 * filtered through a journal_entries!inner embed, leaves the entry-first and
 * other-table shapes alone, and that the repository holds no such read
 * outside the shrinking allowlist.
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  findLinesInnerEmbeds,
  findLinesInnerEmbedsInSource as scan,
  LINES_INNER_EMBED_ALLOWED,
} from '../lines-inner-embed.mjs'

describe('lines-inner-embed', () => {
  it('flags a lines read with a journal_entries!inner embed, aliased or not, on any line of the chain', () => {
    expect(
      scan(`supabase.from('journal_entry_lines').select('journal_entry_id, journal_entries!inner(company_id, status)').eq('journal_entries.company_id', id)`),
    ).toEqual([{ line: 1, select: 'journal_entry_id, journal_entries!inner(company_id, status)' }])
    expect(
      scan(`const a = 1\nawait supabase\n  .from("journal_entry_lines")\n  .select(\n    'id, entry:journal_entries!inner(entry_date)'\n  )`),
    ).toEqual([{ line: 3, select: 'id, entry:journal_entries!inner(entry_date)' }])
  })

  it('leaves the entry-first reads and other tables alone', () => {
    // Lines by entry id (lib/bookkeeping/entry-lines.ts).
    expect(scan(`supabase.from('journal_entry_lines').select('id, account_number').in('journal_entry_id', chunk)`)).toEqual([])
    // The parent side with its lines embedded: planned from journal_entries.
    expect(scan(`supabase.from('journal_entries').select('id, lines:journal_entry_lines(account_number)').eq('company_id', id)`)).toEqual([])
    // A journal_entries!inner embed from another table starts from that table.
    expect(
      scan(`supabase.from('kontantmetod_cutoff_entries').select('kind, entry:journal_entries!inner(id, lines:journal_entry_lines(account_number))')`),
    ).toEqual([])
    // A plain (left) embed from the lines does not filter through the parent.
    expect(scan(`supabase.from('journal_entry_lines').select('id, journal_entries(entry_date)').in('journal_entry_id', ids)`)).toEqual([])
  })

  it('checks each chain on its own select, not the next chain in the file', () => {
    const source = [
      `await supabase.from('journal_entry_lines').select('id').in('journal_entry_id', ids)`,
      `await supabase.from('kontantmetod_cutoff_entries').select('kind, entry:journal_entries!inner(id)')`,
    ].join('\n')
    expect(scan(source)).toEqual([])
  })

  it('the repository holds none outside the allowlist, and the allowlist has no stale entry', () => {
    const findings = findLinesInnerEmbeds(path.resolve(__dirname, '..', '..', '..', 'src'))
    const files = new Set(findings.map((f: { file: string }) => f.file))
    expect(findings.filter((f: { file: string }) => !LINES_INNER_EMBED_ALLOWED.has(f.file))).toEqual([])
    expect([...LINES_INNER_EMBED_ALLOWED].filter((file) => !files.has(file))).toEqual([])
  })
})

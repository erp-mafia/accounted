/**
 * Proof that the ambiguous-embed ratchet catches the shape that shipped twice
 * and leaves both legitimate hint forms alone. Offending fixtures live only in
 * these strings and in an OS temp directory the end-to-end cases create and
 * delete.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  deriveAmbiguousPairs,
  findAmbiguousEmbeds,
  findAmbiguousEmbedsInSource,
  pairKey,
  parseEmbeds,
} from '../ambiguous-embed.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

const tempRoot = (prefix: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(root)
  return root
}

const write = (root: string, rel: string, content: string) => {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

// Only the pair this guard exists for. Every other pair the fixtures embed
// (journal_entries -> journal_entry_lines, transactions -> journal_entries) is
// absent from the set, which is exactly how a single-foreign-key pair looks to
// the scanner: it must never be flagged.
const PAIRS = new Set([pairKey('journal_entries', 'fiscal_periods')])

const scan = (source: string) =>
  findAmbiguousEmbedsInSource(source, 'fixture.ts', PAIRS).map(
    (f: { from: string; target: string }) => `${f.from}->${f.target}`,
  )

describe('ambiguous-embed: the shape that shipped', () => {
  it('flags an ALIASED embed with no relationship named', () => {
    // lib/core/documents/supplier-invoice-underlag.ts as it shipped 2026-07-27.
    // A tokenizer that only looks for `<table>(` after a comma, space or paren
    // misses this, which is the whole reason the bug survived two reviews.
    expect(
      scan(
        `const { data } = await supabase
           .from('journal_entries')
           .select('id, status, fiscal_period:fiscal_periods(is_closed, locked_at)')`,
      ),
    ).toEqual(['journal_entries->fiscal_periods'])
  })

  it('flags the bare, unaliased embed too', () => {
    expect(scan(`supabase.from('journal_entries').select('id, fiscal_periods(is_closed)')`)).toEqual(
      ['journal_entries->fiscal_periods'],
    )
  })

  it('flags the embed written in the other direction', () => {
    expect(
      scan(`supabase.from('fiscal_periods').select('id, journal_entries(voucher_number)')`),
    ).toEqual(['fiscal_periods->journal_entries'])
  })
})

describe('ambiguous-embed: both hint forms PostgREST accepts', () => {
  it('accepts the constraint name', () => {
    // lib/transactions/inbox-underlag.ts, lib/pending-operations/commit.ts.
    expect(
      scan(
        `supabase.from('journal_entries').select('id, fiscal_period:fiscal_periods!journal_entries_fiscal_period_id_fkey(is_closed, locked_at)')`,
      ),
    ).toEqual([])
  })

  it('accepts the foreign key COLUMN name', () => {
    // lib/import/opening-balance/cascade.ts, lib/invoices/invoice-matching.ts.
    // A `*_fkey`-only matcher would hard-fail six legitimate lines here.
    expect(
      scan(
        `supabase.from('fiscal_periods').select('id, opening_balance_entry:journal_entries!opening_balance_entry_id(voucher_series, voucher_number)')`,
      ),
    ).toEqual([])
  })

  it('accepts a hint combined with a join modifier, in either order', () => {
    expect(
      scan(
        `supabase.from('journal_entries').select('id, fiscal_periods!journal_entries_fiscal_period_id_fkey!inner(is_closed)')`,
      ),
    ).toEqual([])
    expect(
      scan(
        `supabase.from('journal_entries').select('id, fiscal_periods!inner!journal_entries_fiscal_period_id_fkey(is_closed)')`,
      ),
    ).toEqual([])
  })

  it('does NOT accept a bare join modifier: !inner disambiguates nothing', () => {
    expect(
      scan(`supabase.from('journal_entries').select('id, fiscal_periods!inner(is_closed)')`),
    ).toEqual(['journal_entries->fiscal_periods'])
    expect(
      scan(`supabase.from('journal_entries').select('id, fiscal_periods!left(is_closed)')`),
    ).toEqual(['journal_entries->fiscal_periods'])
  })
})

describe('ambiguous-embed: chain resolution', () => {
  it('resolves .from() through its OWN chain, not the nearest one above', () => {
    // scripts/seed-demo-account.ts: a journal_entries!inner embed from
    // journal_entry_lines (a single-foreign-key pair) sits below an unrelated
    // .from('journal_entries'). Pairing by proximity flags it wrongly.
    const source = `
      await supabase.from('journal_entries').select('id, voucher_number')
      await supabase
        .from('journal_entry_lines')
        .select('account_number, debit, journal_entries!inner(entry_date)')
        .eq('company_id', companyId)
    `
    expect(scan(source)).toEqual([])
  })

  it('reads a select anywhere in the chain, before or after the filters', () => {
    expect(
      scan(
        `supabase.from('journal_entries').select('id, fiscal_periods(is_closed)').eq('company_id', id).in('id', ids)`,
      ),
    ).toEqual(['journal_entries->fiscal_periods'])
  })

  it('ignores a select whose from-table cannot be resolved statically', () => {
    expect(scan(`query.select('id, fiscal_periods(is_closed)')`)).toEqual([])
    expect(scan(`supabase.from(tableName).select('id, fiscal_periods(is_closed)')`)).toEqual([])
  })
})

describe('ambiguous-embed: nesting', () => {
  it('resolves a nested embed against its enclosing embed, not the root', () => {
    // transactions -> journal_entries is a single-foreign-key pair here, so the
    // inner fiscal_periods embed is what must be judged, against journal_entries.
    const nested = `supabase.from('transactions').select('id, journal_entries(id, fiscal_periods(is_closed))')`
    expect(scan(nested)).toEqual(['journal_entries->fiscal_periods'])
  })

  it('leaves the enclosing embed alone when the inner one is hinted', () => {
    expect(
      scan(
        `supabase.from('transactions').select('id, journal_entries(id, fiscal_periods!journal_entries_fiscal_period_id_fkey(is_closed))')`,
      ),
    ).toEqual([])
  })

  it('parses plain columns, casts and json paths without inventing embeds', () => {
    expect(parseEmbeds('id, amount::text, metadata->>ref, *', 'journal_entries')).toEqual([])
  })
})

describe('ambiguous-embed: pair derivation from the migration history', () => {
  const migrationsRoot = (files: Record<string, string>) => {
    const root = tempRoot('ambiguous-embed-sql-')
    for (const [name, sql] of Object.entries(files)) write(root, name, sql)
    return root
  }

  it('counts a pair as ambiguous once a second foreign key joins it', () => {
    const dir = migrationsRoot({
      '20240101000001_core.sql': `
        CREATE TABLE public.journal_entries (
          id UUID PRIMARY KEY,
          fiscal_period_id UUID REFERENCES public.fiscal_periods(id)
        );
      `,
    })
    expect(deriveAmbiguousPairs(dir).size).toBe(0)

    const dir2 = migrationsRoot({
      '20240101000001_core.sql': `
        CREATE TABLE public.journal_entries (
          id UUID PRIMARY KEY,
          fiscal_period_id UUID REFERENCES public.fiscal_periods(id)
        );
      `,
      '20240101000019_period_closing.sql': `
        ALTER TABLE public.fiscal_periods
          ADD COLUMN closing_entry_id UUID REFERENCES public.journal_entries(id);
      `,
    })
    expect([...deriveAmbiguousPairs(dir2)]).toEqual([pairKey('fiscal_periods', 'journal_entries')])
  })

  it('collapses the idempotent re-adds the migration history is full of', () => {
    const dir = migrationsRoot({
      '20240101000001_a.sql': `
        ALTER TABLE public.journal_entry_lines
          ADD CONSTRAINT journal_entry_lines_cost_center_id_fkey
          FOREIGN KEY (cost_center_id) REFERENCES public.cost_centers(id);
      `,
      '20240101000002_b.sql': `
        ALTER TABLE public.journal_entry_lines
          ADD CONSTRAINT journal_entry_lines_cost_center_id_fkey
          FOREIGN KEY (cost_center_id) REFERENCES public.cost_centers(id);
      `,
    })
    expect(deriveAmbiguousPairs(dir).size).toBe(0)
  })

  it('honours DROP COLUMN, DROP CONSTRAINT and DROP TABLE', () => {
    const base = `
      CREATE TABLE public.a (
        id UUID PRIMARY KEY,
        b_one_id UUID REFERENCES public.b(id),
        b_two_id UUID REFERENCES public.b(id)
      );
    `
    expect([...deriveAmbiguousPairs(migrationsRoot({ '1_a.sql': base }))]).toEqual([pairKey('a', 'b')])

    expect(
      deriveAmbiguousPairs(
        migrationsRoot({ '1_a.sql': base, '2_b.sql': `ALTER TABLE public.a DROP COLUMN b_two_id;` }),
      ).size,
    ).toBe(0)

    expect(
      deriveAmbiguousPairs(
        migrationsRoot({
          '1_a.sql': base,
          '2_b.sql': `ALTER TABLE public.a DROP CONSTRAINT IF EXISTS a_b_two_id_fkey;`,
        }),
      ).size,
    ).toBe(0)

    expect(
      deriveAmbiguousPairs(
        migrationsRoot({ '1_a.sql': base, '2_b.sql': `DROP TABLE IF EXISTS public.b;` }),
      ).size,
    ).toBe(0)
  })

  it('matches the live schema on the real migration history', () => {
    // Verified against prod (pwxtzglxptnnvjrpixpg) on 2026-09-01 with the
    // pg_constraint query in ambiguous-embed.mjs: the same 15 pairs.
    const pairs = deriveAmbiguousPairs(
      path.join(__dirname, '..', '..', '..', 'supabase', 'migrations'),
    )
    expect(pairs.has(pairKey('journal_entries', 'fiscal_periods'))).toBe(true)
    expect(pairs.has(pairKey('journal_entries', 'salary_runs'))).toBe(true)
    expect(pairs.has(pairKey('supplier_invoices', 'transactions'))).toBe(true)
    // Single-foreign-key pairs that legitimate code embeds without a hint.
    expect(pairs.has(pairKey('journal_entries', 'journal_entry_lines'))).toBe(false)
    expect(pairs.has(pairKey('supplier_invoice_payments', 'supplier_invoices'))).toBe(false)
    expect(pairs.has(pairKey('tax_assessment_notices', 'fiscal_periods'))).toBe(false)
  })
})

describe('ambiguous-embed: file scan', () => {
  it('reports offenders relative to the root and skips test files', () => {
    const root = tempRoot('ambiguous-embed-')
    write(
      root,
      'supabase/migrations/20240101000019_period_closing.sql',
      `
        CREATE TABLE public.journal_entries (
          id UUID PRIMARY KEY,
          fiscal_period_id UUID REFERENCES public.fiscal_periods(id)
        );
        ALTER TABLE public.fiscal_periods
          ADD COLUMN closing_entry_id UUID REFERENCES public.journal_entries(id);
      `,
    )
    const bad = `supabase.from('journal_entries').select('id, fiscal_period:fiscal_periods(is_closed)')`
    const good = `supabase.from('journal_entries').select('id, fiscal_periods!journal_entries_fiscal_period_id_fkey(is_closed)')`
    write(root, 'lib/bad.ts', bad)
    write(root, 'lib/good.ts', good)
    write(root, 'lib/__tests__/bad.test.ts', bad)
    write(root, 'lib/bad.test.ts', bad)
    write(root, 'app/api/x/route.ts', `${good}\n${bad}`)

    expect(findAmbiguousEmbeds(root)).toEqual([
      { where: 'app/api/x/route.ts:2', from: 'journal_entries', target: 'fiscal_periods' },
      { where: 'lib/bad.ts:1', from: 'journal_entries', target: 'fiscal_periods' },
    ])
  })

  it('finds nothing when no pair is ambiguous, whatever the code embeds', () => {
    const root = tempRoot('ambiguous-embed-single-')
    write(
      root,
      'supabase/migrations/1_core.sql',
      `CREATE TABLE public.journal_entries (id UUID PRIMARY KEY, fiscal_period_id UUID REFERENCES public.fiscal_periods(id));`,
    )
    write(
      root,
      'lib/fine.ts',
      `supabase.from('journal_entries').select('id, fiscal_period:fiscal_periods(is_closed)')`,
    )
    expect(findAmbiguousEmbeds(root)).toEqual([])
  })
})

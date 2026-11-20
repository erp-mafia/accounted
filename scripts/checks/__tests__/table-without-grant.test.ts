/**
 * Proof that the table-without-grant guard flags a new public relation that
 * no migration grants, accepts the grant shapes this repo writes, and is not
 * fooled by example SQL inside comments, string literals or dollar-quoted
 * bodies. Offending fixtures live only in these strings and in an OS temp
 * directory the end-to-end case creates and deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  analyzeMigration,
  findTablesWithoutGrant,
  grandfatheredFiles,
  grantHint,
  sanitizeSql,
} from '../table-without-grant.mjs'

type Finding = ReturnType<typeof analyzeMigration>[number]

const analyze = (sql: string, existing = new Set<string>()): Finding[] =>
  analyzeMigration(sql, 'fixture.sql', existing)

const ROOT = path.resolve(__dirname, '..', '..', '..')

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('table-without-grant: the shape Supabase stops granting on 2026-10-30', () => {
  it('flags a public table created with RLS and policies but no GRANT', () => {
    // The common shape of the grandfathered migrations: RLS on, policies
    // written, access left to the platform default that is going away.
    const findings = analyze(`
      CREATE TABLE public.widget_notes (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        company_id uuid NOT NULL REFERENCES public.companies(id)
      );
      ALTER TABLE public.widget_notes ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "view" ON public.widget_notes FOR SELECT USING (company_id IN (SELECT user_company_ids()));
    `)
    expect(findings).toEqual([
      {
        file: 'fixture.sql',
        line: 2,
        kind: 'missing-grant',
        relation: 'widget_notes',
        relationKind: 'table',
        roles: ['service_role', 'authenticated'],
        rowSecurity: true,
      },
    ])
  })

  it('tells the author the exact lines to add, for the missing roles only', () => {
    const [finding] = analyze(`
      CREATE TABLE widget_notes (id uuid PRIMARY KEY);
      GRANT SELECT ON widget_notes TO authenticated;
    `)
    expect(finding.roles).toEqual(['service_role'])
    expect(grantHint(finding)).toEqual([
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.widget_notes TO service_role;',
      'or, if a role must not reach it: -- no-grant: service_role on public.widget_notes (<reason>)',
    ])
  })

  it('flags a table that is dropped and created again: a plain CREATE always starts from the default ACL', () => {
    const findings = analyze('DROP TABLE public.old_thing; CREATE TABLE public.old_thing (id int);', new Set(['old_thing']))
    expect(findings.map((f) => f.relation)).toEqual(['old_thing'])
  })

  it.each([
    ['a table', 'DROP TABLE IF EXISTS public.email_links; CREATE TABLE IF NOT EXISTS public.email_links (id uuid PRIMARY KEY);', 'email_links'],
    ['a view', 'DROP VIEW IF EXISTS public.v_summary CASCADE; CREATE OR REPLACE VIEW public.v_summary AS SELECT 1 AS x;', 'v_summary'],
    ['a materialized view', 'DROP MATERIALIZED VIEW public.mv_totals; CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_totals AS SELECT 1 AS x;', 'mv_totals'],
    ['a sequence', 'DROP SEQUENCE IF EXISTS public.counter; CREATE SEQUENCE IF NOT EXISTS public.counter;', 'counter'],
  ])('flags %s that is dropped, then re-created with IF NOT EXISTS / OR REPLACE', (_label, sql, relation) => {
    // The re-created relation starts from the empty default ACL: its old
    // grants went with the DROP.
    const existing = new Set(['email_links', 'v_summary', 'mv_totals', 'counter'])
    expect(analyze(sql, existing).map((f) => f.relation)).toEqual([relation])
  })

  it('forgets grants made before a DROP in the same file', () => {
    const findings = analyze(`
      CREATE TABLE public.t (id uuid PRIMARY KEY);
      GRANT ALL ON public.t TO service_role, authenticated;
      DROP TABLE public.t;
      CREATE TABLE public.t (id uuid PRIMARY KEY, note text);
    `)
    expect(findings.map((f) => [f.relation, f.line])).toEqual([['t', 5]])
  })

  it('does not flag a scratch table the same migration creates and drops', () => {
    expect(analyze('CREATE TABLE public.scratch (id int); INSERT INTO public.scratch VALUES (1); DROP TABLE public.scratch;')).toEqual([])
  })

  it('remembers a DROP from an earlier migration', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twg-'))
    tempDirs.push(root)
    const dir = path.join(root, 'supabase', 'migrations')
    fs.mkdirSync(dir, { recursive: true })
    const granted = 'GRANT ALL ON public.a TO service_role, authenticated;'
    fs.writeFileSync(path.join(dir, '20260101000000_a.sql'), `CREATE TABLE public.a (id int); ${granted}`)
    fs.writeFileSync(path.join(dir, '20260102000000_b.sql'), 'DROP TABLE public.a;')
    fs.writeFileSync(path.join(dir, '20260103000000_c.sql'), 'CREATE TABLE IF NOT EXISTS public.a (id int);')
    expect(findTablesWithoutGrant(root).map((f: Finding) => [f.file, f.relation])).toEqual([
      ['supabase/migrations/20260103000000_c.sql', 'a'],
    ])
  })

  it('reads the DDL inside a DO block, which runs with the migration', () => {
    const findings = analyze(`
      DO $$
      BEGIN
        IF to_regclass('public.brand_new') IS NULL THEN
          CREATE TABLE public.brand_new (id uuid PRIMARY KEY);
        END IF;
      END
      $$;
      DO LANGUAGE plpgsql $body$ BEGIN CREATE TABLE public.second (id int); END $body$;
    `)
    expect(findings.map((f) => [f.relation, f.line])).toEqual([
      ['brand_new', 5],
      ['second', 9],
    ])
  })

  it('accepts grants and waivers made inside a DO block', () => {
    expect(
      analyze(`
        DO $$
        BEGIN
          -- no-grant: authenticated on public.brand_new (service-role only: the cron writes it)
          CREATE TABLE IF NOT EXISTS public.brand_new (id uuid PRIMARY KEY);
          GRANT SELECT, INSERT ON public.brand_new TO service_role;
        EXCEPTION WHEN duplicate_table THEN NULL;
        END
        $$;
      `),
    ).toEqual([])
  })

  it('flags a new view and a new sequence', () => {
    const findings = analyze(`
      CREATE VIEW public.widget_totals AS SELECT 1 AS n;
      CREATE SEQUENCE public.widget_counter;
    `)
    expect(findings.map((f) => [f.relation, f.relationKind])).toEqual([
      ['widget_totals', 'view'],
      ['widget_counter', 'sequence'],
    ])
    expect(grantHint(findings[0])).toContain('GRANT SELECT ON public.widget_totals TO service_role;')
  })

  it('requires a new sequence to be granted to both roles', () => {
    const [finding] = analyze(`
      CREATE SEQUENCE public.widget_counter;
      GRANT USAGE, SELECT ON SEQUENCE public.widget_counter TO service_role;
    `)
    expect(finding.roles).toEqual(['authenticated'])
    expect(grantHint(finding)[0]).toBe('GRANT USAGE, SELECT ON SEQUENCE public.widget_counter TO authenticated;')
  })
})

describe('table-without-grant: the hint never hands authenticated rows RLS does not guard', () => {
  it('asks for RLS before the authenticated grant on a table that has none', () => {
    const [finding] = analyze('CREATE TABLE public.t (id uuid PRIMARY KEY); GRANT ALL ON public.t TO service_role;')
    expect(finding.rowSecurity).toBe(false)
    expect(grantHint(finding)).toEqual([
      'ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;  -- first, with policies: without RLS the authenticated grant hands every signed-in user every row',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.t TO authenticated;  -- keep only what its RLS policies allow',
      'or, if a role must not reach it: -- no-grant: authenticated on public.t (<reason>)',
    ])
  })

  it('asks for security_invoker before the authenticated grant on a view', () => {
    const [plain] = analyze('CREATE VIEW public.v AS SELECT 1 AS n;')
    expect(grantHint(plain)).toEqual([
      'ALTER VIEW public.v SET (security_invoker = true);  -- first: otherwise the view reads its tables as its owner and skips their RLS',
      'GRANT SELECT ON public.v TO service_role;',
      'GRANT SELECT ON public.v TO authenticated;',
      'or, if a role must not reach it: -- no-grant: service_role, authenticated on public.v (<reason>)',
    ])
    for (const sql of [
      'CREATE VIEW public.v WITH (security_invoker = true) AS SELECT 1 AS n;',
      'CREATE VIEW public.v AS SELECT 1 AS n; ALTER VIEW public.v SET (security_invoker = on);',
    ]) {
      const [finding] = analyze(`${sql} GRANT SELECT ON public.v TO service_role;`)
      expect(finding.rowSecurity).toBe(true)
      expect(grantHint(finding)[0]).toBe('GRANT SELECT ON public.v TO authenticated;')
    }
  })

  it('warns that a materialized view has no RLS at all', () => {
    const [finding] = analyze('CREATE MATERIALIZED VIEW public.mv AS SELECT 1 AS n;')
    expect(finding.relationKind).toBe('materialized view')
    expect(grantHint(finding)[1]).toBe(
      'GRANT SELECT ON public.mv TO authenticated;  -- only if every signed-in user may read every row: RLS does not apply to a materialized view',
    )
  })
})

describe('table-without-grant: the grant shapes this repo writes', () => {
  it.each([
    ['one statement, both roles', 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.t TO authenticated, service_role;'],
    ['TABLE keyword, one statement per role', 'GRANT SELECT ON TABLE public.t TO authenticated; GRANT ALL ON TABLE public.t TO service_role;'],
    ['a list of tables', 'GRANT SELECT ON public.other, public.t TO authenticated; GRANT ALL ON public.other,public.t TO service_role;'],
    ['a column-level grant', 'GRANT SELECT ON public.t TO authenticated; GRANT UPDATE(outcome, claimed_at) ON public.t TO service_role;'],
    ['quoted names and mixed case', 'grant select on "t" to AUTHENTICATED; Grant All On Public.T To Service_Role With Grant Option;'],
  ])('accepts %s', (_label, grants) => {
    expect(analyze(`CREATE TABLE public.t (id uuid PRIMARY KEY); ${grants}`)).toEqual([])
  })

  it('accepts a reasoned waiver for a role that must not reach the table', () => {
    expect(
      analyze(`
        -- no-grant: authenticated on public.t (service-role only: the cron writes it, nobody reads it)
        CREATE TABLE public.t (id uuid PRIMARY KEY);
        REVOKE ALL ON public.t FROM PUBLIC, anon, authenticated;
        GRANT SELECT, INSERT ON public.t TO service_role;
      `),
    ).toEqual([])
  })

  it('accepts REVOKE ALL from a role as that role\'s explicit decision (a service-role-only table)', () => {
    // The shape of 20260929200000_peppol_alerts: closed to the session roles by
    // an executed statement rather than a comment.
    expect(
      analyze(`
        CREATE TABLE public.t (id uuid PRIMARY KEY);
        ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;
        REVOKE ALL ON TABLE public.t FROM PUBLIC, anon, authenticated;
        GRANT ALL ON TABLE public.t TO service_role;
      `),
    ).toEqual([])
    expect(analyze('CREATE TABLE public.t (id bigserial PRIMARY KEY); REVOKE ALL PRIVILEGES ON public.t FROM authenticated, service_role;')).toEqual([])
  })

  it.each([
    ['a partial revoke, which assumes the rest of the old default grant', 'REVOKE DELETE, TRUNCATE ON public.t FROM authenticated;'],
    ['a GRANT OPTION FOR revoke', 'REVOKE GRANT OPTION FOR ALL ON public.t FROM authenticated;'],
    ['a bulk revoke that names no table', 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;'],
    ['a revoke on another table', 'REVOKE ALL ON public.other FROM authenticated;'],
  ])('still flags the role after %s', (_label, revoke) => {
    const findings = analyze(`CREATE TABLE public.t (id uuid PRIMARY KEY); GRANT ALL ON public.t TO service_role; ${revoke}`)
    expect(findings.map((f) => f.roles)).toEqual([['authenticated']])
  })

  it('forgets a REVOKE ALL made before a DROP in the same file', () => {
    const findings = analyze(`
      CREATE TABLE public.t (id uuid PRIMARY KEY);
      REVOKE ALL ON public.t FROM authenticated;
      GRANT ALL ON public.t TO service_role;
      DROP TABLE public.t;
      CREATE TABLE public.t (id uuid PRIMARY KEY);
      GRANT ALL ON public.t TO service_role;
    `)
    expect(findings.map((f) => f.roles)).toEqual([['authenticated']])
  })

  it('refuses a waiver without a reason', () => {
    const findings = analyze(`
      -- no-grant: authenticated, service_role on public.t ()
      CREATE TABLE public.t (id uuid PRIMARY KEY);
    `)
    expect(findings[0].roles).toEqual(['service_role', 'authenticated'])
  })

  it('does not count a grant to anon or to postgres as a grant to the required roles', () => {
    const findings = analyze('CREATE TABLE public.t (id int); GRANT ALL ON public.t TO anon, postgres;')
    expect(findings[0].roles).toEqual(['service_role', 'authenticated'])
  })
})

describe('table-without-grant: serial keys need their sequence granted', () => {
  it('flags a bigserial column with no grant on its sequence', () => {
    const findings = analyze(`
      CREATE TABLE public.log (seq bigserial PRIMARY KEY, body text);
      GRANT SELECT, INSERT ON public.log TO authenticated, service_role;
    `)
    expect(findings).toEqual([
      {
        file: 'fixture.sql',
        line: 2,
        kind: 'serial-without-grant',
        relation: 'log',
        sequence: 'log_seq_seq',
        roles: ['service_role', 'authenticated'],
      },
    ])
  })

  it('flags a serial column added to an existing table, the table that works today', () => {
    const findings = analyze(`
      ALTER TABLE public.invoices ADD COLUMN seq_no bigserial;
      ALTER TABLE ONLY public.invoices ADD COLUMN IF NOT EXISTS n2 serial2, ADD n8 serial8;
    `)
    expect(findings.map((f) => [f.kind, f.sequence, f.line])).toEqual([
      ['serial-without-grant', 'invoices_seq_no_seq', 2],
      ['serial-without-grant', 'invoices_n2_seq', 3],
      ['serial-without-grant', 'invoices_n8_seq', 3],
    ])
  })

  it('accepts the serial2/4/8 spellings only with their sequence granted', () => {
    const table = 'CREATE TABLE public.s8 (id serial8 PRIMARY KEY); GRANT ALL ON public.s8 TO service_role, authenticated;'
    expect(analyze(table).map((f) => f.sequence)).toEqual(['s8_id_seq'])
    expect(analyze(`${table} GRANT USAGE, SELECT ON SEQUENCE public.s8_id_seq TO service_role, authenticated;`)).toEqual([])
  })

  it('requires the sequence grant per role, and honours the table waiver for a role', () => {
    const [finding] = analyze(`
      CREATE TABLE public.t2 (id bigserial PRIMARY KEY);
      GRANT ALL ON public.t2 TO service_role, authenticated;
      GRANT USAGE ON SEQUENCE public.t2_id_seq TO service_role;
    `)
    expect(finding.roles).toEqual(['authenticated'])
    expect(grantHint(finding)[0]).toBe('GRANT USAGE, SELECT ON SEQUENCE public.t2_id_seq TO authenticated;')

    expect(
      analyze(`
        -- no-grant: authenticated on public.t3 (service-role only: the cron writes it)
        CREATE TABLE public.t3 (id bigserial PRIMARY KEY);
        GRANT ALL ON public.t3 TO service_role;
        GRANT USAGE, SELECT ON SEQUENCE public.t3_id_seq TO service_role;
      `),
    ).toEqual([])
  })

  it('accepts the sequence grant, and an identity key that needs none', () => {
    expect(
      analyze(`
        CREATE TABLE public.log (seq bigserial PRIMARY KEY);
        GRANT SELECT, INSERT ON public.log TO authenticated, service_role;
        GRANT USAGE, SELECT ON SEQUENCE public.log_seq_seq TO authenticated, service_role;
        CREATE TABLE public.log2 (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
        GRANT SELECT, INSERT ON public.log2 TO authenticated, service_role;
      `),
    ).toEqual([])
  })
})

describe('table-without-grant: bulk grants to the API roles', () => {
  it.each([
    'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
    'GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO anon, service_role;',
    'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO service_role;',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;',
  ])('flags %s', (sql) => {
    expect(analyze(sql).map((f) => f.kind)).toEqual(['bulk-grant'])
  })

  it('leaves the revoke in 20260929220000 and bulk grants to other roles or schemas alone', () => {
    expect(
      analyze(`
        ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
        GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres;
        GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO authenticated;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
      `),
    ).toEqual([])
  })
})

describe('table-without-grant: what is not a new public relation', () => {
  it('ignores temp tables and other schemas', () => {
    expect(
      analyze(`
        CREATE TEMP TABLE scratch (id int);
        CREATE TEMPORARY TABLE IF NOT EXISTS pg_temp.series (n int);
        CREATE TABLE private.secrets (id int);
        CREATE TABLE storage.extra (id int);
      `),
    ).toEqual([])
  })

  it('ignores IF NOT EXISTS / OR REPLACE on a relation an earlier migration created', () => {
    const existing = new Set(['invoices', 'ai_cost_daily'])
    expect(
      analyze(
        `CREATE TABLE IF NOT EXISTS public.invoices (id uuid);
         CREATE OR REPLACE VIEW public.ai_cost_daily AS SELECT 1 AS n;`,
        existing,
      ),
    ).toEqual([])
    // ... but not when the relation is genuinely new.
    expect(analyze('CREATE TABLE IF NOT EXISTS public.brand_new (id uuid);').map((f) => f.relation)).toEqual([
      'brand_new',
    ])
  })

  it('does not read example SQL inside comments, string literals or dollar-quoted bodies', () => {
    // The seed_agent_atom_bodies migrations carry skill markdown full of
    // example DDL as string literals; function bodies are dollar-quoted.
    expect(
      analyze(`
        -- CREATE TABLE public.in_line_comment (id int);
        /* CREATE TABLE public.in_block /* nested */ comment (id int); */
        INSERT INTO public.agent_atom_registry (body) VALUES ('Example: CREATE TABLE public.in_literal (id bigserial); it''s fine');
        INSERT INTO public.agent_atom_registry (body) VALUES (E'escaped \\' CREATE TABLE public.in_escape (id int);');
        CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $fn$
        BEGIN
          CREATE TABLE public.in_dollar (id int);
        END
        $fn$;
        DO $$ BEGIN PERFORM 1; END $$;
      `),
    ).toEqual([])
  })

  it('does not let a comment marker inside a string swallow the real DDL after it', () => {
    const findings = analyze(`SELECT '-- not a comment';\nCREATE TABLE public.real_one (id int);`)
    expect(findings.map((f) => [f.relation, f.line])).toEqual([['real_one', 2]])
  })

  it('blanks comments and literals without moving line numbers', () => {
    const sql = "SELECT 'a\nb'; -- c\nCREATE TABLE x (id int);"
    const { code, comments } = sanitizeSql(sql)
    expect(code.split('\n')).toHaveLength(sql.split('\n').length)
    expect(code).toContain('CREATE TABLE x')
    expect(code).not.toContain("'a")
    expect(comments).toEqual([' c'])
  })
})

describe('table-without-grant: across the migration history', () => {
  it('tracks relations created by earlier files, in apply order', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twg-'))
    tempDirs.push(root)
    const dir = path.join(root, 'supabase', 'migrations')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '20260101000000_a.sql'), 'CREATE TABLE public.a (id int);')
    fs.writeFileSync(path.join(dir, '20260102000000_b.sql'), 'CREATE TABLE IF NOT EXISTS public.a (id int);')
    const findings = findTablesWithoutGrant(root)
    expect(findings.map((f: Finding) => [f.file, f.relation])).toEqual([
      ['supabase/migrations/20260101000000_a.sql', 'a'],
    ])
  })

  it('never grandfathers a file that is not already in the frozen set, whatever its timestamp', () => {
    const frozen = ['supabase/migrations/20240101000001_a.sql', 'supabase/migrations/20260925000000_b.sql']
    const scanned = [
      'supabase/migrations/20240101000001_a.sql',
      // An older-dated branch that merged after 20260929220000: must fail, not be grandfathered.
      'supabase/migrations/20260920000000_late_branch.sql',
      'supabase/migrations/20260925000000_b.sql',
      'supabase/migrations/20261001000000_new.sql',
    ]
    expect(grandfatheredFiles(frozen, scanned)).toEqual(frozen)
    // A file whose findings went away (a sharper scanner) drops out.
    expect(grandfatheredFiles(frozen, [frozen[1]])).toEqual([frozen[1]])
    // Only the first write, with no set yet, takes the scan as is.
    expect(grandfatheredFiles(undefined, scanned)).toEqual(scanned)
  })

  // Reads and parses every migration file (1000+, ~40 MB): well under a
  // second alone, but a loaded CI shard running this file beside hundreds of
  // others blew the default 5 s, so it gets its own budget.
  it('grandfathers exactly the files that have findings today, and 20260929220000 is not one of them', () => {
    // The baseline is a frozen set: migration files never change, so a stale
    // entry would only ever hide a future file of the same name. Keep it
    // equal to what the scanner finds.
    const baseline = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'scripts', 'checks', 'antipatterns-baseline.json'), 'utf8'),
    )
    const files = [...new Set(findTablesWithoutGrant(ROOT).map((f: Finding) => f.file))].sort()
    expect(files).toEqual(baseline.tableWithoutGrant.files)
    expect(baseline.tableWithoutGrant.count).toBe(files.length)
    expect(files).not.toContain('supabase/migrations/20260929220000_own_default_privileges.sql')
    // Every grandfathered file was written against the old default, so it
    // predates the migration that ended it. A later file in the set means
    // someone grandfathered a new table instead of granting it.
    const versions = baseline.tableWithoutGrant.files.map((f: string) => path.basename(f).slice(0, 14))
    expect(versions.filter((v: string) => v >= '20260929220000')).toEqual([])
  }, 60_000)
})

# Hosted huvudbok — körguide (migration + smoke)

## 1. Pull Request

Books (rebasad mot `erp-mafia/accounted` main):

- https://github.com/erp-mafia/accounted/pull/1054

Vision/ADR (ombra-apt/engine):

- https://github.com/ombra-apt/engine/pull/1

OBX ROADMAP (ombra-apt/public):

- https://github.com/ombra-apt/public/pull/1

## 2. Migrationer

Kräver Docker + lokal Supabase **eller** hosted Supabase-länk.

### Lokalt

```bash
# Starta Docker Desktop först, sedan:
cd public/books
supabase start
supabase db reset   # eller: supabase migration up
```

Nya migrationer i PR:

1. `20260705180100_company_obx_modules_index.sql` — OBX modules/index (återinförd)
2. `20260717093112_workspace_posting_mode_and_sandbox_demote.sql` — `posting_mode`
3. `20260717120000_company_obx_registry.sql` — registry för attest

### Hosted (produktion/staging)

Via Supabase Dashboard → SQL, eller:

```bash
supabase link --project-ref <ref>
supabase db push
```

Kör **inte** `db reset` mot produktion.

## 3. Smoke-test (hybrid)

Sätt i self-host `.env` (värden i Settings / root `.env`, inte i chatten):

```bash
OMBRA_LEDGER_MODE=hybrid
OMBRA_HOSTED_BOOKS_URL=https://<hosted-books>
OMBRA_HOSTED_API_KEY=gnubok_sk_...
OMBRA_HOSTED_COMPANY_ID=<uuid>
```

Flöde:

1. Settings → Bookkeeping → `posting_mode` = workspace_first (default i hybrid)
2. Skapa utkast → Att bokföra → justera datum → Fastställ
3. Checklist: `GET /api/bookkeeping/obx/publish?fiscal_year=YYYY`
4. **Publicera år till Ombra**
5. På hosted: `POST /api/integrations/ombra/obx/verify` med `manifest_hash`

Unit-smoke (ingen Docker):

```bash
npx vitest run lib/obx/__tests__ lib/bookkeeping/__tests__/commit-gates.test.ts lib/workspace/__tests__/date-tools.test.ts
```

## 4. Ansvarscopy (produkt)

- Hosted: “regelstyrd huvudbok” = produktgaranti, inte juridisk rådgivning
- Hybrid: “jobba lokalt; publicera korrekt”
- Inget löfte om “bokför vid årsskiftet” på hosted/hybrid SoR

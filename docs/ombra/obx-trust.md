# OBX trust & hybrid publish (Ømbra sidecar)

Contract notes for OBX registry/verify and hybrid year-seal publish. Normative product decisions: [ADR 013](../../../../docs/adr/013-hosted-canonical-ledger.md), [ADR 014](../../../../docs/adr/014-obx-trust-anchor.md). Vision: [`corporate/vision/hosted-huvudbok.md`](../../../../corporate/vision/hosted-huvudbok.md), [`corporate/vision/obx-trust-network.md`](../../../../corporate/vision/obx-trust-network.md).

## Hybrid publish (SoR) — shipped path

Self-host / workshop instance → hosted Books SoR:

1. Local pre-publish checklist (`verify` + continuity + timing/period)
2. Export sealed `year-seal` (existing export helpers)
3. `POST /api/integrations/ombra/import/obx` on **hosted** with API key + `X-Company-Id`
4. Hosted import runs `verifyBundle` + continuity gate + SIE import via engine

Related routes (Books):

- `GET /api/integrations/ombra/export/obx`
- `POST /api/integrations/ombra/import/obx`
- `POST /api/integrations/ombra/transfer/obx/prepare|complete`
- Self-host UI: Settings → Bookkeeping → Publish to Ombra (`OMBRA_LEDGER_MODE=hybrid`)

Env:

```bash
OMBRA_LEDGER_MODE=hybrid   # hosted | hybrid | local
OMBRA_HOSTED_BOOKS_URL=https://books.example.com   # target SoR base URL
OMBRA_HOSTED_API_KEY=gnubok_sk_...                 # scoped to hosted company
# X-Company-Id supplied per request / stored in company settings
```

## Registry / verify (v0.3 — ADR 014)

Attest-only; does not replace SoR import.

### Endpoints (hosted sidecar)

- `POST /api/integrations/ombra/obx/registry` — publish `manifest_hash`, org, year, `chain_root`, custody
- `POST /api/integrations/ombra/obx/verify` — body `{ manifest_hash | inner_manifest_hash, fiscal_year? }` → `{ status: VERIFIED | NOT_FOUND }`

Table: `company_obx_registry` (migration `20260717120000_company_obx_registry.sql`).

### Rules

- No bookkeeping engine changes for trust
- No secrets for escrow in `public/`
- Pure `local` mode may register hashes without importing journal rows

## Status

- Hybrid publish checklist + UI: `lib/obx/publish-*`, ObxArchivePanel, `OMBRA_LEDGER_MODE`
- Registry/verify routes: implemented (attest-only; escrow/mail later)
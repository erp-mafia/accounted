# Kör Accounted helt svenskt: the sovereign self-host guide

This guide is for operators who want Accounted on Swedish (or strictly EU) infrastructure end to end: the ledger and its documents on servers in Sweden, AI on GPUs in Sweden, and source code you can audit. It builds on [SELF-HOSTING.md](SELF-HOSTING.md) (the general Docker guide) and its "Fully Self-Hosted" section; read those first, this guide only adds what the sovereign variant changes.

Two honest framings up front:

- **What you get is regulatory-risk elimination, not a legal verdict.** Hosted Accounted runs on Supabase and Vercel in AWS eu-north-1 (Stockholm) with AI inference on AWS Bedrock inside the EU; each of those providers operates under its own GDPR transfer mechanisms and contract terms (Data Privacy Framework participation and/or standard contractual clauses, documented in their DPAs), and whether that combination satisfies your policy is your assessment to make, not a conclusion this guide draws. What a self-host on Swedish providers removes is the *exposure*: no provider in the chain is subject to US extraterritorial law (the CLOUD Act), which is exactly the risk Sweden's national cloud policy of May 2026 names. That holds only for the chain you actually run: a sovereign deployment that keeps a US-dependent service such as Resend for outbound email has that one touchpoint left (section 6 lists them). The policy is principles for the public sector, not a mandate; it is still the document a procurement officer can point at.
- **Not every Swedish accounting vendor runs on US clouds**, so do not buy this guide as a claim that "everyone else does". Buy it because you want to be able to prove, provider by provider, where your books are.

Everything here is free to run under the AGPL. Services that only Accounted can operate (bank sync through our PSD2 licence, Skatteverket API submission, company lookup, provider migration) are hosted-only today; a connector subscription for self-hosted instances is planned but **not yet available** (see "What is and is not covered" below). Manual filing of VAT and AGI declarations (file generation, you upload at Skatteverket) is always free and works on a self-host.

## 1. What a sovereign deployment looks like

```mermaid
flowchart LR
    user((User / byrå))
    agent((Your own AI agent<br/>Claude, Codex, local model))
    subgraph se["Swedish infrastructure (your account)"]
        proxy["Reverse proxy + TLS"]
        app["Accounted app + cron<br/>(this repo's Docker image)"]
        supa["Self-hosted Supabase stack<br/>Postgres, Auth, Storage"]
        s3[("S3-compatible bucket<br/>backups, Object Lock")]
        ai["Swedish inference API<br/>(OpenAI-compatible)"]
    end
    user -- HTTPS --> proxy --> app --> supa
    agent -- MCP (API key) --> app
    app -- receipts, invoices --> ai
    app -. nightly backup.sh .-> s3
```

Three things carry the sovereign claim, in order of how much they matter:

1. **Storage and database**: the self-hosted Supabase stack (Postgres + Auth + Storage) on a Swedish provider, with backups on Swedish S3 under retention locks. This is where the räkenskapsinformation lives.
2. **The agent surface needs no AI provider at all.** Most automation against Accounted runs through the MCP server (100+ tools, scoped API keys, staged approvals) driven by *your* agent: Claude Code, Codex, an OpenClaw setup, or a local model. The MCP server makes zero model calls itself. A deployment with no AI credentials configured is fully usable that way.
3. **In-app AI** (reading receipts and invoices, the assistant) is optional and bring-your-own: point `AI_BASE_URL` at a Swedish OpenAI-compatible endpoint. Document extraction, the assistant's question-and-answer (`/chat` and the docked assistant sheet, via `/api/agent/ask`) and one-tap transaction categorization run on any OpenAI-compatible backend; only the specialized Anthropic-only conversational flows (VAT review, KPI explanation, settings help, the bokslut step-through, the operation-staging inbox flows) answer `503` there, see [SELF-HOSTING.md, What runs on any model](SELF-HOSTING.md#what-runs-on-any-model). The MCP path needs no model at all.

## 2. What is and is not covered

| Free and local on a self-host (AGPL) | Hosted-only today |
|---|---|
| Double-entry bookkeeping, invoicing, supplier invoices, reports, SIE import/export | Bank sync via Enable Banking (runs on Accounted's PSD2/AISP credentials) |
| VAT and AGI file generation for manual filing at Skatteverket | Skatteverket API submission and skattekonto sync (Accounted's API client registration) |
| Document archive with SHA-256 integrity and WORM bucket | Company lookup (TIC), migration from Fortnox/Visma/Bokio/Björn Lundén via the Arcim gateway |
| MCP server, API keys, staged approvals | Receipt hunt in a connected mailbox (Accounted's Google OAuth app), WhatsApp intake (Accounted's Meta credentials), Stripe billing |
| AI document extraction, assistant Q&A and one-tap categorization on a BYO endpoint; HTML mail invoices | Specialized conversational flows (VAT review, KPI explanation, settings help, bokslut helpers): Anthropic-family backend only (Bedrock or the direct API), not a BYO OpenAI-compatible endpoint ([#1800](https://github.com/erp-mafia/accounted/issues/1800)) |
| Push notifications (your VAPID keys), invoice email via Resend (section 6; an SMTP relay option is proposed in #1746) | |

The hosted-only column is what a connector subscription for self-hosted instances would unlock (priced at parity with hosted, per active company). That connector-key registry is proposed (PRs #1747, #1748, #1751, #1757 and #1758, none merged) and **not yet available**: today there is no instance-side variable to set and nothing to subscribe to, and the extensions' settings screens will tell you those services are unconfigured.

## 3. Choosing Swedish infrastructure

Facts below were checked on the providers' own pages in August 2026; verify before you sign, these change.

### Elastx (Stockholm; recommended primary)

- Swedish-owned (Elastx AB), data in Sweden, one region `se-sto` with three availability zones (`sto1`, `sto2`, `sto3`), each a separate data center up to 20 km apart. ISO/IEC 27001:2022, 27017, 27018, ISO 14001. Publishes a DPA with an annual audit right. Trust Center: https://elastx.se/en/trust-center
- What fits this stack: **Kubernetes CaaS** (managed, three-AZ nodes, managed ingress and cert-manager) or plain OpenStack VMs; **DBaaS PostgreSQL** 14 to 17 with optional HA and PITR (one-week default retention); S3-compatible object storage via OpenStack Swift (`swift.elastx.cloud`, SigV4 region must be `us-east-1`). Pricing and SLA: https://elastx.se/en/pricing, https://elastx.se/en/availability-sla
- Fit: the most "managed" Swedish option. Run the Accounted app + cron containers on CaaS or a VM, and either run the full Supabase stack yourself or point the stack's Postgres at DBaaS (self-hosted Supabase expects its own `supabase/postgres` image with extensions; using an external managed Postgres is possible but you take on the extension and role setup yourself, so the VM route with the stock stack is simpler).

### GleSYS (Falkenberg and Stockholm; budget VPS path)

- Own data centers in Falkenberg and Stockholm (plus Finland), ISO/IEC 27001:2022, 9001, 14001. EU jurisdiction; note the company is Swedish-headquartered but majority-owned by a Luxembourg infrastructure fund since 2023, which some buyers' sovereignty criteria distinguish from Swedish-owned. Public DPA (no processing outside EU/EEA). https://glesys.com/compliance-security, https://glesys.com/terms-policies/data-processing-agreement
- What fits: **KVM VPS** for the whole stack on one or two hosts, S3-compatible **Object storage** in Stockholm/Falkenberg, managed PostgreSQL (not needed if you run the stock Supabase stack). No managed Kubernetes. https://glesys.com/products/
- Fit: the cheapest credible path for a single company or a small byrå that is comfortable operating Docker Compose on a VPS.

### Safespring (Stockholm, Oslo; the backup bucket)

- Safespring Storage is Ceph-based, fully S3-compatible, **supports S3 Object Lock in both COMPLIANCE and GOVERNANCE modes plus legal hold and bucket default retention**, and versioning. Sites `sto1`, `sto2` (Stockholm) and `osl2` (Oslo); the cheaper Archive tier is `sto2` only. Endpoints `s3.sto1.safedc.net`, `s3.sto2.safedc.net`. No egress charges. https://docs.safespring.com/storage/object-locking/, https://www.safespring.com/en/price/
- Fit: the place for the backup sets from `scripts/self-host/backup.sh`. Object Lock must be enabled when the bucket is created, it cannot be switched on later. COMPLIANCE mode is the right setting for the yearly archive copy: nobody, including you, can delete it before the retention date, which is what makes it a credible BFL 7 kap archive.

### Swedish AI inference (for in-app extraction)

- **Berget AI** (default in this guide): OpenAI-compatible API at `https://api.berget.ai/v1`; public model list at `/v1/models`. Vision-capable models suitable for receipts as of August 2026 include `google/gemma-4-31B-it` and `mistralai/Mistral-Medium-3.5-128B`; text-only models such as `zai-org/GLM-5.2` work for the assistant's question-and-answer but cannot read images. Markets Swedish data centers; the DPA wording is "within the EEA", so ask for the specific site in writing if your policy needs "Sweden". **The SLA excludes serverless inference**: raise that in procurement. https://docs.berget.ai/models/overview, https://berget.ai/en/dpa, https://berget.ai/en/sla
- **evroc**: OpenAI-compatible "Think Models" API at `https://models.think.evroc.com/v1` with vision models (Gemma 4, Qwen3-VL, Kimi); EU residency, flagship Stockholm data center expected in H2 2026, so confirm where inference runs today. DPA with no sub-processors. https://docs.evroc.com/products/think/think.html, https://evroc.com/legal/data-processing-addendum/

Configure either through the standard variables (details in [SELF-HOSTING.md, AI Features, Option 3](SELF-HOSTING.md#ai-features)):

```bash
AI_BASE_URL=https://api.berget.ai/v1
AI_API_KEY=...
AI_MODEL=google/gemma-4-31B-it          # vision-capable: reads receipts and PDFs
# AI_EXTRACTION_MODEL=...               # if you want a different model for documents
# AI_VISION=false                        # only if you chose a text-only model
# AI_PDF_MODE=rasterize                  # default on these endpoints; the image ships pdftoppm
```

Then prove it end to end before telling users: `npx tsx scripts/smoke-ai-provider.ts ./some-receipt.pdf` from a checkout next to your `.env`.

### Coolify as the deployment tool

If you would rather not hand-write systemd units, [Coolify](https://coolify.io) (Apache-2.0, self-hosted) deploys Docker Compose projects onto any VPS you own over SSH, so it works on Elastx VMs and GleSYS KVM alike. Accounted's `docker-compose.yml` deploys as a compose resource; use Coolify's proxy for TLS instead of the Caddy overlay. Two documented gotchas: a `ports:` mapping in your compose exposes the port on the host *outside* Coolify's proxy (the Accounted file binds to loopback, keep it that way), and Coolify's one-click Supabase template lagged upstream (Postgres 15 while upstream defaults to 17, and a known bug that exposed the database port publicly), so for the sovereign stack run upstream Supabase's own compose rather than the template. https://coolify.io/docs/knowledge-base/docker/compose, https://coolify.io/docs/services/supabase

Managed catalogs that host open-source apps for you (PikaPods, Elestio) are EU-located but not Swedish; they are the middle option, not the headline.

## 4. Self-hosted Supabase: gotchas as of August 2026

These are the things that cost people an afternoon. Source: the upstream Docker self-hosting docs and changelog (https://supabase.com/docs/guides/self-hosting/docker, https://github.com/supabase/supabase/blob/master/docker/CHANGELOG.md).

- **`API_EXTERNAL_URL` now includes the `/auth/v1` path** (docker 0.7.0, July 2026): `API_EXTERNAL_URL=https://supabase.example.com/auth/v1`. Older guides show it without the path; GoTrue then builds wrong links.
- **Postgres 17 is the default image** since docker 0.6.0 (June 2026). Never start the 17 image on a 15 data directory: use upstream's `utils/upgrade-pg17.sh` (needs roughly twice the database size free, and back up the pgsodium root key from the `db-config` volume first). https://supabase.com/docs/guides/self-hosting/postgres-upgrade-17
- **The gateway depends on your release**: `self-hosted/v0.7.x` runs Kong by default (Envoy via the `docker-compose.envoy.yml` overlay), `self-hosted/v0.8.0` and later run Envoy by default (Kong via `docker-compose.kong.yml`). The diagrams in SELF-HOSTING.md say `kong`; the role is the same.
- **Studio is single-project** in self-hosted mode (`STUDIO_DEFAULT_ORGANIZATION` / `STUDIO_DEFAULT_PROJECT`); a byrå hosting many client companies still runs one Supabase project, since Accounted's multi-tenancy is inside the database.
- **No managed backups, no PITR.** Upstream says so plainly. This is why the next section exists.
- **Storage backend**: by default storage-api writes files to `./volumes/storage` (`STORAGE_BACKEND=file`). To put documents straight onto Swedish S3, set `STORAGE_BACKEND=s3` with `STORAGE_S3_BUCKET`, `STORAGE_S3_ENDPOINT`, `STORAGE_S3_REGION`, `STORAGE_S3_FORCE_PATH_STYLE=true` and the bucket's `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in the storage service. Accounted's `documents` bucket is WORM at the application level either way (migration 024); Object Lock on the S3 side adds the provider-level guarantee.

## 5. Backup and restore (ship it, do not improvise it)

Swedish bookkeeping law requires the ledger and its underlag to be kept for seven years after the end of the fiscal year, and self-hosted Supabase gives you no backups. Two scripts in this repo cover the minimum:

- `scripts/self-host/backup.sh`: logical `pg_dump` (custom format) of the Supabase database, a tar of the storage volume (the documents), optionally the `db-config` Docker volume (the pgsodium root key; without it Vault-encrypted columns are unreadable after a restore), SHA-256 manifest, uploaded to an S3-compatible bucket with optional **COMPLIANCE-mode Object Lock**.
- `scripts/self-host/restore.sh <name> --yes`: downloads a set, verifies checksums, restores the database (`pg_restore --clean`; any reported error stops it before storage is touched, re-run with `RESTORE_TOLERATE_ERRORS=1` once you have read the log and the errors are the expected "already exists" kind on a Supabase target), unpacks storage and db-config.

Requirements on the host running them: `pg_dump`/`pg_restore` matching the server major, `tar`, `gzip`, AWS CLI v2 (talks to any S3-compatible endpoint via `--endpoint-url`), and `docker` only if you back up the db-config volume. Uploads go through `aws s3api put-object`, which caps a single object at 5 GB and has no multipart fallback in the script: a dump or storage tar past that size needs splitting or another uploader before the run succeeds.

### Nightly plus yearly

Create the bucket with Object Lock enabled (it cannot be enabled afterwards). Then, on the host that can reach the database (a `.env.backup` you keep out of git):

```bash
export BACKUP_DATABASE_URL='postgresql://postgres:<password>@127.0.0.1:5432/postgres'
export BACKUP_S3_ENDPOINT='https://s3.sto2.safedc.net'
export BACKUP_S3_BUCKET='accounted-backups'
export AWS_ACCESS_KEY_ID='...'; export AWS_SECRET_ACCESS_KEY='...'
export BACKUP_STORAGE_DIR='/opt/supabase/docker/volumes/storage'
export BACKUP_DB_CONFIG_VOLUME='supabase_db-config'
```

```cron
# nightly set, 35 days immutable (covers mistakes, keeps storage bounded)
0 2 * * *   . /root/.env.backup && BACKUP_OBJECT_LOCK_DAYS=35 /opt/accounted/scripts/self-host/backup.sh
# yearly archive copy after bokslut, seven years plus margin, COMPLIANCE mode,
# app stopped for the window so database and documents are one consistent set
0 3 15 1 *  . /root/.env.backup && BACKUP_LABEL=yearly BACKUP_OBJECT_LOCK_DAYS=2700 BACKUP_QUIESCE_CMD='docker compose -f /opt/accounted/docker-compose.yml stop app cron' BACKUP_RESUME_CMD='docker compose -f /opt/accounted/docker-compose.yml start app cron' /opt/accounted/scripts/self-host/backup.sh
```

Alert on a non-zero exit: the script prints a few progress lines on success and fails loudly; if your cron mails stdout, add `>/dev/null` to the entry and keep stderr. The database dump and the storage tar are taken one after the other, so an upload landing in that window gives a set with a document row but no file (or the reverse); the nightly run accepts that (the next night covers it), and for the yearly archive run set `BACKUP_QUIESCE_CMD` / `BACKUP_RESUME_CMD` to stop and start the app containers around the run so the set is consistent. Storage grows by one dump plus one storage tar per run; the nightly lock expires and a lifecycle rule on the bucket can expire old nightly objects, the yearly ones cannot be deleted before their date by anyone.

### Restore drill (do this once before you need it)

1. Bring up a fresh Supabase stack on a scratch VM with the **same** `JWT_SECRET`, `ANON_KEY` and `SERVICE_ROLE_KEY` as production (or re-issue keys into Accounted's `.env` afterwards).
2. Stop the database container, `RESTORE_DB_CONFIG_VOLUME=<volume> scripts/self-host/restore.sh <name> --yes` with `RESTORE_DATABASE_URL` pointing at the scratch database and `RESTORE_STORAGE_DIR` at its `volumes/storage`, then start the stack again. (Order: db-config before the database container's first start, then database, then storage, then restart storage-api.)
3. Point a scratch Accounted at it, log in, open a verifikat and its underlag, run the document-archive verification cron once (`/api/documents/verify/cron`): it recomputes SHA-256 over the archive and reports mismatches.
4. Write down how long it took. That number is your recovery time.

## 6. Honest dependency list (what still touches a non-Swedish party)

A sovereign deployment still has these touchpoints. None carries accounting data; list them for your own risk register rather than pretending they are gone.

- **Image distribution**: the app image is pulled from GitHub Container Registry (`ghcr.io/erp-mafia/gnubok`), and the cron sidecar downloads `supercronic` from GitHub Releases at build time. Mirror both into your own registry for an air-gapped setup (build from source: `docker compose -f docker-compose.yml -f docker-compose.build.yml up --build`).
- **Fonts**: `next/font/google` downloads Geist and Hedvig Letters Serif **at build time** and self-hosts them; browsers never call Google. The GitHub-built image therefore has no runtime font dependency; a source build fetches them once during `next build`.
- **Invoice email**: the email extension sends through Resend (US) only today; an SMTP mailer behind the same seam is proposed in #1746 and, once merged, `EMAIL_PROVIDER=smtp` selects it (your own relay: a Swedish mail provider, an M365/Workspace relay, Postfix on the host). Until then, either accept Resend as the one non-Swedish touchpoint or leave invoice email unconfigured (invoices download as PDF). Resend carries invoice PDFs to your customers but no ledger data.
- **Telemetry**: none. Analytics (PostHog), Vercel Speed Insights and error tracking are hosted-only and switched off by `NEXT_PUBLIC_SELF_HOSTED=true`; there is no call-home licence check, by design.
- **Upstream services you opt into**: Enable Banking, Skatteverket, TIC, the migration gateway, Google OAuth for receipt hunt, Meta for WhatsApp are hosted-only today (section 2) and simply stay unconfigured.

## 7. Checklist

- [ ] Provider chosen for compute (Elastx CaaS/VM or GleSYS VPS) and a DPA on file.
- [ ] Supabase stack up with `API_EXTERNAL_URL` including `/auth/v1`, Postgres 17 image on a fresh data dir, `ADDITIONAL_REDIRECT_URLS` for the app's callbacks.
- [ ] Accounted migrations applied via `psql` (SELF-HOSTING.md, Fully Self-Hosted step 2).
- [ ] `NEXT_PUBLIC_SELF_HOSTED=true`, `CRON_SECRET` set, cron sidecar healthy (`docker compose ps`), `/api/health` green.
- [ ] Backup bucket created **with Object Lock**, `backup.sh` scheduled nightly + yearly, one restore drill completed and timed.
- [ ] AI: either none (MCP-only deployment) or `AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL` set and `npx tsx scripts/smoke-ai-provider.ts receipt.pdf` green.
- [ ] Decide on invoice email (Resend, or none until the SMTP relay in #1746 lands) and record it in your register.
- [ ] Read the national cloud policy yourself before quoting it to a buyer: it is principles, not mandates. https://www.regeringen.se/informationsmaterial/2026/05/en-molnpolicy-for-sverige--for-okad-sakerhet-effektivitet-och-innovation-i-den-offentliga-forvaltningen/

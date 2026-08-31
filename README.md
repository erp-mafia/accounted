# Accounted

Open-source Swedish accounting software for sole traders (enskild firma) and limited companies (aktiebolag). Double-entry bookkeeping that complies with Swedish accounting law, built to be operated by you or by your AI agent.

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Core Build](https://github.com/erp-mafia/accounted/actions/workflows/core-build.yml/badge.svg)](https://github.com/erp-mafia/accounted/actions/workflows/core-build.yml)
[![pg-real tests](https://github.com/erp-mafia/accounted/actions/workflows/test-pg-real.yml/badge.svg)](https://github.com/erp-mafia/accounted/actions/workflows/test-pg-real.yml)
[![Docker](https://github.com/erp-mafia/accounted/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/erp-mafia/accounted/actions/workflows/docker-publish.yml)

[Website](https://accounted.se) · [Hosted app](https://app.gnubok.se) · [Documentation](https://docs.gnubok.se)

<!-- Hero screenshot goes here (pending founder-approved shot):
![Accounted dashboard](docs/assets/hero.png)
-->

## Why Accounted?

**Compliant by construction.** Accounted implements double-entry bookkeeping under Swedish accounting law (Bokföringslagen). Voucher immutability, sequential voucher numbering, period locks, and 7-year document retention are enforced by database triggers, not by convention. Corrections are made the legal way, with reversal entries (storno), never by editing history. See [ARCHITECTURE.md](ARCHITECTURE.md) for how.

**Agent-native.** The full bookkeeping engine is exposed as 150+ MCP (Model Context Protocol) tools with scoped API keys or OAuth, so an AI agent can do the books in Accounted: categorize transactions, draft vouchers, reconcile periods, and prepare declarations. Posting is staged for human approval, so the agent proposes and you decide.

**Yours to run.** AGPL-3.0 licensed and fully self-hostable with Docker and Supabase. Use the hosted version at [app.gnubok.se](https://app.gnubok.se) or run your own.

## Features

- **Double-entry bookkeeping** -- BAS 2026 chart of accounts, draft/commit workflow, sequential voucher numbering
- **Invoicing** -- Create, send, and track invoices with mixed VAT rates and PDF generation
- **Bank reconciliation** -- PSD2 bank connection via Enable Banking, 4-pass automatic matching
- **VAT declaration** -- SKV 4700 form mapping, per-rate breakdown, EU/export handling
- **Tax reports** -- NE-bilaga, INK2, SRU export for Skatteverket
- **Payroll** -- Salary runs, payslips, and AGI (arbetsgivardeklaration) employer declarations
- **Supplier invoices** -- Registration, payment tracking, input VAT deduction
- **Supplier payment files (betalfil)** -- Batch supplier payments into ISO 20022 pain.001 files for upload to the bank, rendered byte-identical on every download
- **E-invoicing (Peppol)** -- Send and receive Peppol BIS Billing 3 e-invoices through Qvalia, a certified Swedish Access Point; received documents land in the supplier invoice inbox
- **Skattekonto** -- Tax account transactions synced from Skatteverket or imported from statement files, linked to the booked 1630 movements for reconciliation
- **Document archive** -- SHA-256 integrity, 7-year retention enforcement, full archive ZIP export
- **SIE import/export** -- Standard Swedish accounting interchange format
- **Agent access (MCP)** -- 150+ bookkeeping tools over the Model Context Protocol, with scoped API keys and staged approvals
- **Claude connector and plugin** -- Connect Claude.ai or Claude Code over OAuth 2.1 and install approval-gated workflow skills (`/accounted:bookkeep`, `/accounted:vat`, `/accounted:year-end`, ...) from [claude-plugin/](claude-plugin/README.md)
- **Extension system** -- Opt-in plugins for AI categorization, receipt OCR, email, calendar, and more

## Self-Hosting

```bash
git clone https://github.com/erp-mafia/accounted.git
cd accounted
./setup.sh              # Prompts for Supabase credentials, generates .env
docker compose up -d
```

You need a Supabase project and must apply the database migrations before first use. See [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) for the full step-by-step guide, including Supabase setup, auth configuration, optional features (AI, email, push notifications), and troubleshooting. To run everything on Swedish infrastructure (your own Supabase stack, Swedish hosting, AI on Swedish GPUs), see [docs/SOVEREIGN.md](docs/SOVEREIGN.md).

## Development Setup

Prerequisites: Node.js 20 or newer (CI runs Node 20; the Docker image ships Node 22), a Supabase project.

```bash
npm install
npm run dev       # Start dev server (auto-generates extension registry)
npm test          # Run tests
npm run build     # Production build
npm run lint      # ESLint
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development workflow.

## Tech Stack

- **Framework**: Next.js 16 (App Router), React 19, TypeScript (strict)
- **Database**: Supabase (PostgreSQL + Row Level Security + email/password auth + TOTP MFA)
- **Styling**: Tailwind CSS 4 + shadcn/ui
- **Integrations**: Enable Banking (PSD2), Qvalia (Peppol), Skatteverket, Anthropic SDK on Amazon Bedrock (eu-north-1; direct Anthropic or any OpenAI-compatible endpoint for self-hosted via the Vercel AI SDK), Resend, JSZip

## Documentation

- [User and API documentation](https://docs.gnubok.se) -- Guides for using the product and the public API
- [ARCHITECTURE.md](ARCHITECTURE.md) -- How the system is built: bookkeeping engine, legal enforcement, tenancy, extensions, agent surface
- [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) -- Full self-hosting guide (Docker, Supabase setup, migrations, optional features)
- [docs/EXTENSIONS.md](docs/EXTENSIONS.md) -- Extension development guide
- [docs/DOCKER.md](docs/DOCKER.md) -- Docker deployment reference
- [CONTRIBUTING.md](CONTRIBUTING.md) -- Development workflow, code style, pull request process
- [SECURITY.md](SECURITY.md) -- Vulnerability reporting policy

## Community

- Found a bug or have an idea? [Open an issue](https://github.com/erp-mafia/accounted/issues/new/choose)
- Security vulnerabilities: see [SECURITY.md](SECURITY.md), never a public issue
- Everyone interacting in the project is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md)

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

All commits require a [DCO sign-off](DCO) (`git commit -s`).

## License

[AGPL-3.0-or-later](LICENSE) with an **extension exception**: third-party extensions that interact solely through the documented Extension API may be licensed under any terms, including proprietary. See [LICENSE](LICENSE) for details and [NOTICE](NOTICE) for third-party attributions.

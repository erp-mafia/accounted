# Accounted

Open-source Swedish accounting software for sole traders (enskild firma) and limited companies (aktiebolag).

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](LICENSE)

## What is Accounted?

Accounted implements double-entry bookkeeping compliant with Swedish accounting law (Bokforingslagen). It supports the BAS 2026 chart of accounts, handles VAT declarations (momsdeklaration), SIE import/export, and enforces 7-year document retention. Built for sole traders and limited companies operating in Sweden.

## Features

- **Double-entry bookkeeping** -- BAS 2026 chart of accounts, draft/commit workflow, sequential voucher numbering
- **Invoicing** -- Create, send, and track invoices with mixed VAT rates and PDF generation
- **Bank reconciliation** -- PSD2 bank connection via Enable Banking, 4-pass automatic matching
- **VAT declaration** -- SKV 4700 form mapping, per-rate breakdown, EU/export handling
- **Tax reports** -- NE-bilaga, INK2, SRU export for Skatteverket
- **Supplier invoices** -- Registration, payment tracking, input VAT deduction
- **Document archive** -- SHA-256 integrity, 7-year retention enforcement, full archive ZIP export
- **SIE import/export** -- Standard Swedish accounting interchange format
- **Extension system** -- Opt-in plugins for AI categorization, receipt OCR, email, calendar, and more

## Self-Hosting

```bash
git clone https://github.com/erp-mafia/gnubok.git
cd Accounted
./setup.sh              # Prompts for Supabase credentials, generates .env
docker compose up -d
```

You need a Supabase project and must apply the database migrations before first use. See [SELF-HOSTING.md](docs/SELF-HOSTING.md) for the full step-by-step guide, including Supabase setup, auth configuration, optional features (AI, email, push notifications), and troubleshooting.

## Development Setup

Prerequisites: Node.js 20+, a Supabase project.

```bash
npm install
npm run dev       # Start dev server (auto-generates extension registry)
npm test          # Run tests
npm run build     # Production build
npm run lint      # ESLint
```

## Tech Stack

- **Framework**: Next.js 16 (App Router), React 19, TypeScript (strict)
- **Database**: Supabase (PostgreSQL + Row Level Security + email/password auth + TOTP MFA)
- **Styling**: Tailwind CSS 4 + shadcn/ui
- **Integrations**: Enable Banking (PSD2), Anthropic SDK, LangChain, OpenAI, Resend, JSZip

## Documentation

- [SELF-HOSTING.md](docs/SELF-HOSTING.md) -- Full self-hosting guide (Docker, Supabase setup, migrations, optional features)
- [CLAUDE.md](CLAUDE.md) -- Architecture, bookkeeping engine, database conventions, extension system
- [CONTRIBUTING.md](CONTRIBUTING.md) -- Development workflow, code style, pull request process
- [SECURITY.md](SECURITY.md) -- Vulnerability reporting policy

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

All commits require a [DCO sign-off](DCO) (`git commit -s`).

## License

[AGPL-3.0-or-later](LICENSE) with an **extension exception**: third-party extensions that interact solely through the documented Extension API may be licensed under any terms, including proprietary. See [LICENSE](LICENSE) for details and [NOTICE](NOTICE) for third-party attributions.

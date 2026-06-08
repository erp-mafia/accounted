# Contributing to Accounted

Thank you for your interest in contributing to gnubok. This guide covers the development workflow, coding standards, and submission process.

## Getting Started

1. Fork the repository and clone your fork
2. Install dependencies: `npm install`
3. Start the dev server: `npm run dev`
4. Run tests: `npm test`

## Supabase Setup

You need a Supabase project for local development:

1. Create a free project at [supabase.com](https://supabase.com)
2. Run all migrations from `supabase/migrations/` against your project
3. Copy `.env.example` to `.env` and fill in your Supabase credentials:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`

## Development Workflow

1. Create a branch from `main` with a descriptive name
2. Make your changes following the code style below
3. Run the full check suite before submitting:

```bash
npm run lint
npm test
npm run build
```

4. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` new feature
   - `fix:` bug fix
   - `refactor:` code restructuring
   - `test:` adding or updating tests
   - `docs:` documentation changes

## DCO Sign-Off

All commits must include a `Signed-off-by` line certifying that you have the right to submit the contribution under the project's license. This is the [Developer Certificate of Origin](https://developercertificate.org/) (DCO).

Add the sign-off automatically with `git commit -s`:

```
feat: add VAT report export

Signed-off-by: Your Name <your.email@example.com>
```

If you forget, you can amend: `git commit --amend -s`.

## Pull Requests

- Keep PRs focused on a single change
- Include a clear description of what and why
- Ensure CI passes (the core build resets extensions to empty, so core code must compile standalone)
- Link related issues if applicable

## Extension Development

See `CLAUDE.md` for the full extension architecture. Quick start:

```bash
npx tsx scripts/create-extension.ts --name my-ext --sector general --category operations --description "..."
```

Then add `"my-ext"` to `extensions.config.json` and run `npm run setup:extensions`.

Constraints:
- Extensions cannot use dynamic imports (Next.js bundling requirement)
- Core must build and run with zero extensions enabled
- Never import from `@/extensions/` in core code

## What Not to Do

- **Don't modify enforcement triggers** in migration 017 (legally required for Swedish accounting law)
- **Don't insert directly into journal tables** -- use the engine functions in `lib/bookkeeping/engine.ts`
- **Don't break the core/extension boundary** -- core must compile standalone without extensions
- **Don't delete posted journal entries** -- use storno reversal via `reverseEntry()`

## Code Style

- TypeScript strict mode, no `any` unless unavoidable
- English for all code, comments, and commit messages
- `Math.round(x * 100) / 100` for monetary calculations, never `toFixed()`
- Account numbers are strings (`'1930'`, not `1930`)
- All shared types go in `types/index.ts`

## Questions?

Open a discussion or issue on GitHub. For security vulnerabilities, see [SECURITY.md](SECURITY.md).

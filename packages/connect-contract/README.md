# @accounted/connect-contract

The wire contract between an Accounted ledger installation (the hosted service
or a self-hosted instance) and Accounted Connect, the service that operates
the provider integrations only Accounted can run: bank feeds through its PSD2
credentials, the Skatteverket API client, the Peppol access point, company
lookup, the migration sources.

This package is shape only: constants, Zod schemas and the TypeScript types
inferred from them. There is no behaviour and no provider code in it. Both
sides of the connection validate with the same schemas so they cannot drift
apart, and the package is MIT so that anyone may implement either side.

What is in it:

- key prefix, header names and the entitlements path an installation uses;
- the entitlements and sync-report payloads of the hourly key sync;
- the error envelope and the stable error codes the service answers with;
- the Peppol operations (`/api/connect/peppol/*`): request and response
  schemas plus the operation table (method, path, company header required).

Versioning: `CONTRACT_VERSION` is a date. Fields are only ever added; a
breaking change is a new operation or family, never a changed one.

## Use

```ts
import { peppolSubmissionSchema, PEPPOL_OPERATIONS, CONTRACT_VERSION } from '@accounted/connect-contract'

const parsed = peppolSubmissionSchema.safeParse(body)
if (!parsed.success) return badRequest(parsed.error)
```

Inside the Accounted repository the package is consumed from source through a
path alias. To publish, build from the repository root with the root
dependencies installed:

```bash
npx tsc -p packages/connect-contract/tsconfig.json
cd packages/connect-contract && npm publish --access public
```

# Development and delivery

[Español](DEVELOPMENT.es.md)

Run commands from the repository root with the prerequisites and installation described in the [README](README.md).

## Structure and commands

| Package                   | Responsibility                                                  |
| ------------------------- | --------------------------------------------------------------- |
| `packages/infrastructure` | CDK stack, deployment parameters and CLI.                       |
| `packages/runtime`        | Handlers, Middy, services, Mongo and external clients.          |
| `packages/contracts`      | Schemas, derived types, routes, OpenAPI and pure configuration. |

Packages use explicit source exports and one root `package-lock.json`. Shared tools and integration tests live at the root. Infrastructure imports contracts without loading runtime clients; cross-package relative imports are rejected.

| Command                                 | Purpose                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `npm run check`                         | Complete local validation and packaging.                                       |
| `npm test` / `npm run test:watch`       | Isolated tests with verbose output.                                            |
| `npm run typecheck`                     | Strict types for each workspace and integration tests.                         |
| `npm run lint` / `npm run format:check` | Code and formatting checks; `lint:fix` / `format` apply fixes.                 |
| `npm run openapi`                       | Generate `dist/openapi.json` from contracts.                                   |
| `npm run build`                         | Create `dist/health.zip` and `dist/recipes.zip` and run smoke checks.          |
| `npm run synth:local`                   | Synthesize and review `cdk.out` with synthetic parameters, without AWS access. |

Each ZIP contains one ESM bundle. Health exports `health.handler`; recipes exports `recipes.catalog`, `recipes.detail` and `recipes.ingredients`. OpenAPI, tests and local/private files stay outside ZIPs. The first Mongo test run downloads its ephemeral server binary.

## Runtime configuration

`NODE_ENV` and `CORS_ORIGIN` configure HTTP behavior; production requires explicit origins. `RATE_LIMIT_PER_ROUTE` and `RATE_LIMIT_GLOBAL` configure quotas. Provider settings and UTC budgets are defined in the [provider client](packages/runtime/src/recipes/providers/client.ts).

Lambda loads configuration through two secret references:

- `MONGO_SECRET_ARN`: JSON containing `MONGO_URI`; health uses a separate read-only Mongo user.
- `PROVIDER_SECRET_ARN`: JSON containing `SPOONACULAR_API_KEY`, `AZURE_TRANSLATOR_KEY` and `AZURE_TRANSLATOR_REGION`; recipes only.

Secret values are cached for the instance lifetime; recycle functions after rotation. Test sets `REAL_PROVIDERS_ENABLED=false`. External HTTP uses HTTPS, no redirects/retries, a 30-second timeout and 256 KiB request / 1 MiB decompressed response limits. Requests have a 27-second deadline or remaining Lambda time minus 750 ms.

## Delivery

`TEST_*` parameters are defined in [infrastructure](packages/infrastructure/src/config.ts). HTTP API requires HTTP(S) origins; the Android client uses `https://localhost`. Mongo uses TLS and `MONGODB-AWS` authentication, with separate read access for health and read/write access for recipes.

`npm run prepare:access` generates initial permissions in `dist/delivery-access.json`; `npm run synth:foundation` synthesizes the foundation. The [foundation workflow](.github/workflows/foundation.yml) configures the bucket, roles and secret references. `api_id` restricts management to one API; use `regional_bootstrap=true` only to create it, then disable it once the ID is available.

The [build and deploy workflow](.github/workflows/build-and-deploy.yml) takes a reviewed `dev` SHA as `reviewed_sha`, publishes assets and preserves the same reviewed assembly between preparation and execution using OIDC and checksums. Changes enter through PRs, CI and the [merge workflow](.github/workflows/merge.yml).

Recover code through the same delivery flow. Inspect events and resources before retrying a failed creation; `recover_empty_stack=true` only accepts stacks without retained resources.

## Mongo backups

Use compatible Database Tools and credentials stored outside the repository. Stop writes for a consistent backup and restore into an empty, isolated database first:

```bash
mongodump --config /secure/source.yml --archive backup.archive.gz --gzip
mongorestore --config /secure/destination.yml --archive backup.archive.gz --gzip \
  --nsFrom 'source.*' --nsTo 'isolated_restore.*' --stopOnError
```

Verify documents, dates, unique indexes and TTL indexes; preserve counters and reconcile subsequent writes before using the copy.

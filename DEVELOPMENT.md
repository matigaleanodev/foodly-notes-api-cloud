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

## Delivery and recovery

The account is `650387442642`, region `us-east-1`. Lambda uses managed egress and public TLS connections to Atlas, with `MONGODB-AWS` authentication and separate roles: read access for health, read/write access for recipes on its database. The validation database contains controlled fixtures and does not copy production data. No VPC, NAT or private endpoints are created. The regional concurrency quota of 10 is shared with other functions; no reserved concurrency is configured. Gateway throttling, atomic quotas, UTC budgets and small pools remain in place. HTTP API requires HTTP(S) origins; Android uses `https://localhost`.

`npm run prepare:access` generates initial administrative permissions in `dist/delivery-access.json` for an authorized administrator. The external ceiling cannot be changed by the foundation or application roles; it does not expand Architect permissions. `npm run synth:foundation` synthesizes the CDK foundation without assets or bootstrap: a private/versioned bucket, three configuration references and five bounded roles. The [foundation workflow](.github/workflows/foundation.yml) prepares, reviews and executes its change set. Initial creation temporarily allows regional HTTP API administration; it is then restricted to the observed `api_id` with `regional_bootstrap=false`.

Non-sensitive `TEST_*` parameters are validated in [infrastructure configuration](packages/infrastructure/src/config.ts). `npm run build && npm run synth` produces the assembly and `node scripts/review-package.mjs cdk.out` reviews it. The [build and deploy workflow](.github/workflows/build-and-deploy.yml) requires the reviewed full `dev` SHA, approval for that revision and network/recovery checks. OIDC separates preparation, execution and CloudFormation. Jobs retain the same assembly, lockfile, referenced metadata and checksums for 30 days, checking integrity and provenance within the same run. Execution compares the template, live change set and bytes of both published ZIPs. Preparation and execution do not synthesize again.

Changes enter through PRs and required CI; the [merge workflow](.github/workflows/merge.yml) integrates the reviewed SHA with the personal account. Recover code through PR/CI and another reviewed change set, preserving Mongo, counters and budgets. `UPDATE_ROLLBACK_COMPLETE` supports an update; `ROLLBACK_COMPLETE` and incomplete states require checking events and retained resources first. Explicit recovery with `recover_empty_stack=true` removes a failed `ROLLBACK_COMPLETE` creation only when all its resources already have `DELETE_COMPLETE` status; the external foundation is retained. Retained artifacts allow inspection of the previous delivery.

For data recovery, stop writes during a consistent backup and use Database Tools compatible with the Mongo version. Store sensitive configuration and backup files under ignored, access-restricted `Infrastructure/Secrets/`. Restore into an empty, isolated database first:

```bash
mongodump --config /secure/source.yml --archive backup.archive.gz --gzip
mongorestore --config /secure/destination.yml --archive backup.archive.gz --gzip \
  --nsFrom 'source.*' --nsTo 'isolated_restore.*' --stopOnError
```

Check keys, counts, BSON/dates, unique indexes and TTL indexes in all four collections; preserve active counters without resetting them. Recovery onto another copy requires reconciling subsequent writes. The original API and EC2 remain available for the controlled production cutover.

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

- `MONGO_SECRET_ARN`: JSON containing `MONGO_URI` and, for public access, `ORIGIN_VERIFY_SECRET` with at least 32 characters. Health uses a separate read-only Mongo user; recipes has read/write access to the same production database.
- `PROVIDER_SECRET_ARN`: JSON containing `SPOONACULAR_API_KEY`, `AZURE_TRANSLATOR_KEY` and `AZURE_TRANSLATOR_REGION`; recipes only.

Secrets remain external to artifacts and Git. Do not switch databases or reset `securitycounters` during cutover or recovery. Secret values are cached for the instance lifetime; recycle functions after rotation. `PUBLIC_ACCESS_ENABLED=true` enables public routes and disables the execute-api endpoint. It requires `api.foodlynotes.app`, a Cloudflare source IP and the shared secret in `X-Foodly-Origin`, added by a Cloudflare rule scoped to that host. Only then is `CF-Connecting-IP` trusted; `X-Forwarded-For` is ignored. Without the flag, routes require AWS_IAM. `REAL_PROVIDERS_ENABLED=true` enables providers only with protected public access. External HTTP uses HTTPS, no redirects/retries, a 30-second timeout and 256 KiB request / 1 MiB decompressed response limits. Requests have a 27-second deadline or remaining Lambda time minus 750 ms.

## Delivery

`TEST_*` parameters are defined in [infrastructure](packages/infrastructure/src/config.ts). HTTP API requires HTTP(S) origins; the Android client uses `https://localhost`. Mongo uses TLS and `MONGODB-AWS` authentication, with separate read access for health and read/write access for recipes.

`npm run prepare:access` generates initial permissions in `dist/delivery-access.json`; `npm run synth:foundation` synthesizes the foundation. The [foundation workflow](.github/workflows/foundation.yml) configures the bucket, roles and secret references. `production_domain=true` prepares ACM DNS, the regional TLS domain and its mapping; `certificate_arn` reuses an existing Foodly certificate. Publish its validation CNAME without proxying. Change the `api` CNAME separately, retaining the Cloudflare proxy and Full (strict) TLS. `api_id` restricts management to one API; use `regional_bootstrap=true` only to create it, then disable it once the ID is available.

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

## Traffic recovery

Restore the `api` CNAME for the `shared-ec2-ingress` tunnel with proxying enabled to keep client URLs and return traffic to NestJS on EC2. Keep the tunnel, original container and its credentials operational. Both implementations use the same database, caches and UTC counters: never copy fixtures or restore snapshots over the active database. Do not mirror requests to both APIs.

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

Lambda loads three standard SSM `SecureString` JSON parameters through two environment references:

- `MONGO_PARAMETER_NAME`: JSON containing `MONGO_URI` and, for public access, `ORIGIN_VERIFY_SECRET` with at least 32 characters. Health uses a separate read-only Mongo user; recipes has read/write access to the same production database.
- `PROVIDER_PARAMETER_NAME`: JSON containing `SPOONACULAR_API_KEY`, `AZURE_TRANSLATOR_KEY` and `AZURE_TRANSLATOR_REGION`; recipes only.

Parameter values remain external to artifacts and Git. Do not switch databases or reset `securitycounters` during cutover or recovery. Values retain the instance-lifetime cache, the 2-second read deadline and retry-after-failure behavior. After a sync, change `TEST_RUNTIME_CONFIGURATION_REVISION` in the `test` GitHub environment and run an authorized build/deploy of the same reviewed code. This changes the environment of all four functions and renews their instances. Sync alone does not refresh warm instances. Keep prior provider credentials valid until deployment and in-flight requests finish; coordinate origin rotation with Cloudflare separately. `PUBLIC_ACCESS_ENABLED=true` enables public routes and disables the execute-api endpoint. It requires `api.foodlynotes.app`, a Cloudflare source IP and the shared secret in `X-Foodly-Origin`, added by a Cloudflare rule scoped to that host. Only then is `CF-Connecting-IP` trusted; `X-Forwarded-For` is ignored. Without the flag, routes require AWS_IAM. `REAL_PROVIDERS_ENABLED=true` enables providers only with protected public access. External HTTP uses HTTPS, no redirects/retries, a 30-second timeout and 256 KiB request / 1 MiB decompressed response limits. Requests have a 27-second deadline or remaining Lambda time minus 750 ms.

## Delivery

`TEST_*` parameters are defined in [infrastructure](packages/infrastructure/src/config.ts). HTTP API requires HTTP(S) origins; the Android client uses `https://localhost`. Mongo uses TLS and `MONGODB-AWS` authentication, with separate read access for health and read/write access for recipes.

`npm run prepare:access` generates initial permissions in `dist/delivery-access.json`; `npm run synth:foundation` synthesizes the foundation. The [foundation workflow](.github/workflows/foundation.yml) configures the bucket, roles and scoped SSM read permissions. `production_domain=true` prepares ACM DNS, the regional TLS domain and its mapping; `certificate_arn` reuses an existing Foodly certificate. Publish its validation CNAME without proxying. Change the `api` CNAME separately, retaining the Cloudflare proxy and Full (strict) TLS. `api_id` restricts management to one API; use `regional_bootstrap=true` only to create it, then disable it once the ID is available.

The [build and deploy workflow](.github/workflows/build-and-deploy.yml) takes a reviewed `dev` SHA as `reviewed_sha`, publishes assets and preserves the same reviewed assembly between preparation and execution using OIDC and checksums. Changes enter through PRs, CI and the [merge workflow](.github/workflows/merge.yml).

Recover code through the same delivery flow. Inspect events and resources before retrying a failed creation; `recover_empty_stack=true` only accepts stacks without retained resources.

## Synchronizing sensitive configuration

| Parameter                         | GitHub environment secret  | Readers                      |
| --------------------------------- | -------------------------- | ---------------------------- |
| `/foodly-notes/test/mongo-health` | `FOODLY_HEALTH_MONGO_JSON` | health                       |
| `/foodly-notes/test/mongo`        | `FOODLY_MONGO_JSON`        | catalog, detail, ingredients |
| `/foodly-notes/test/providers`    | `FOODLY_PROVIDERS_JSON`    | catalog, detail, ingredients |

The `test` namespace is the existing deployment identity, including public production traffic. Set `TEST_HEALTH_MONGO_PARAMETER_NAME`, `TEST_MONGO_PARAMETER_NAME` and `TEST_PROVIDER_PARAMETER_NAME` to the names above. Set a nonempty `TEST_RUNTIME_CONFIGURATION_REVISION` (letters, digits, `.`, `_`, `-`; at most 128 characters). Health and recipe Mongo identities remain separate even when their MongoDB-AWS URI matches.

Create the protected GitHub environment `production-parameters`: allow only `dev`, require a reviewer, prevent self-review and disable protection bypass. Store the complete original JSON payloads in its three Secrets, with identical `ORIGIN_VERIFY_SECRET` in both Mongo payloads. Update one key by editing its complete JSON in the corresponding GitHub Actions Secret; retain the other fields. In the official [GitHub Actions extension for VS Code](https://github.com/github/vscode-github-actions#readme), open **Settings**, select the `production-parameters` environment and manage its Secrets; then run **Sync runtime parameters** on `dev` from the Workflows panel. The GitHub web UI provides the same operations under **Settings → Environments** and **Actions**. Do not put credentials in VS Code settings, terminal arguments or Git.

The [sync workflow](.github/workflows/sync-parameters.yml) runs only through `workflow_dispatch`. Choose `mongo-health`, `mongo`, `providers`, `mongo-domains` (both Mongo parameters) or `all`. Each selected Secret must contain a complete valid JSON object, no empty required fields, at most 4096 UTF-8 bytes. All selected payloads are checked before writing; unselected parameters are untouched. Original JSON and string values are sent unchanged. A failed write stops the operation: earlier writes can have succeeded; the summary lists only successful parameter names and versions. Correct GitHub Secrets and rerun the chosen subset; never read/merge existing SSM credentials in the writer.

`npm run prepare:access -- <api-id>` generates a dedicated sync boundary and OIDC role in `dist/delivery-access.json`, for separately authorized administration. Attach `parameterSyncBoundary` to the sync role as its permissions boundary, and use its supplied trust and permissions. It permits only `ssm:PutParameter` on the three exact ARNs and `kms:Encrypt` via SSM with their `PARAMETER_ARN` encryption context; no reads, decrypt, deletes or Lambda updates. Runtime policies allow only their assigned parameter ARNs and corresponding KMS contexts. The administrator applies the generated ceiling to existing application roles; effective per-role permissions stay in foundation.

Encryption uses the account-managed `alias/aws/ssm`, as in Portfolio. No new KMS keys are created. A single shared customer-managed key can provide stricter administrative isolation across projects using the same exact parameter ARNs and encryption contexts, but requires separately approved key-policy/IAM changes and an explicit writer KeyId change. `aws/ssm` does not provide that administrative boundary: another identity with broad SSM read permission can decrypt these parameters. Do not grant broader SSM access to runtime roles.

`LegacyConfigurationAccess=true` (workflow input `legacy_secrets_access`) preserves only the previous scoped Secrets Manager reads for transition and rollback. Foundation no longer creates secrets or embeds their values; its review permits removing only the three former secret resources from CloudFormation management when the existing template has both retention policies set to `Retain`. The physical secrets survive. After production validation and explicit approval, apply foundation with `legacy_secrets_access=false`, regenerate the ceiling with `node scripts/prepare-access.mjs <api-id> none`, and apply it through authorized administration. Deletion of retained secrets is a separate, explicitly approved manual operation.

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

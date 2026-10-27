# Local development

[Español](DEVELOPMENT.es.md)

Use WSL/Linux with Node 24.22.1 (`.nvmrc`) and Python 3 for ZIP creation.

```sh
nvm use
npm ci --ignore-scripts
npm run check
```

`check` runs lint, formatting, type checking, HTTP and isolated Mongo tests, then builds/smoke-tests the two Lambda bundles and local CDK assembly. The first test run downloads MongoDB 8.2.6 (about 123 MiB). Tests start their own ephemeral server on loopback and never use `MONGO_URI`, AWS credentials or recipe/translation providers. No Docker or existing database is needed. The server and its data are removed after the suite.

The runtime exposes health and six recipe operations with existing contracts. CDK declares four Lambda groups: health; catalog (list/daily/search); detail (detail/similar); ingredients (batch). src/http/routes.ts defines method/path/group for both the stack and per-group operation selection. Middy retains HTTP middleware. Gateway has thirteen explicit GET/HEAD/POST routes, with no ANY, $default route or {proxy+}; it handles CORS/preflight.

Spoonacular and Azure are encapsulated in `src/recipes/providers/client.ts`; tests inject simulated transport. Runtime settings: `SPOONACULAR_BASE_URL`, `SPOONACULAR_API_KEY`, `AZURE_TRANSLATOR_KEY`, `AZURE_TRANSLATOR_REGION` and optional `AZURE_TRANSLATOR_ENDPOINT`. UTC daily budgets: `SPOONACULAR_DAILY_REQUEST_LIMIT=100` and `AZURE_DAILY_CHARACTER_LIMIT=50000`; per-instance concurrency `PROVIDER_MAX_CONCURRENCY=4` (capped at 4). No redirects or retries; each call has a 5 s timeout, 1 MiB response limit and 256 KiB body limit. Azure batches at 100 texts and 50,000 characters per batch. Failed translation returns base content; search preserves the original query when translation fails.

Requests get up to 27 seconds (or remaining Lambda time minus 750 ms), with HTTP/DB cancellation and 503/Retry-After before Gateway; recipes declares 29 seconds. Ingredients uses batch cache reads, informationBulk and grouped translation with up to four concurrent Azure batches. Virtual clock: 20 minimal recipes at 4,999 ms per call complete in 9,998 ms. Real ephemeral Mongo: 20 recipes with 15 unique ingredients, 660 texts and simulated 4,900 ms providers complete in approximately 15 seconds. These are local tests without real AWS/provider latency; real 4,999 ms delays can reach the 5-second timeout due to scheduling. Broader content retains limits/deadline. [Delivery and limits](DELIVERY.md).

Health now returns an array of independent HTTP configuration and Mongo ping checks, each with name/status. A failure neither skips nor invalidates other checks; 200 when all pass, otherwise 503/Retry-After. Each check gets up to 2 seconds or remaining Lambda time minus 500 ms. It performs no writes, provider calls or quotas. Health uses pool 1; recipes retains pool 4. This explicitly replaces the previous liveness response.

`npm run build` creates dist/health.zip and dist/recipes.zip, each containing one ESM bundle. Three recipe Lambdas share the ZIP with catalog/detail/ingredients exports; health has its own handler. Smoke checks cover seven operations through four exports. Status/context/tests/secrets/maps and infrastructure are excluded by construction.

`infra/stack.ts` directly declares Lambdas, integrations, routes, logs and invocation permissions using CDK. `infra/config.ts` validates secret/role ARNs and existing subnets/SGs, without lookups or secret reads. Test access uses IAM, six aggregate active invocations and disabled real providers. Runtime indexes remain disabled; secret values are loaded only in Lambda.

`npm run synth:local` uses synthetic infra/local-settings.json parameters, synthesizes CloudFormation/two ZIP assets into cdk.out and reviews the assembly. It requires no external service account/key or real AWS credentials. For actual test parameters, set the non-sensitive DELIVERY variables and run npm run synth after build. Do not deploy/bootstrap before IAM/network/cost/recovery review. The manual build and deploy workflow retains the same reviewed assembly between preparation and OIDC execution. [Delivery and limits](DELIVERY.md).

Public runtime access, Cloudflare visitor verification, production secret loading, Mongo networking and real ingredient latency measurements belong to the delivery stage. This runtime is not ready to receive production traffic.

CORS is configured in HTTP API with explicit origins and exposed Retry-After/quota headers; preflight does not invoke Lambda. Unknown routes return Gateway’s own JSON; operation errors retain their JSON contract. Configuration and integration selection are tested locally; actual Gateway matching, CORS and pre-integration 404 responses are verified in stage 4. Size concurrency/pools across the four Lambda groups.

## Organization and quality

`src/health/` contains its independent handler. `src/recipes/` groups the handler, service, validation, mapping, models and `providers/`. `src/http/` holds middleware, routes and quotas; `src/runtime/` holds configuration, Mongo connection/persistence and SingleFlight. Build entries point to `health/handler.ts` and `recipes/handler.ts`.

- `npm run lint` checks code and JSDoc with Oxlint; `npm run lint:fix` applies available fixes.
- `npm run format:check` checks Prettier; `npm run format` applies formatting. Both honor `.gitignore`.
- `npm test` and `npm run test:watch` use Vitest with the verbose reporter: executed test names are visible.
- `npm run check` requires lint, format, types, tests, build and local CDK synthesis; CI already runs this command.

Formatting: two spaces, single quotes, semicolons, width 100 and LF. Separate methods and functions with one blank line, including object methods; Prettier preserves spacing and Stylistic enforces it for classes and function declarations. Avoid blank lines within blocks when they do not improve readability.

Use JSDoc for public contracts and operations whose limits, effects, fallbacks or concurrency are not obvious. Describe purpose and relevant behavior; use `@param`, `@returns` and `@throws` when useful, without repeating TypeScript types. Regular comments explain a decision, constraint or non-obvious behavior near the code. Both are written in Spanish and kept aligned with implementation; avoid narrating every statement.

Exact versions and lockfile: latest LTS where the project publishes one; otherwise, latest compatible stable release without prereleases. Node and its types stay on the same Lambda-supported LTS line. Oxlint avoids typescript-eslint's incompatible TypeScript 7 peer; Stylistic runs through Oxlint's JS plugin support. An update is not ready until `check` passes.

## Repository integration

`dev` is the default integration branch; promote reviewed changes to `main` through PRs. Both branches require the GitHub Actions `repository` check on an up-to-date base, resolved conversations and merge commits; direct pushes, deletion and force pushes are blocked. No external approval is required for this personal repository. Work branches use `feat/`, `fix/` or `release/`.

The manual merge workflow accepts a PR number and its reviewed head SHA, checks required CI and verifies `matigaleanodev` as the real user before and after merging. It runs from a protected branch and can promote a PR from dev to main. GitHub enforces the active protections at merge time. The workflow never checks out PR code or uses an App token as fallback. Its `merge` environment allows only `main`/`dev`; `MERGE_USER_TOKEN` must be provisioned there and `MERGE_WORKFLOW_ENABLED` enabled before use. These credentials are separate from AWS deployment.

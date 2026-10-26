# Local development

[Español](DEVELOPMENT.es.md)

Use WSL/Linux with Node 24.22.1 (`.nvmrc`) and Python 3 for ZIP creation.

```sh
nvm use
npm ci --ignore-scripts
npm run check
```

`check` runs lint, formatting, type checking, HTTP and isolated Mongo tests, then builds and smoke-tests the two Lambda bundles. The first test run downloads MongoDB 8.2.6 (about 123 MiB). Tests start their own ephemeral server on loopback and never use `MONGO_URI`, AWS credentials or recipe/translation providers. No Docker or existing database is needed. The server and its data are removed after the suite.

The runtime exposes health, the stored list, cached detail, UTC daily selection, search, similar recipes and ingredients (`201`, up to 20 recipes in request order). Reads support GET/HEAD, with Gateway handling CORS preflight. It preserves arrays, operation-specific base/translated titles, safe HTML/images, pagination and Mongo quotas. `src/http/routes.ts` declares methods/paths and per-operation integrations. Gateway selects one of seven functions: health and six recipe operations, each with a fixed export. There are no ANY, $default or {proxy+} routes or internal router; Middy retains HTTP middleware.

Spoonacular and Azure are encapsulated in `src/recipes/providers/client.ts`; tests inject simulated transport. Runtime settings: `SPOONACULAR_BASE_URL`, `SPOONACULAR_API_KEY`, `AZURE_TRANSLATOR_KEY`, `AZURE_TRANSLATOR_REGION` and optional `AZURE_TRANSLATOR_ENDPOINT`. UTC daily budgets: `SPOONACULAR_DAILY_REQUEST_LIMIT=100` and `AZURE_DAILY_CHARACTER_LIMIT=50000`; per-instance concurrency `PROVIDER_MAX_CONCURRENCY=4` (capped at 4). No redirects or retries; each call has a 5 s timeout, 1 MiB response limit and 256 KiB body limit. Azure batches at 100 texts and 50,000 characters per batch. Failed translation returns base content; search preserves the original query when translation fails.

Requests get up to 27 s (or remaining Lambda time minus 750 ms), with HTTP/DB cancellation and 503/Retry-After before timeout; local recipes configuration declares 29 s. A virtual-clock simulation of 20 uncached Spanish recipes completes in 10 s with 1 s providers; 4.999 s calls would need almost 50 s and are cancelled at 27 s. The virtual clock uses synthetic persistence; contract tests use real ephemeral Mongo. This detects a risk against the [30 s HTTP API maximum](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html), without proving actual latency. Resolve/measure this extreme before deployment while retaining the synchronous contract.
`npm run build` writes `dist/health.zip` and `dist/recipes.zip`. Each archive contains one ESM bundle only: health is independent and the six recipe functions use recipes.zip with separate exports, sharing services without Lambda-to-Lambda calls. The build checks its input paths, ensures health does not include MongoDB, and invokes all seven handlers from both bundles with synthetic dependencies. Local context, status, tests, environment files and source maps are excluded by construction. The packages still contain third-party code and are not a deployment or IAM review.

`serverless.ts` describes a synthetic local stage with loopback Mongo, a small pool, bounded requests and no external secret resolvers. Runtime indexes are disabled; tests prepare unique recipe/daily/translation indexes and translation/counter TTL indexes in ephemeral databases. Preparing indexes on a real database is a separate operation.

Serverless Framework 4.45.0 requires its own authentication for `serverless package`; AWS OIDC does not replace it. Official Serverless packaging/CloudFormation validation remains pending that setup. Local ZIP generation does not need Serverless authentication. The deployment workflow remains a manual placeholder; do not use this local configuration for a deployment.

Public runtime access, Cloudflare visitor verification, production secret loading, Mongo networking and real ingredient latency measurements belong to the delivery stage. This runtime is not ready to receive production traffic.

CORS is configured in HTTP API with explicit origins and exposed Retry-After/quota headers; preflight does not invoke Lambda. Unknown routes return Gateway’s own JSON; operation errors retain their JSON contract. Configuration and integration selection are tested locally; actual Gateway matching, CORS and pre-integration 404 responses are verified in stage 4. Size concurrency/pools across all seven functions.

## Organization and quality

`src/health/` contains its independent handler. `src/recipes/` groups the handler, service, validation, mapping, models and `providers/`. `src/http/` holds middleware, routes and quotas; `src/runtime/` holds configuration, Mongo connection/persistence and SingleFlight. Build entries point to `health/handler.ts` and `recipes/handler.ts`.

- `npm run lint` checks code and JSDoc with Oxlint; `npm run lint:fix` applies available fixes.
- `npm run format:check` checks Prettier; `npm run format` applies formatting. Both honor `.gitignore`.
- `npm test` and `npm run test:watch` use Vitest with the verbose reporter: executed test names are visible.
- `npm run check` requires lint, format, types, tests and build; CI already runs this command.

Formatting: two spaces, single quotes, semicolons, width 100 and LF. Separate methods and functions with one blank line, including object methods; Prettier preserves spacing and Stylistic enforces it for classes and function declarations. Avoid blank lines within blocks when they do not improve readability.

Use JSDoc for public contracts and operations whose limits, effects, fallbacks or concurrency are not obvious. Describe purpose and relevant behavior; use `@param`, `@returns` and `@throws` when useful, without repeating TypeScript types. Regular comments explain a decision, constraint or non-obvious behavior near the code. Both are written in Spanish and kept aligned with implementation; avoid narrating every statement.

Exact versions and lockfile: latest LTS where the project publishes one; otherwise, latest compatible stable release without prereleases. Node and its types stay on the same Lambda-supported LTS line. Oxlint avoids typescript-eslint's incompatible TypeScript 7 peer; Stylistic runs through Oxlint's JS plugin support. An update is not ready until `check` passes.

## Repository integration

`dev` is the default integration branch; promote reviewed changes to `main` through PRs. Both branches require the GitHub Actions `repository` check on an up-to-date base, resolved conversations and merge commits; direct pushes, deletion and force pushes are blocked. No external approval is required for this personal repository. Work branches use `feat/`, `fix/` or `release/`.

The manual merge workflow accepts a PR number and its reviewed head SHA, checks required CI and verifies `matigaleanodev` as the real user before and after merging. It runs from a protected branch and can promote a PR from dev to main. GitHub enforces the active protections at merge time. The workflow never checks out PR code or uses an App token as fallback. Its `merge` environment allows only `main`/`dev`; `MERGE_USER_TOKEN` must be provisioned there and `MERGE_WORKFLOW_ENABLED` enabled before use. These credentials are separate from AWS deployment.

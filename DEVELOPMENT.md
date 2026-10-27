# Local development

[Español](DEVELOPMENT.es.md)

Use WSL/Linux with Node 24.22.1 (`.nvmrc`), Python 3 for ZIP creation and OpenSSL for ephemeral HTTPS test certificates.

```sh
nvm use
npm ci --ignore-scripts
npm run check
```

`check` runs lint, formatting, type checking, HTTP and isolated Mongo tests, then generates OpenAPI and builds/smoke-tests the two Lambda bundles and local CDK assembly. The first test run downloads MongoDB 8.2.6 (about 123 MiB). Tests start their own ephemeral server on loopback and never use `MONGO_URI`, AWS credentials or recipe/translation providers. No Docker or existing database is needed. The server and its data are removed after the suite.

The runtime exposes health and six recipe operations with existing contracts. CDK declares four Lambda groups: health; catalog (list/daily/search); detail (detail/similar); ingredients (batch). src/http/routes.ts defines method/path/group for both the stack and per-group operation selection. Middy retains HTTP middleware. Gateway has thirteen explicit GET/HEAD/POST routes, with no ANY, $default route or {proxy+}; it handles CORS/preflight.

Spoonacular and Azure are encapsulated in `src/recipes/providers/client.ts`; tests inject the minimal `JsonHttpClient` function from `src/runtime/http-client.ts`. Its factory owns all Axios imports (exact version 1.21.0), uses only the Node HTTP adapter and returns `unknown`; provider schemas/AJV validate JSON before domain mapping, including daily/search envelopes and Azure translations. Official AWS/Mongo SDKs remain unchanged. Runtime settings: `SPOONACULAR_BASE_URL`, `SPOONACULAR_API_KEY`, `AZURE_TRANSLATOR_KEY`, `AZURE_TRANSLATOR_REGION` and optional `AZURE_TRANSLATOR_ENDPOINT`. UTC daily budgets: `SPOONACULAR_DAILY_REQUEST_LIMIT=100` and `AZURE_DAILY_CHARACTER_LIMIT=50000`; per-instance concurrency `PROVIDER_MAX_CONCURRENCY=4` (capped at 4). No redirects, automatic retries or fetch fallback. HTTPS/destination validation remains; environment proxies are disabled. Axios timeout and total-call cancellation are 30,000 ms, with a 1 MiB response limit (including decoded streaming bodies without Content-Length) and 256 KiB JSON request limit. Declared oversized bodies are rejected before reading; HTTP errors close the stream before parsing, preserving 404 mapping. JSON parsing is strict, including rejection of empty or malformed responses. Azure batches at 100 texts and 50,000 characters per batch. Failed translation returns base content; search preserves the original query when translation fails.

Requests get up to 27 seconds (or remaining Lambda time minus 750 ms), with HTTP/DB cancellation and 503/Retry-After before Gateway; recipes declares 29 seconds. Ingredients uses batch cache reads, informationBulk and grouped translation with up to four concurrent Azure batches. Virtual clock: 20 minimal recipes at 4,999 ms per call complete in 9,998 ms. Real ephemeral Mongo: 20 recipes with 15 unique ingredients, 660 texts and simulated 4,900 ms providers complete in approximately 15 seconds. These are local tests without real AWS/provider latency. The deliberate 5 s → 30 s change allows a 6 s provider call to succeed, but retains concurrency slots longer and may leave less time for translation fallback. A stalled operation now reaches the global deadline and returns 503/Retry-After instead of an earlier provider 502; neither Axios nor streaming can extend 27 s or the Lambda margin. Failed/cancelled attempts retain reserved UTC budgets. Lambda/Gateway timeouts are unchanged. Broader content retains limits/deadline. [Delivery and limits](DELIVERY.md).

Transport errors emit one structured `external_http_error` event per attempt, correlated through AsyncLocalStorage with the existing HTTP `x-request-id`. Events are capped at 2 KiB: provider/operation/method, hostname only (IP destinations redacted), status, normalized code, duration and cancellation cause (`deadline`, `lambda_margin`, `axios_timeout`, `caller`). The allowlist includes only JSON content type, numeric Retry-After, safe `number`/`addRecipeInformation`/`api-version`/`to` parameters and body byte/count/language summaries. Credentials, raw paths/queries, identifiers, IPs, text, arbitrary cancellation reasons and Axios objects/messages are never serialized. Logger failures are swallowed; HTTP completion remains a separate access event, with no duplicate transport error log.

`test/http-client.test.ts` exercises the real Node adapter against isolated HTTPS loopback with a generated, explicitly trusted certificate (TLS verification stays enabled). It covers exact byte limits, undeclared/gzip/Brotli overflow, invalid JSON, redirects/statuses/reset, safe logs, translation fallback, socket closure, budget/slot preservation, a real 6 s success, real 30 s timeout (idle and streaming), 27 s global deadline and Lambda margin. Certificates/keys are ephemeral and removed. Provider/domain suites use injectable JSON mocks and ephemeral Mongo; these checks do not validate AWS, real providers or production connectivity.

Health now returns an array of independent HTTP configuration and Mongo ping checks, each with name/status. A failure neither skips nor invalidates other checks; 200 when all pass, otherwise 503/Retry-After. Each check gets up to 2 seconds or remaining Lambda time minus 500 ms. It performs no writes, provider calls or quotas. Health uses pool 1; recipes retains pool 4. This explicitly replaces the previous liveness response.

`npm run build` creates dist/health.zip and dist/recipes.zip, each containing one ESM bundle. Three recipe Lambdas share the ZIP with catalog/detail/ingredients exports; health has its own handler. Smoke checks cover seven operations through four exports. Status/context/tests/secrets/maps and infrastructure are excluded by construction.

`infra/stack.ts` directly declares Lambdas, integrations, routes, logs and invocation permissions using CDK. `infra/config.ts` validates secret/role ARNs and existing subnets/SGs, without lookups or secret reads. Test access uses IAM, six aggregate active invocations and disabled real providers. Runtime indexes remain disabled; secret values are loaded only in Lambda.

`npm run synth:local` uses synthetic infra/local-settings.json parameters, synthesizes CloudFormation/two ZIP assets into cdk.out and reviews the assembly. It requires no external service account/key or real AWS credentials. For actual test parameters, set the non-sensitive DELIVERY variables and run npm run synth after build. Do not deploy/bootstrap before IAM/network/cost/recovery review. The manual build and deploy workflow retains the same reviewed assembly between preparation and OIDC execution. [Delivery and limits](DELIVERY.md).

Public runtime access, Cloudflare visitor verification, production secret loading, Mongo networking and real ingredient latency measurements belong to the delivery stage. This runtime is not ready to receive production traffic.

CORS is configured in HTTP API with explicit origins and exposed Retry-After/quota headers; preflight does not invoke Lambda. Unknown routes return Gateway’s own JSON; operation errors retain their JSON contract. Configuration and integration selection are tested locally; actual Gateway matching, CORS and pre-integration 404 responses are verified in stage 4. Size concurrency/pools across the four Lambda groups.

`src/contracts/` defines neutral draft-07 schemas and types derived with `json-schema-to-ts` (type-only development dependency). Route metadata references inputs, responses for all seven operations, current error statuses and JSON, security, quota and Retry-After headers without importing handlers or runtime clients. Stored/daily/similar share a summary item with optional image; search requires string/null image. Detail retains optional/null metadata; ingredients retains order and arrays without lang or aggregation. Mappers use derived output types; parsing, normalization and defaults remain in runtime.

AJV preserves the Middy flow order: ingredients body in `before`, before quotas; query/path inside the operation, after quotas, query before ID. Errors, counters, repeated parameters, extra fields, limits and HEAD remain unchanged; path parameters other than `id` and health/ingredients queries remain unvalidated. Tests check serialized JSON, statuses, headers and HEAD against contracts with simulated providers/ephemeral Mongo; no runtime response validation or Gateway payload/schema validators are added. Package separation remains pending.

`npm run openapi` generates `dist/openapi.json` (ignored and excluded from ZIPs). It uses [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html#specifying-schema-dialects) with explicit draft-07 dialect, including the health tuple; consumers must support that dialect. It is neither imported into Gateway nor exposed through a documentation route. Tests compare all thirteen operations/statuses/schemas/headers with metadata and synthesized CloudFormation, retaining IAM/CORS/preflight. Errors before Lambda belong to Gateway and require AWS verification.

Public parameters and body use HTTP input schemas (`httpInput`/`x-http-input`): numeric/decimal-string IDs depending on location, language before trim/lowercase and q before trimming; limits apply to the effective value. `request`/`x-canonical-request` retains the schemas AJV uses after normalization (stored-list limit50, effective language defaults to en). The body allows decimal strings and documents uniqueness after Number: standalone `uniqueItems` cannot detect `[1,"001"]`, which runtime rejects. Repeated/extra parameters, JSON16KiB and URL4096 retain existing controls. Common headers describe Lambda; Gateway adds CORS according to origin. Quota headers accompany success only, Retry-After accompanies 429/503 and HEAD retains status/headers without body.

## Organization and quality

`src/health/` contains its independent handler. `src/recipes/` groups the handler, service, validation, mapping, models and `providers/`. `src/http/` holds middleware, routes and quotas; `src/runtime/` holds configuration, Mongo connection/persistence, SingleFlight, the Axios JSON client and request log context. Build entries point to `health/handler.ts` and `recipes/handler.ts`.

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

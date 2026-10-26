# Local development

[Español](DEVELOPMENT.es.md)

Use WSL/Linux with Node 24.19.0 (`.nvmrc`) and Python 3 for ZIP creation.

```sh
nvm use
npm ci --ignore-scripts
npm run check
```

`check` runs type checking, HTTP and isolated Mongo tests, then builds and smoke-tests the two Lambda bundles. The first test run downloads MongoDB 8.2.6 (about 123 MiB). Tests start their own ephemeral server on loopback and never use `MONGO_URI`, AWS credentials or recipe/translation providers. No Docker or existing database is needed. The server and its data are removed after the suite.

The initial runtime exposes `GET`/`HEAD /api/health` and `GET`/`HEAD /api/recipes`, plus CORS preflight. The list preserves its array shape, base titles, safe images, cursor pagination and Mongo-backed IP quotas. Other recipe operations are not implemented yet. `src/routes.ts` supplies both runtime paths and Serverless events; no internal router is needed for the single recipe operation.

`npm run build` writes `dist/health.zip` and `dist/recipes.zip`. Each archive contains one ESM bundle only. The build checks its input paths, ensures health does not include MongoDB, and invokes both bundles with synthetic dependencies. Local context, status, tests, environment files and source maps are excluded by construction. The packages still contain third-party code and are not a deployment or IAM review.

`serverless.ts` describes a synthetic local stage with loopback Mongo, a small pool, bounded requests and no external secret resolvers. Runtime indexes are disabled; tests create their own TTL index. Preparing indexes on a real database is a separate operation.

Serverless Framework 4.45.0 requires its own authentication for `serverless package`; AWS OIDC does not replace it. Official Serverless packaging/CloudFormation validation remains pending that setup. Local ZIP generation does not need Serverless authentication. The deployment workflow remains a manual placeholder; do not use this local configuration for a deployment.

Public runtime access, Cloudflare visitor verification, production secret loading, Mongo networking and remaining recipe/provider routes belong to subsequent increments. This runtime is not ready to receive production traffic.

## Repository integration

`dev` is the default integration branch; promote reviewed changes to `main` through PRs. Both branches require the GitHub Actions `repository` check on an up-to-date base, resolved conversations and merge commits; direct pushes, deletion and force pushes are blocked. No external approval is required for this personal repository. Work branches use `feat/`, `fix/` or `release/`.

The manual merge workflow accepts a PR number and its reviewed head SHA, checks required CI and verifies `matigaleanodev` as the real user before and after merging. It runs from a protected branch and can promote a PR from dev to main. GitHub enforces the active protections at merge time. The workflow never checks out PR code or uses an App token as fallback. Its `merge` environment allows only `main`/`dev`; `MERGE_USER_TOKEN` must be provisioned there and `MERGE_WORKFLOW_ENABLED` enabled before use. These credentials are separate from AWS deployment.

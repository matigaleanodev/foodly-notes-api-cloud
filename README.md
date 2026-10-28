# Foodly Notes API Cloud

[Español](README.es.md)

![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white) ![AWS Lambda](https://img.shields.io/badge/AWS-Lambda-FF9900) ![AWS CDK](https://img.shields.io/badge/IaC-AWS_CDK-FF9900) ![Vitest](https://img.shields.io/badge/tests-Vitest-6E9F18?logo=vitest&logoColor=white)

Serverless API for Foodly Notes, written in TypeScript with AWS Lambda handlers. It retrieves recipes, translates content and returns ingredients while preserving the NestJS implementation contracts.

## Stack and architecture

Node.js 24, strict TypeScript and ESM; HTTP API Gateway v2, ARM64 Lambda, Middy, MongoDB through Mongoose and Secrets Manager. Three private npm workspaces separate infrastructure, runtime and neutral contracts, with one root lockfile. AWS CDK and GitHub Actions handle packaging and delivery through OIDC and verified artifacts.

Four Lambda groups —health, catalog, detail and ingredients— share two ZIPs: health and recipes. Spoonacular supplies recipes and Azure Translator handles translation. Mongo stores recipes, caches, quotas and UTC budgets. Favorites, shopping lists and UI translations belong to the Angular/Ionic frontend.

## Endpoints

| Method | Path                        | Response                                |
| ------ | --------------------------- | --------------------------------------- |
| GET    | `/api/health`               | 200/503 · array of `name/status` checks |
| GET    | `/api/recipes`              | 200 · stored recipes                    |
| GET    | `/api/recipes/daily`        | 200 · daily selection                   |
| GET    | `/api/recipes/search`       | 200 · search results                    |
| GET    | `/api/recipes/{id}`         | 200 · recipe detail                     |
| GET    | `/api/recipes/{id}/similar` | 200 · similar recipes                   |
| POST   | `/api/recipes/ingredients`  | 201 · ingredients per recipe            |

GET routes also support bodyless HEAD. JSON Schema and AJV validate application inputs; OpenAPI is generated from shared contracts. Recipes support `en/es`, ingredient requests accept up to 20 unique IDs, and errors retain controlled statuses and Retry-After when applicable. Gateway handles CORS/preflight; test routes use AWS_IAM.

## Local development

```bash
npm ci --ignore-scripts
npm run check
```

Node 24.22.1 as pinned by `.nvmrc`, Python 3 for ZIP creation and OpenSSL for test certificates. `check` verifies package boundaries, lint, formatting, types, tests, OpenAPI, bundles and local CDK synthesis. Tests use ephemeral loopback Mongo/HTTPS and simulated providers.

## Documentation

- [Development, configuration and delivery](DEVELOPMENT.md)

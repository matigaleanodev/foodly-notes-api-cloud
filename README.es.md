# Foodly Notes API Cloud

[English](README.md)

![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white) ![AWS Lambda](https://img.shields.io/badge/AWS-Lambda-FF9900) ![AWS CDK](https://img.shields.io/badge/IaC-AWS_CDK-FF9900) ![Vitest](https://img.shields.io/badge/tests-Vitest-6E9F18?logo=vitest&logoColor=white)

API serverless de Foodly Notes, escrita en TypeScript con handlers para AWS Lambda. Consulta recetas, traduce contenido y devuelve ingredientes conservando los contratos de la implementación NestJS.

## Stack y arquitectura

Node.js 24, TypeScript estricto y ESM; HTTP API Gateway v2, Lambda ARM64, Middy, MongoDB mediante Mongoose y Secrets Manager. Tres npm workspaces privados separan infraestructura, runtime y contratos neutrales, con un único lockfile raíz. AWS CDK y GitHub Actions resuelven empaquetado y entrega mediante OIDC y artifacts verificados.

Cuatro grupos Lambda —health, catalog, detail e ingredients— comparten dos ZIP: health y recipes. Spoonacular provee recetas y Azure Translator realiza las traducciones. Mongo conserva recetas, cachés, cuotas y presupuestos UTC. Favoritos, listas de compras y traducciones de UI pertenecen al frontend Angular/Ionic.

## Endpoints

| Método | Ruta                        | Respuesta                               |
| ------ | --------------------------- | --------------------------------------- |
| GET    | `/api/health`               | 200/503 · array de checks `name/status` |
| GET    | `/api/recipes`              | 200 · recetas persistidas               |
| GET    | `/api/recipes/daily`        | 200 · selección diaria                  |
| GET    | `/api/recipes/search`       | 200 · resultados de búsqueda            |
| GET    | `/api/recipes/{id}`         | 200 · detalle de receta                 |
| GET    | `/api/recipes/{id}/similar` | 200 · recetas similares                 |
| POST   | `/api/recipes/ingredients`  | 201 · ingredientes por receta           |

Las rutas GET también admiten HEAD sin body. JSON Schema y AJV validan entradas de aplicación; OpenAPI se genera desde los contratos compartidos. Las recetas admiten `en/es`, ingredientes acepta hasta 20 IDs únicos y los errores conservan estados controlados y Retry-After cuando corresponde. La URL pública es `https://api.foodlynotes.app/api`. Gateway resuelve CORS/preflight; el acceso público exige Cloudflare y un secreto de origen, con cuotas por visitante verificado. El modo privado usa AWS_IAM.

## Desarrollo local

```bash
npm ci --ignore-scripts
npm run check
```

Node 24.22.1 según `.nvmrc`, Python 3 para crear ZIP y OpenSSL para certificados de prueba. `check` verifica límites de paquetes, lint, formato, tipos, pruebas, OpenAPI, bundles y síntesis CDK local. Las pruebas usan Mongo/HTTPS efímeros en loopback y proveedores simulados.

## Documentación

- [Desarrollo, configuración y entrega](DEVELOPMENT.es.md)

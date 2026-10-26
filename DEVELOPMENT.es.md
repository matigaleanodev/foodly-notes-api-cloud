# Desarrollo local

[English](DEVELOPMENT.md)

Usar WSL/Linux con Node 24.19.0 (`.nvmrc`) y Python 3 para crear ZIP.

```sh
nvm use
npm ci --ignore-scripts
npm run check
```

`check` ejecuta tipos, pruebas HTTP y Mongo aislado, y después genera y verifica los dos bundles Lambda. La primera ejecución descarga MongoDB 8.2.6 (unos 123 MiB). Las pruebas inician su propio servidor efímero en loopback y nunca usan `MONGO_URI`, credenciales AWS ni proveedores de recetas/traducción. No requieren Docker ni una base existente. El servidor y sus datos se eliminan al terminar la suite.

El runtime inicial expone `GET`/`HEAD /api/health` y `GET`/`HEAD /api/recipes`, más preflight CORS. El listado conserva el array, títulos base, imágenes seguras, paginación por cursor y cuotas por IP en Mongo. Las otras operaciones de recetas todavía no están implementadas. `src/routes.ts` alimenta rutas de runtime y eventos Serverless; una sola operación de recetas todavía no necesita router interno.

`npm run build` escribe `dist/health.zip` y `dist/recipes.zip`. Cada ZIP contiene un único bundle ESM. El build comprueba las rutas de entrada, que health no incluya MongoDB e invoca ambos bundles con dependencias sintéticas. Contexto local, status, tests, archivos de entorno y source maps quedan excluidos por construcción. Los paquetes incluyen código de terceros y no equivalen a una revisión de despliegue/IAM.

`serverless.ts` describe una etapa local sintética con Mongo en loopback, pool pequeño, requests acotados y ningún resolvedor de secretos externo. Los índices runtime están deshabilitados; las pruebas preparan su propio índice TTL. Preparar índices en una base real es una operación separada.

Serverless Framework 4.45.0 exige autenticación propia para `serverless package`; OIDC de AWS no la reemplaza. El packaging oficial de Serverless y la validación de CloudFormation quedan pendientes de esa configuración. Generar los ZIP locales no necesita autenticación Serverless. El workflow de despliegue sigue como placeholder manual; esta configuración local no se usa para desplegar.

El acceso público, la verificación del visitante Cloudflare, la carga de secretos productivos, la red de Mongo y las rutas restantes de recetas/proveedores corresponden a incrementos posteriores. Este runtime todavía no está listo para recibir tráfico productivo.

## Integración del repositorio

`dev` es la rama predeterminada de integración; los cambios revisados se promueven a `main` mediante PR. Ambas ramas exigen el check `repository` de GitHub Actions con base actualizada, conversaciones resueltas y merge commits; bloquean push directo, borrado y force push. No se requiere aprobación externa para este repositorio personal. Las ramas de trabajo usan `feat/`, `fix/` o `release/`.

El workflow manual de merge recibe número de PR y SHA revisado, comprueba CI requerida y verifica a `matigaleanodev` como usuario real antes y después del merge. Se ejecuta desde una rama protegida y puede promover un PR de dev a main. GitHub aplica las protecciones vigentes al integrar. El workflow no ejecuta código del PR ni usa un token de App como fallback. Su environment `merge` admite solo `main`/`dev`; antes de usarlo se provisiona allí `MERGE_USER_TOKEN` y se activa `MERGE_WORKFLOW_ENABLED`. Estas credenciales son independientes del despliegue AWS.

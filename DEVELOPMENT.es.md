# Desarrollo local

[English](DEVELOPMENT.md)

Usar WSL/Linux con Node 24.22.1 (`.nvmrc`) y Python 3 para crear ZIP.

```sh
nvm use
npm ci --ignore-scripts
npm run check
```

`check` ejecuta lint, formato, tipos, pruebas HTTP y Mongo aislado, y después genera y verifica los dos bundles Lambda. La primera ejecución descarga MongoDB 8.2.6 (unos 123 MiB). Las pruebas inician su propio servidor efímero en loopback y nunca usan `MONGO_URI`, credenciales AWS ni proveedores de recetas/traducción. No requieren Docker ni una base existente. El servidor y sus datos se eliminan al terminar la suite.

El runtime expone health, listado persistido, detalle con caché, selección diaria UTC, búsqueda, similares e ingredientes (`201`, hasta 20 recetas en orden). Las lecturas admiten GET/HEAD y Gateway resuelve preflight CORS. Conserva arrays, títulos base/traducidos según operación, HTML e imágenes seguros, paginación y cuotas Mongo. `src/http/routes.ts` declara métodos/rutas e integración por operación. Gateway selecciona una de siete funciones: health y seis de recetas, cada una con un export fijo. No hay rutas ANY, $default o {proxy+}, ni router interno; Middy conserva los middleware HTTP.

Spoonacular y Azure están encapsulados en `src/recipes/providers/client.ts`; las pruebas inyectan transporte simulado. Configuración runtime: `SPOONACULAR_BASE_URL`, `SPOONACULAR_API_KEY`, `AZURE_TRANSLATOR_KEY`, `AZURE_TRANSLATOR_REGION` y `AZURE_TRANSLATOR_ENDPOINT` opcional. Presupuestos diarios UTC: `SPOONACULAR_DAILY_REQUEST_LIMIT=100` y `AZURE_DAILY_CHARACTER_LIMIT=50000`; concurrencia por instancia `PROVIDER_MAX_CONCURRENCY=4` (máximo 4). Sin redirects ni reintentos; cada llamada tiene 5 s, respuesta máxima 1 MiB y body máximo 256 KiB. Azure divide en lotes de 100 textos y hasta 50.000 caracteres por lote. La traducción fallida devuelve contenido base; búsqueda conserva la consulta original si no puede traducirla.

El request dispone de hasta 27 s (o el tiempo Lambda restante menos 750 ms), con cancelación HTTP/DB y respuesta 503/Retry-After antes del timeout; recipes declara 29 s en la configuración local. La simulación con reloj virtual de 20 recetas españolas sin caché completa en 10 s con proveedores de 1 s; con llamadas de 4,999 s necesitaría casi 50 s y se cancela a los 27 s. El reloj virtual usa persistencia sintética; las pruebas de contratos usan Mongo efímero real. Esto detecta un riesgo frente al [máximo HTTP API de 30 s](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html), sin probar latencia real. Antes del despliegue hay que resolver/medir este extremo manteniendo el contrato síncrono.
`npm run build` escribe `dist/health.zip` y `dist/recipes.zip`. Cada ZIP contiene un único bundle ESM: health es independiente y las seis funciones de recetas usan recipes.zip con exports separados, reutilizando servicios sin llamadas Lambda a Lambda. El build comprueba las rutas de entrada, que health no incluya MongoDB e invoca los siete handlers desde ambos bundles con dependencias sintéticas. Contexto local, status, tests, archivos de entorno y source maps quedan excluidos por construcción. Los paquetes incluyen código de terceros y no equivalen a una revisión de despliegue/IAM.

`serverless.ts` describe una etapa local sintética con Mongo en loopback, pool pequeño, requests acotados y ningún resolvedor de secretos externo. Los índices runtime están deshabilitados; las pruebas preparan índices únicos de recetas/daily/traducciones y TTL de traducciones/contadores en bases efímeras. Preparar índices en una base real es una operación separada.

Serverless Framework 4.45.0 exige autenticación propia para `serverless package`; OIDC de AWS no la reemplaza. El packaging oficial de Serverless y la validación de CloudFormation quedan pendientes de esa configuración. Generar los ZIP locales no necesita autenticación Serverless. El workflow de despliegue sigue como placeholder manual; esta configuración local no se usa para desplegar.

El acceso público, la verificación del visitante Cloudflare, la carga de secretos productivos, la red de Mongo y las mediciones reales de ingredientes corresponden a la etapa de entrega. Este runtime todavía no está listo para recibir tráfico productivo.

CORS se configura en HTTP API con orígenes explícitos y exposición de Retry-After/cuotas; el preflight no invoca Lambda. Las rutas inexistentes devuelven el JSON propio de Gateway; los errores de las operaciones preservan su contrato JSON. La configuración y selección de integración se prueban localmente; CORS, 404 previos a integración y matching real de Gateway se verifican en etapa 4. Dimensionar concurrencia/pools sobre el conjunto de siete funciones.

## Organización y calidad

`src/health/` contiene su handler independiente. `src/recipes/` agrupa handler, servicio, validación, mapeos, modelos y `providers/`. `src/http/` reúne middleware, rutas y cuotas; `src/runtime/` mantiene configuración, conexión/persistencia Mongo y SingleFlight. Las entradas del build apuntan a `health/handler.ts` y `recipes/handler.ts`.

- `npm run lint` valida código y JSDoc con Oxlint; `npm run lint:fix` aplica correcciones disponibles.
- `npm run format:check` comprueba Prettier; `npm run format` aplica el formato. Ambos respetan `.gitignore`.
- `npm test` y `npm run test:watch` usan Vitest con reporter verbose: muestran los nombres de los casos ejecutados.
- `npm run check` exige lint, formato, tipos, tests y build; el workflow de CI ya ejecuta ese comando.

Formato: dos espacios, comillas simples, punto y coma, ancho 100 y LF. Separar métodos y funciones con una línea vacía, también en objetos; Prettier conserva la separación y Stylistic exige separación en clases y declaraciones de funciones. Evitar líneas vacías dentro de bloques que no aporten lectura.

JSDoc en contratos públicos y operaciones cuyos límites, efectos, fallbacks o concurrencia no sean evidentes. Describir propósito y comportamiento relevante; usar `@param`, `@returns` y `@throws` cuando aporten información, sin repetir tipos de TypeScript. Los comentarios normales explican el porqué de una decisión, una restricción o un comportamiento poco evidente cerca del código. Ambos van en español y se actualizan con la implementación; evitar narrar cada instrucción.

Versiones exactas y lockfile: última LTS donde el proyecto la publique; para paquetes sin LTS, última estable compatible y sin prereleases. Node y sus tipos permanecen en la misma línea LTS admitida por Lambda. Oxlint evita el peer incompatible de typescript-eslint con TypeScript 7; Stylistic se usa mediante el soporte de plugins JS de Oxlint. Una actualización no se considera lista hasta pasar `check`.

## Integración del repositorio

`dev` es la rama predeterminada de integración; los cambios revisados se promueven a `main` mediante PR. Ambas ramas exigen el check `repository` de GitHub Actions con base actualizada, conversaciones resueltas y merge commits; bloquean push directo, borrado y force push. No se requiere aprobación externa para este repositorio personal. Las ramas de trabajo usan `feat/`, `fix/` o `release/`.

El workflow manual de merge recibe número de PR y SHA revisado, comprueba CI requerida y verifica a `matigaleanodev` como usuario real antes y después del merge. Se ejecuta desde una rama protegida y puede promover un PR de dev a main. GitHub aplica las protecciones vigentes al integrar. El workflow no ejecuta código del PR ni usa un token de App como fallback. Su environment `merge` admite solo `main`/`dev`; antes de usarlo se provisiona allí `MERGE_USER_TOKEN` y se activa `MERGE_WORKFLOW_ENABLED`. Estas credenciales son independientes del despliegue AWS.

# Desarrollo local

[English](DEVELOPMENT.md)

Usar WSL/Linux con Node 24.22.1 (`.nvmrc`) y Python 3 para crear ZIP.

```sh
nvm use
npm ci --ignore-scripts
npm run check
```

`check` ejecuta lint, formato, tipos, pruebas HTTP y Mongo aislado, y después genera OpenAPI y genera/verifica los dos bundles y la assembly CDK local. La primera ejecución descarga MongoDB 8.2.6 (unos 123 MiB). Las pruebas inician su propio servidor efímero en loopback y nunca usan `MONGO_URI`, credenciales AWS ni proveedores de recetas/traducción. No requieren Docker ni una base existente. El servidor y sus datos se eliminan al terminar la suite.

El runtime expone health y las seis operaciones de recetas, con contratos existentes. CDK declara cuatro Lambdas por responsabilidad: health; catalog (listado/daily/búsqueda); detail (detalle/similares); ingredients (lote). src/http/routes.ts contiene método/ruta/grupo, usados tanto por el stack como por la selección de operación dentro de los grupos. Middy conserva los middleware HTTP. Gateway tiene trece rutas GET/HEAD/POST explícitas, sin ANY, ruta $default ni {proxy+}; resuelve CORS/preflight.

Spoonacular y Azure están encapsulados en `src/recipes/providers/client.ts`; las pruebas inyectan transporte simulado. Configuración runtime: `SPOONACULAR_BASE_URL`, `SPOONACULAR_API_KEY`, `AZURE_TRANSLATOR_KEY`, `AZURE_TRANSLATOR_REGION` y `AZURE_TRANSLATOR_ENDPOINT` opcional. Presupuestos diarios UTC: `SPOONACULAR_DAILY_REQUEST_LIMIT=100` y `AZURE_DAILY_CHARACTER_LIMIT=50000`; concurrencia por instancia `PROVIDER_MAX_CONCURRENCY=4` (máximo 4). Sin redirects ni reintentos; cada llamada tiene 5 s, respuesta máxima 1 MiB y body máximo 256 KiB. Azure divide en lotes de 100 textos y hasta 50.000 caracteres por lote. La traducción fallida devuelve contenido base; búsqueda conserva la consulta original si no puede traducirla.

El request dispone de hasta 27 s (o el tiempo Lambda restante menos 750 ms), con cancelación HTTP/DB y 503/Retry-After antes de Gateway; recipes declara 29 s. Ingredientes usa caché en lote, informationBulk y traducciones agrupadas, con hasta cuatro lotes Azure simultáneos. Reloj virtual: 20 recetas mínimas a 4.999 ms por llamada completan en 9.998 ms. Mongo efímero real: 20 recetas con 15 ingredientes únicos, 660 textos y proveedores simulados de 4.900 ms completan alrededor de 15 s. Son pruebas locales, sin latencia AWS/proveedores reales; el extremo real de 4.999 ms puede alcanzar el timeout de 5 s por scheduling. Contenido más amplio mantiene límites/deadline. [Entrega y límites](DELIVERY.es.md).

Health ahora devuelve un array de checks independientes de configuración HTTP y ping Mongo, cada uno con name/status. Un fallo no omite ni invalida los demás; 200 si todos pasan, 503/Retry-After si alguno falla. Cada check tiene hasta 2 s o el tiempo Lambda restante menos 500 ms. No escribe, no consulta proveedores ni consume cuotas. Health usa pool 1, recipes conserva pool 4. Este cambio reemplaza expresamente la respuesta de liveness anterior.

`npm run build` genera dist/health.zip y dist/recipes.zip, cada uno con un bundle ESM. Las tres Lambdas de recetas comparten ZIP con exports catalog/detail/ingredients; health tiene handler propio. El smoke verifica las siete operaciones a través de cuatro exports. Status/contexto/tests/secretos/maps e infraestructura quedan excluidos por construcción.

`infra/stack.ts` declara Lambdas, integraciones, rutas, logs y permisos de invocación directamente con CDK. `infra/config.ts` valida ARN/roles y subnets/SG existentes; no hace lookups ni lee secretos. Usa IAM para acceso de prueba, seis invocaciones activas agregadas y proveedores reales deshabilitados. Runtime conserva índices deshabilitados y carga secretos solo desde Lambda.

`npm run synth:local` usa parámetros sintéticos de infra/local-settings.json, sintetiza CloudFormation y dos assets ZIP en cdk.out y revisa la assembly. No requiere cuenta/clave de otro servicio ni credenciales AWS reales. Para parámetros reales de test: configurar las variables no sensibles de DELIVERY y ejecutar npm run synth después del build. No ejecutar deploy/bootstrap sin cerrar IAM/red/costos y recuperación. El workflow manual build and deploy conserva la misma assembly revisada entre preparación y ejecución OIDC. [Entrega y límites](DELIVERY.es.md).

El acceso público, la verificación del visitante Cloudflare, la carga de secretos productivos, la red de Mongo y las mediciones reales de ingredientes corresponden a la etapa de entrega. Este runtime todavía no está listo para recibir tráfico productivo.

CORS se configura en HTTP API con orígenes explícitos y exposición de Retry-After/cuotas; el preflight no invoca Lambda. Las rutas inexistentes devuelven el JSON propio de Gateway; los errores de las operaciones preservan su contrato JSON. La configuración y selección de integración se prueban localmente; CORS, 404 previos a integración y matching real de Gateway se verifican en etapa 4. Dimensionar concurrencia/pools sobre los cuatro grupos Lambda.

`src/contracts/` define schemas draft-07 neutrales y tipos derivados con `json-schema-to-ts` (solo tipos, dependencia de desarrollo). La metadata de rutas referencia entradas, respuestas de las siete operaciones, estados de error actuales y headers JSON, seguridad, cuotas y Retry-After, sin importar handlers ni clientes runtime. Listado/daily/similares comparten el item de resumen con imagen opcional; búsqueda exige imagen string/null. Detalle conserva metadatos opcionales/null, ingredientes conserva orden y arrays sin lang ni agregación. Los mappers usan tipos de salida derivados; parsing, normalización y defaults permanecen en runtime.

AJV conserva el orden del flujo Middy: body de ingredientes en `before`, antes de cuotas; query/path dentro de la operación, después de cuotas, query antes de ID. Se preservan errores, contadores, parámetros repetidos, extras, límites y HEAD; parámetros de path ajenos a `id` y queries de health/ingredientes siguen sin validarse. Las pruebas comprueban JSON serializado, estados, headers y HEAD contra los contratos, con proveedores simulados/Mongo efímero; no hay validación runtime de respuestas ni validadores de payload/schema en Gateway. Axios y separación de paquetes quedan pendientes.

`npm run openapi` genera `dist/openapi.json` (ignorado y fuera de ZIP). Usa [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html#specifying-schema-dialects) con dialecto draft-07 explícito, incluida la tupla health; requiere tooling compatible con ese dialecto. No se importa en Gateway ni se publica una ruta de documentación. Las pruebas contrastan sus trece operaciones/estados/schemas/headers con metadata y CloudFormation sintetizado, sin cambiar IAM/CORS/preflight. Los errores anteriores a Lambda pertenecen a Gateway y requieren verificación en AWS.

Los parámetros y body públicos usan schemas de entrada HTTP (`httpInput`/`x-http-input`): IDs number/string decimal según ubicación, idioma con trim/case y q antes de recortar; los límites se aplican al valor efectivo. `request`/`x-canonical-request` conserva los schemas usados por AJV después de normalizar (listado limit50, idioma efectivo en por omisión). El body permite strings decimales y documenta la unicidad después de Number: `uniqueItems` aislado no detecta `[1,"001"]`, que el runtime rechaza. Repetidos/extras, JSON16KiB y URL4096 siguen bajo los controles existentes. Los headers comunes descritos son de Lambda; CORS lo agrega Gateway según el origen. Los headers de cuota solo acompañan éxitos, Retry-After acompaña 429/503 y HEAD conserva estado/headers sin body.

## Organización y calidad

`src/health/` contiene su handler independiente. `src/recipes/` agrupa handler, servicio, validación, mapeos, modelos y `providers/`. `src/http/` reúne middleware, rutas y cuotas; `src/runtime/` mantiene configuración, conexión/persistencia Mongo y SingleFlight. Las entradas del build apuntan a `health/handler.ts` y `recipes/handler.ts`.

- `npm run lint` valida código y JSDoc con Oxlint; `npm run lint:fix` aplica correcciones disponibles.
- `npm run format:check` comprueba Prettier; `npm run format` aplica el formato. Ambos respetan `.gitignore`.
- `npm test` y `npm run test:watch` usan Vitest con reporter verbose: muestran los nombres de los casos ejecutados.
- `npm run check` exige lint, formato, tipos, tests, build y síntesis CDK local; el workflow de CI ya ejecuta ese comando.

Formato: dos espacios, comillas simples, punto y coma, ancho 100 y LF. Separar métodos y funciones con una línea vacía, también en objetos; Prettier conserva la separación y Stylistic exige separación en clases y declaraciones de funciones. Evitar líneas vacías dentro de bloques que no aporten lectura.

JSDoc en contratos públicos y operaciones cuyos límites, efectos, fallbacks o concurrencia no sean evidentes. Describir propósito y comportamiento relevante; usar `@param`, `@returns` y `@throws` cuando aporten información, sin repetir tipos de TypeScript. Los comentarios normales explican el porqué de una decisión, una restricción o un comportamiento poco evidente cerca del código. Ambos van en español y se actualizan con la implementación; evitar narrar cada instrucción.

Versiones exactas y lockfile: última LTS donde el proyecto la publique; para paquetes sin LTS, última estable compatible y sin prereleases. Node y sus tipos permanecen en la misma línea LTS admitida por Lambda. Oxlint evita el peer incompatible de typescript-eslint con TypeScript 7; Stylistic se usa mediante el soporte de plugins JS de Oxlint. Una actualización no se considera lista hasta pasar `check`.

## Integración del repositorio

`dev` es la rama predeterminada de integración; los cambios revisados se promueven a `main` mediante PR. Ambas ramas exigen el check `repository` de GitHub Actions con base actualizada, conversaciones resueltas y merge commits; bloquean push directo, borrado y force push. No se requiere aprobación externa para este repositorio personal. Las ramas de trabajo usan `feat/`, `fix/` o `release/`.

El workflow manual de merge recibe número de PR y SHA revisado, comprueba CI requerida y verifica a `matigaleanodev` como usuario real antes y después del merge. Se ejecuta desde una rama protegida y puede promover un PR de dev a main. GitHub aplica las protecciones vigentes al integrar. El workflow no ejecuta código del PR ni usa un token de App como fallback. Su environment `merge` admite solo `main`/`dev`; antes de usarlo se provisiona allí `MERGE_USER_TOKEN` y se activa `MERGE_WORKFLOW_ENABLED`. Estas credenciales son independientes del despliegue AWS.

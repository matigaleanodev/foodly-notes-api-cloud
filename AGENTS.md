# foodly-notes-api-cloud

## Contexto de trabajo

Si existe un workspace con AGENTS.md en los directorios padre, leerlo explícitamente antes de editar y seguir sus referencias. Una raíz Git anidada puede impedir la herencia automática. Fuera de ese entorno, este archivo y el README deben ser suficientes para trabajar.

## Estructura y contratos

- TypeScript ESM, AWS Lambda/HTTP API v2, Middy, AJV y MongoDB/Mongoose.
- packages/contracts contiene metadata neutral, JSON Schema, tipos derivados y OpenAPI.
- packages/runtime contiene handlers, servicios, persistencia y clientes externos.
- packages/infrastructure declara CDK y consume contratos sin cargar clientes runtime.
- Un lockfile raíz; respetar exports y límites de los tres workspaces privados npm.
- Cuatro grupos Lambda: health, catalog, detail e ingredients; dos ZIP: health y recipes.
- Mantener rutas explícitas; sin ANY, $default ni proxy genérico.
- Favoritos, listas de compras e i18n de interfaz pertenecen al frontend.

## Desarrollo y verificación

- Usar Node indicado en .nvmrc y requisitos de DEVELOPMENT.md.
- Instalar con npm ci --ignore-scripts; verificar con npm run check.
- npm test y npm run typecheck verifican runtime y contratos.
- npm run openapi genera contratos; npm run build empaqueta los ZIP.
- npm run synth:local sintetiza con parámetros ficticios, sin lookups AWS.
- No confundir síntesis, pruebas con dobles y smoke de paquetes con validación productiva.

## Restricciones

- Conservar contratos NestJS y compatibilidad con foodly-notes-front.
- Preservar límites, cancelación, fallback y saneamiento del cliente HTTP Axios.
- No activar proveedores, efectos reales o despliegues como parte de checks locales.
- Seguir los flujos OIDC y artifacts definidos en DEVELOPMENT.md para entregas autorizadas.

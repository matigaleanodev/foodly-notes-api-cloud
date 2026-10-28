# Desarrollo y entrega

[English](DEVELOPMENT.md)

Ejecutar los comandos desde la raíz con los requisitos y la instalación del [README](README.es.md).

## Estructura y comandos

| Paquete                   | Responsabilidad                                                |
| ------------------------- | -------------------------------------------------------------- |
| `packages/infrastructure` | Stack CDK, parámetros de entrega y CLI.                        |
| `packages/runtime`        | Handlers, Middy, servicios, Mongo y clientes externos.         |
| `packages/contracts`      | Schemas, tipos derivados, rutas, OpenAPI y configuración pura. |

Los paquetes usan exports explícitos de fuentes y un único `package-lock.json` raíz. Las herramientas compartidas y pruebas de integración están en la raíz. Infraestructura importa contratos sin cargar clientes runtime; se rechazan imports relativos entre paquetes.

| Comando                                 | Función                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `npm run check`                         | Validación y empaquetado local completos.                                   |
| `npm test` / `npm run test:watch`       | Pruebas aisladas con salida verbose.                                        |
| `npm run typecheck`                     | Tipos estrictos por workspace y pruebas de integración.                     |
| `npm run lint` / `npm run format:check` | Revisión de código y formato; `lint:fix` / `format` aplican correcciones.   |
| `npm run openapi`                       | Generación de `dist/openapi.json` desde contratos.                          |
| `npm run build`                         | Creación de `dist/health.zip` y `dist/recipes.zip` con smoke checks.        |
| `npm run synth:local`                   | Síntesis y revisión de `cdk.out` con parámetros sintéticos, sin acceso AWS. |

Cada ZIP contiene un bundle ESM. Health exporta `health.handler`; recipes exporta `recipes.catalog`, `recipes.detail` y `recipes.ingredients`. OpenAPI, pruebas y archivos locales/privados quedan fuera de los ZIP. La primera ejecución de pruebas Mongo descarga el binario del servidor efímero.

## Configuración runtime

`NODE_ENV` y `CORS_ORIGIN` configuran HTTP; producción exige orígenes explícitos. `RATE_LIMIT_PER_ROUTE` y `RATE_LIMIT_GLOBAL` configuran cuotas. Los parámetros de proveedores y presupuestos UTC están definidos en el [cliente de proveedores](packages/runtime/src/recipes/providers/client.ts).

Lambda carga configuración mediante dos referencias a secretos:

- `MONGO_SECRET_ARN`: JSON con `MONGO_URI` y, en acceso público, `ORIGIN_VERIFY_SECRET` de al menos 32 caracteres. Health usa un usuario Mongo separado y de solo lectura; recetas usa lectura/escritura sobre la misma base productiva.
- `PROVIDER_SECRET_ARN`: JSON con `SPOONACULAR_API_KEY`, `AZURE_TRANSLATOR_KEY` y `AZURE_TRANSLATOR_REGION`; solo recetas.

Los secretos son externos a los artifacts y a Git. No modificar la base ni reiniciar `securitycounters` durante el corte o la recuperación. Los valores se cachean durante la vida de la instancia; reciclar funciones tras rotar secretos. `PUBLIC_ACCESS_ENABLED=true` habilita las rutas públicas y desactiva el endpoint execute-api. Exige dominio `api.foodlynotes.app`, IP de origen Cloudflare y encabezado `X-Foodly-Origin` con el secreto compartido, agregado por una regla Cloudflare acotada al host. Solo entonces se acepta `CF-Connecting-IP`; `X-Forwarded-For` no se usa. Sin el flag, las rutas exigen AWS_IAM. `REAL_PROVIDERS_ENABLED=true` habilita proveedores únicamente en el modo público protegido. HTTP externo usa HTTPS, sin redirects/retries, timeout de 30 s y límites de 256 KiB para request / 1 MiB descomprimido para response. Cada request tiene deadline de 27 s o tiempo Lambda restante menos 750 ms.

## Entrega

Los parámetros `TEST_*` se definen en [infraestructura](packages/infrastructure/src/config.ts). HTTP API exige orígenes HTTP(S); el cliente Android usa `https://localhost`. Mongo usa TLS y autenticación `MONGODB-AWS`, con roles separados de lectura para health y lectura/escritura para recetas.

`npm run prepare:access` genera los permisos iniciales en `dist/delivery-access.json`; `npm run synth:foundation` sintetiza la fundación. El [workflow de fundación](.github/workflows/foundation.yml) configura bucket, roles y referencias de secretos. `production_domain=true` prepara ACM DNS, el dominio regional TLS y el mapping; `certificate_arn` permite reutilizar un certificado Foodly existente. Publicar su CNAME de validación sin proxy. El CNAME `api` se cambia por separado, conservando el proxy Cloudflare y TLS Full (strict). `api_id` limita la administración a una API; `regional_bootstrap=true` se usa solo para crearla y se desactiva al disponer del ID.

El [workflow build and deploy](.github/workflows/build-and-deploy.yml) recibe `reviewed_sha` de `dev`, publica los assets y conserva la misma assembly revisada entre preparación y ejecución mediante OIDC y checksums. Los cambios ingresan por PR/CI y el [workflow de merge](.github/workflows/merge.yml).

Para recuperar código, entregar la revisión mediante el mismo flujo. Antes de reintentar una creación fallida, revisar eventos y recursos; `recover_empty_stack=true` solo admite stacks sin recursos conservados.

## Respaldo Mongo

Usar Database Tools compatibles y credenciales externas al repositorio. Detener escrituras durante el respaldo consistente y restaurar primero en una base vacía aislada:

```bash
mongodump --config /secure/source.yml --archive backup.archive.gz --gzip
mongorestore --config /secure/destination.yml --archive backup.archive.gz --gzip \
  --nsFrom 'source.*' --nsTo 'isolated_restore.*' --stopOnError
```

Verificar documentos, fechas, índices únicos y TTL; preservar contadores y reconciliar escrituras posteriores antes de usar la copia.

## Recuperación de tráfico

Restaurar el CNAME `api` del túnel `shared-ec2-ingress`, con proxy habilitado, conserva la URL de los clientes y devuelve el tráfico a NestJS en EC2. Mantener el túnel, el contenedor original y sus credenciales operativos. Ambas implementaciones usan la misma base, cachés y contadores UTC: no copiar fixtures ni restaurar snapshots sobre la base activa. No espejar solicitudes a las dos APIs.

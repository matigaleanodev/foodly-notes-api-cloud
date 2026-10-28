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

- `MONGO_SECRET_ARN`: JSON con `MONGO_URI`; health usa un usuario Mongo separado y de solo lectura.
- `PROVIDER_SECRET_ARN`: JSON con `SPOONACULAR_API_KEY`, `AZURE_TRANSLATOR_KEY` y `AZURE_TRANSLATOR_REGION`; solo recetas.

Los valores se cachean durante la vida de la instancia; reciclar funciones tras rotar secretos. Test configura `REAL_PROVIDERS_ENABLED=false`. HTTP externo usa HTTPS, sin redirects/retries, timeout de 30 s y límites de 256 KiB para request / 1 MiB descomprimido para response. Cada request tiene deadline de 27 s o tiempo Lambda restante menos 750 ms.

## Entrega y recuperación

La cuenta es `650387442642`, región `us-east-1`. Lambda usa salida administrada y conexión pública TLS a Atlas, con autenticación `MONGODB-AWS` y roles separados: health con lectura y recetas con lectura/escritura sobre su base. La base de validación contiene datos controlados y no copia datos productivos. No se crean VPC, NAT ni endpoints privados. La cuota regional de 10 se comparte con las otras funciones; no se configuran reservas. Se conservan throttle de Gateway, cuotas atómicas, presupuestos UTC y pools pequeños.

`npm run prepare:access` genera los permisos administrativos iniciales en `dist/delivery-access.json` para un administrador autorizado. El ceiling externo no puede modificarse desde la fundación ni desde los roles de aplicación; no amplía los permisos de Architect. `npm run synth:foundation` sintetiza la fundación CDK sin assets ni bootstrap: bucket privado/versionado, tres referencias de configuración y cinco roles limitados. El [workflow de fundación](.github/workflows/foundation.yml) prepara, revisa y ejecuta su changeset. La primera creación permite administración regional HTTP API temporal; luego se restringe al `api_id` observado con `regional_bootstrap=false`.

Los parámetros no sensibles `TEST_*` se validan en [infraestructura](packages/infrastructure/src/config.ts). `npm run build && npm run synth` produce la assembly y `node scripts/review-package.mjs cdk.out` la revisa. El [workflow build and deploy](.github/workflows/build-and-deploy.yml) exige el SHA completo de `dev` revisado, aprobación de esa revisión y comprobaciones de red/recuperación. OIDC separa preparar, ejecutar y CloudFormation. Los jobs conservan la misma assembly, lockfile, metadata referenciada y checksums por 30 días; verifican integridad y procedencia dentro del mismo run. Antes de ejecutar se comparan template, changeset vivo y bytes de los dos ZIP publicados. No se vuelve a sintetizar en preparación o ejecución.

Los cambios ingresan por PR y CI requerida; el [workflow de merge](.github/workflows/merge.yml) integra el SHA revisado con la cuenta personal. Recuperar código mediante PR/CI y otro changeset revisado, conservando Mongo, contadores y presupuestos. `UPDATE_ROLLBACK_COMPLETE` permite una actualización; `ROLLBACK_COMPLETE` y estados incompletos requieren revisar eventos y recursos conservados antes de actuar. No se elimina ni recrea automáticamente una instalación fallida. Los artifacts retenidos permiten revisar la entrega anterior.

Para recuperar datos, detener escrituras durante el respaldo consistente y usar Database Tools compatibles con la versión de Mongo. Guardar configuración sensible y archivo de respaldo bajo `Infrastructure/Secrets/`, ignorados y con permisos restringidos. Restaurar primero en una base vacía aislada:

```bash
mongodump --config /secure/source.yml --archive backup.archive.gz --gzip
mongorestore --config /secure/destination.yml --archive backup.archive.gz --gzip \
  --nsFrom 'source.*' --nsTo 'isolated_restore.*' --stopOnError
```

Comprobar claves, conteos, BSON/fechas, índices únicos y TTL de las cuatro colecciones; conservar los contadores vigentes sin reiniciarlos. Una recuperación sobre otra copia exige reconciliar las escrituras posteriores. La API original y EC2 siguen disponibles para el corte controlado de producción.

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

Lambda carga tres parámetros JSON estándar SSM `SecureString` mediante dos referencias de entorno:

- `MONGO_PARAMETER_NAME`: JSON con `MONGO_URI` y, en acceso público, `ORIGIN_VERIFY_SECRET` de al menos 32 caracteres. Health usa un usuario Mongo separado y de solo lectura; recetas usa lectura/escritura sobre la misma base productiva.
- `PROVIDER_PARAMETER_NAME`: JSON con `SPOONACULAR_API_KEY`, `AZURE_TRANSLATOR_KEY` y `AZURE_TRANSLATOR_REGION`; solo recetas.

Los valores son externos a los artifacts y a Git. No modificar la base ni reiniciar `securitycounters` durante el corte o la recuperación. Se conservan la cache durante la vida de la instancia, el plazo de lectura de 2 segundos y la recuperación tras fallos. Después del sync, cambiar `TEST_RUNTIME_CONFIGURATION_REVISION` en el environment GitHub `test` y ejecutar un build/deploy autorizado del mismo código revisado: cambia el entorno de las cuatro funciones y renueva sus instancias. El sync por sí solo no renueva instancias calientes. Conservar credenciales anteriores de proveedores hasta terminar el despliegue y las solicitudes en curso; coordinar aparte cualquier rotación del origen con Cloudflare. `PUBLIC_ACCESS_ENABLED=true` habilita las rutas públicas y desactiva el endpoint execute-api. Exige dominio `api.foodlynotes.app`, IP de origen Cloudflare y encabezado `X-Foodly-Origin` con el secreto compartido, agregado por una regla Cloudflare acotada al host. Solo entonces se acepta `CF-Connecting-IP`; `X-Forwarded-For` no se usa. Sin el flag, las rutas exigen AWS_IAM. `REAL_PROVIDERS_ENABLED=true` habilita proveedores únicamente en el modo público protegido. HTTP externo usa HTTPS, sin redirects/retries, timeout de 30 s y límites de 256 KiB para request / 1 MiB descomprimido para response. Cada request tiene deadline de 27 s o tiempo Lambda restante menos 750 ms.

## Entrega

Los parámetros `TEST_*` se definen en [infraestructura](packages/infrastructure/src/config.ts). HTTP API exige orígenes HTTP(S); el cliente Android usa `https://localhost`. Mongo usa TLS y autenticación `MONGODB-AWS`, con roles separados de lectura para health y lectura/escritura para recetas.

`npm run prepare:access` genera los permisos iniciales en `dist/delivery-access.json`; `npm run synth:foundation` sintetiza la fundación. El [workflow de fundación](.github/workflows/foundation.yml) configura bucket, roles y lectura SSM acotada. `production_domain=true` prepara ACM DNS, el dominio regional TLS y el mapping; `certificate_arn` permite reutilizar un certificado Foodly existente. Publicar su CNAME de validación sin proxy. El CNAME `api` se cambia por separado, conservando el proxy Cloudflare y TLS Full (strict). `api_id` limita la administración a una API; `regional_bootstrap=true` se usa solo para crearla y se desactiva al disponer del ID.

El [workflow build and deploy](.github/workflows/build-and-deploy.yml) recibe `reviewed_sha` de `dev`, publica los assets y conserva la misma assembly revisada entre preparación y ejecución mediante OIDC y checksums. Los cambios ingresan por PR/CI y el [workflow de merge](.github/workflows/merge.yml).

Para recuperar código, entregar la revisión mediante el mismo flujo. Antes de reintentar una creación fallida, revisar eventos y recursos; `recover_empty_stack=true` solo admite stacks sin recursos conservados.

## Sincronización de configuración sensible

| Parámetro                         | Secret del environment GitHub | Lectores                     |
| --------------------------------- | ----------------------------- | ---------------------------- |
| `/foodly-notes/test/mongo-health` | `FOODLY_HEALTH_MONGO_JSON`    | health                       |
| `/foodly-notes/test/mongo`        | `FOODLY_MONGO_JSON`           | catalog, detail, ingredients |
| `/foodly-notes/test/providers`    | `FOODLY_PROVIDERS_JSON`       | catalog, detail, ingredients |

El namespace `test` conserva la identidad del despliegue existente, también para tráfico público productivo. Configurar `TEST_HEALTH_MONGO_PARAMETER_NAME`, `TEST_MONGO_PARAMETER_NAME` y `TEST_PROVIDER_PARAMETER_NAME` con esos nombres. Definir `TEST_RUNTIME_CONFIGURATION_REVISION` no vacío (letras, dígitos, `.`, `_`, `-`; hasta 128 caracteres). Las identidades Mongo de health y recetas siguen separadas aunque coincida su URI MongoDB-AWS.

Crear el environment protegido `production-parameters`: permitir solo `dev`, exigir revisor, impedir autoaprobación y deshabilitar bypass. Guardar los JSON originales completos en sus tres Secrets, con el mismo `ORIGIN_VERIFY_SECRET` en ambos Mongo. Para cambiar una clave, editar el JSON completo del Secret correspondiente conservando los demás campos. En la [extensión oficial GitHub Actions de VS Code](https://github.com/github/vscode-github-actions#readme), abrir **Settings**, seleccionar el environment `production-parameters` y administrar sus Secrets; después ejecutar **Sync runtime parameters** sobre `dev` desde el panel Workflows. La web de GitHub ofrece las mismas operaciones en **Settings → Environments** y **Actions**. No guardar credenciales en settings de VS Code, argumentos de terminal ni Git.

El [workflow de sync](.github/workflows/sync-parameters.yml) solo admite `workflow_dispatch`. Elegir `mongo-health`, `mongo`, `providers`, `mongo-domains` (ambos Mongo) o `all`. Cada Secret seleccionado debe contener un objeto JSON completo válido, sin campos requeridos vacíos, hasta 4096 bytes UTF-8. Se validan todos antes de escribir; los no seleccionados quedan intactos. El JSON original y sus valores se envían sin modificaciones. Si falla una escritura, se detiene: las anteriores pueden haber terminado; el resumen enumera solo nombres y versiones publicados. Corregir los Secrets y repetir el subconjunto elegido; el escritor nunca lee ni combina credenciales existentes de SSM.

`npm run prepare:access -- <api-id>` genera boundary y rol OIDC dedicados al sync en `dist/delivery-access.json`, para administración autorizada por separado. Adjuntar `parameterSyncBoundary` como permissions boundary del rol, usando su trust y permisos generados. Solo admite `ssm:PutParameter` sobre los tres ARN exactos y `kms:Encrypt` vía SSM con su contexto `PARAMETER_ARN`; sin lectura, decrypt, borrado ni actualización Lambda. Runtime solo lee sus parámetros asignados y contextos KMS correspondientes. El administrador aplica el ceiling generado a los roles existentes; los permisos efectivos por rol siguen en fundación.

El cifrado usa `alias/aws/ssm` administrada por AWS, igual que Portfolio. No se crean claves KMS. Una única clave propia compartida permite mayor aislamiento administrativo entre proyectos mediante ARN exactos y contextos de cifrado, pero exige cambios de key policy/IAM autorizados por separado y cambiar explícitamente el KeyId del escritor. `aws/ssm` no ofrece esa barrera administrativa: otra identidad con permisos amplios de lectura SSM puede descifrar estos parámetros. No ampliar los accesos SSM de runtime.

`LegacyConfigurationAccess=true` (input `legacy_secrets_access`) conserva únicamente la lectura previa acotada de Secrets Manager para transición y rollback. Fundación ya no crea secretos ni incluye sus valores; la revisión permite retirar solo sus tres recursos anteriores de la administración CloudFormation cuando la plantilla existente tiene ambas políticas de retención en `Retain`. Los secretos físicos sobreviven. Tras validación productiva y aprobación explícita, aplicar fundación con `legacy_secrets_access=false`, regenerar el ceiling con `node scripts/prepare-access.mjs <api-id> none` y aplicarlo mediante administración autorizada. El borrado de secretos retenidos es una operación manual separada que requiere aprobación explícita.

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

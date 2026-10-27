# Preparación de entrega y prueba

[English](DELIVERY.md)

## Estado revisable

La preparación local declara cuatro grupos Lambda (health, catalog, detail, ingredients), dos ZIP y las seis operaciones de recetas. Health cambia expresamente a un array de checks independientes de configuración HTTP y ping Mongo: cada entrada devuelve `name/status`, aunque otra falle; HTTP 200 si todos pasan y 503/Retry-After si alguno falla. No escribe ni consume cuotas o proveedores. El ping no verifica índices, permisos de escritura ni salud de proveedores.

Ingredientes lee la caché con una consulta, pide los faltantes mediante [informationBulk](https://spoonacular.com/food-api/docs#Get-Recipe-Information-Bulk), valida IDs/orden y agrupa traducciones completas. Reserva una unidad Spoonacular por receta faltante, conservador respecto de la tarifa bulk publicada; no convierte el límite de requests en puntos facturados. Azure mantiene lotes de 100 textos/50.000 caracteres, ahora hasta cuatro simultáneos según la configuración vigente. Un error termina la tanda antes de iniciar otra. Se conservan fallbacks, límites de bytes, presupuestos UTC y deadline de 27 s. Axios reemplaza deliberadamente el timeout previo de 5 s por 30.000 ms, siempre acotado por el deadline global y tiempo Lambda restante menos 750 ms; los timeouts de infraestructura no cambian.

Evidencias distintas: reloj virtual con fixture mínimo, 20 recetas a 4.999 ms por llamada, 9.998 ms; Mongo efímero real con 15 ingredientes únicos por receta, 660 textos, ocho llamadas simuladas de 4.900 ms, alrededor de 15 s. Con Axios puede completar una llamada de 6 s; las llamadas lentas retienen concurrencia más tiempo y pueden agotar el presupuesto global antes del fallback de traducción. Requests bloqueadas devuelven 503/Retry-After al deadline, con cancelación de red y sin reembolso de budgets reservados. Las pruebas HTTPS loopback comprueban timeout real de 30 s y cancelación a 27 s por separado de aquellas mediciones de ingredientes. No equivalen a AWS ni a proveedores reales. Lotes mayores de 1 MiB o muchos más textos siguen sujetos a límites/deadline; falta comprobar tamaños y latencias representativos reales.

## Assembly CDK y ejecución

packages/infrastructure/src/stack.ts declara cuatro Lambdas y cuatro integraciones, con trece rutas explícitas configuradas desde packages/contracts/src/routes.ts. catalog reúne listado/daily/búsqueda, detail reúne detalle/similares y cada grupo selecciona solo sus operaciones; ingredients y health quedan separados. Middy mantiene HTTP/errores. No hay API keys ni catch-all.

```sh
npm run build
npm run synth:local
# Con variables TEST_* reales revisadas, en vez de parámetros sintéticos:
npm run synth
node scripts/review-package.mjs cdk.out
```

La síntesis oficial CDK ya produce CloudFormation y assets locales sin credenciales reales ni autenticación externa. El revisor verifica destinos, grupos, métodos, IAM, CORS, concurrencia y los tres assets (dos ZIP y plantilla). La síntesis no valida IAM efectivo, red ni ejecución AWS.

build and deploy sigue siendo manual desde dev/SHA revisado. El primer job sintetiza y conserva assembly/hashes por siete días. El segundo exige SHA aprobado, TEST_NETWORK_REVIEWED=true y TEST_RECOVERY_REVIEWED=true, asume OIDC y despliega exactamente la assembly revisada con el rol CloudFormation explícito. No reconstruye ni ejecuta la app CDK en deploy. Sin trigger de push.

CliCredentialsStackSynthesizer publica assets con las credenciales temporales del pipeline en el bucket existente y pasa un rol de ejecución separado a CloudFormation. No asume roles bootstrap implícitos ni lee parámetros SSM/bootstrap. No ejecutar cdk bootstrap: la provisión del bucket y roles es una operación revisada aparte. El paquete Serverless, sus configuraciones y SERVERLESS_ACCESS_KEY fueron retirados.

## Roles, parámetros y secretos

Cuenta 650387442642, us-east-1. Roles, bucket y red se provisionan fuera del stack de aplicación, tras revisar la plantilla CDK sintetizada y las policies definitivas. No se modifican protecciones, identidad personal ni workflow de merge.

| Rol         | Confianza y permisos previstos                                                                                                                                                                                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline    | OIDC, aud sts.amazonaws.com, sub exacto `repo:matigaleanodev/foodly-notes-api-cloud:environment:test`; environment limitado a dev. CloudFormation solo sobre foodly-notes-api-cloud-test; S3 sobre bucket/prefijo de entrega; PassRole solo al ejecutor CF con PassedToService=cloudformation.amazonaws.com. Sin lectura de secretos ni mutaciones IAM/SSM. |
| Ejecutor CF | Confianza cloudformation.amazonaws.com; Lambda/logs de este servicio, API Gateway de test y lectura del bucket; PassRole solo a health/recipes con PassedToService=lambda.amazonaws.com. Sin crear roles, secretos, VPC/NAT ni tocar otros stacks. Scopes finales se contrastan contra cdk.out/FoodlyNotesTest.template.json.                               |
| Health      | Confianza lambda.amazonaws.com; GetSecretValue solo mongo-health; logs propios y permisos ENI exigidos por Lambda VPC. Usuario Mongo exclusivo sin escritura.                                                                                                                                                                                               |
| Recipes     | Confianza lambda.amazonaws.com; GetSecretValue solo mongo/providers; logs de los tres grupos de recetas y permisos ENI. Usuario Mongo limitado a las cuatro colecciones de test. Índices preparados por operación separada.                                                                                                                                 |

Aplicar/verificar las boundaries personales existentes antes de provisionar, conservando denegaciones STS/SSM. Los permisos ENI que requieran Resource=* deben limitarse según la [guía VPC de Lambda](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html), incluyendo la separación entre llamadas del servicio y del código. No se han aplicado policies; OIDC/IAM reales siguen sin validar.

Variables no sensibles: `TEST_HEALTH_ROLE_ARN`, `TEST_RECIPES_ROLE_ARN`, `TEST_CLOUDFORMATION_ROLE_ARN`, `TEST_PIPELINE_ROLE_ARN`, `TEST_DEPLOYMENT_BUCKET`, `TEST_SUBNET_IDS` (dos o más), `TEST_SECURITY_GROUP_IDS`, `TEST_CORS_ORIGIN`, `TEST_HEALTH_MONGO_SECRET_ARN`, `TEST_MONGO_SECRET_ARN`, `TEST_PROVIDER_SECRET_ARN`. El prefijo de roles/bucket es foodly-notes-test-. Los secretos usan foodly-notes/test/mongo-health, mongo y providers.

Los dos secretos Mongo contienen solo `MONGO_URI`, con usuarios separados; providers contiene `SPOONACULAR_API_KEY/AZURE_TRANSLATOR_KEY/AZURE_TRANSLATOR_REGION`. SDK oficial fijado, lectura runtime sin reintentos y con cancelación a 2 s; una inicialización fallida puede recuperarse en la siguiente request. La caché vive durante la instancia: reciclar funciones después de rotar secretos. Health no recibe el ARN providers. `REAL_PROVIDERS_ENABLED=false` bloquea llamadas reales en test antes de reservar presupuesto; habilitarlas requiere otro cambio revisado.

## Mongo, red y conexiones

Base de test dedicada, sin URI/datos de producción. No abrir Mongo globalmente. La configuración requiere subnets/SG existentes; antes de desplegar hay que acreditar ruta privada a Mongo, TLS verificado, usuarios mínimos, DNS y salida HTTPS a Secrets Manager/proveedores. Una subnet pública no otorga IP pública a Lambda. Si falta salida, presentar alternativa/costo antes de crear NAT, endpoints o cambiar redes. No se ha comprobado la topología Mongo actual.

Concurrencia reservada inicial: health/ingredients=1; catalog/detail=2, total seis invocaciones activas. Recipes mantiene pool máximo 4; health usa 1; mínimo 0 e idle 60 s. Estimación para seis entornos activos: 21 sockets de aplicación y hasta 12 de monitoreo por servidor de topología; no es un límite total de conexiones. Entornos calientes retenidos, reemplazos, réplicas y otros clientes agregan conexiones. Medir en la topología real antes de subir concurrencia. Proveedores: hasta 20 llamadas activas agregadas; budgets Mongo compartidos siguen siendo el control global. Gateway limita objetivos a 4 requests/s, burst 6; su throttling no reemplaza cuotas.

## Prueba independiente y recuperación

| Riesgo              | Evidencia requerida en entorno independiente                                                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duración/conexiones | Cold/warm, caché vacía/mixta/completa, 1/20 recetas en/es y contenido amplio; p50/p95/máximo de integración <27 s en casos aceptados. Separar traducción completa, fallback y 503. Medir sockets por servidor, entornos retenidos/reemplazos, memoria y errores de pool.    |
| Matching/Gateway    | Confirmar daily/search antes de id; HEAD sin body; trece rutas con cuatro integraciones; métodos/rutas inválidos y slash final. Registrar 403 de IAM, 404, throttling e integration timeout propios de Gateway y sus headers/JSON, sin atribuirles el contrato del handler. |
| CORS                | OPTIONS de origen permitido/no permitido y headers; cero invocaciones Lambda por preflight; Retry-After y cuotas legibles en navegador, también en errores previos a integración. HTTP API controla esas respuestas.                                                        |
| Cuotas/budgets      | Dos IPs de salida reales y dos funciones; no confiar en X-Forwarded-For/CF-Connecting-IP del cliente. 30/120/20/10, ventanas UTC, carreras y fallo cerrado ante DB inaccesible. Usar proveedores simulados hasta habilitación específica.                                   |
| Web/Android         | Contratos de las seis operaciones, idiomas/fallbacks, ingredientes por lotes de 20, 429/503, favoritos/listas locales. Health se valida con su nuevo contrato. Cambiar solo API_URL temporalmente fuera del código versionado; comprobar Android en dispositivo.            |

Test usa [AWS_IAM por ruta](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-access-control-iam.html). Requests sin firma no acceden a negocio; el preflight CORS sigue sin Lambda. Para clientes sin cambios de autenticación, preparar un proxy de prueba local en loopback que firme con credenciales temporales y reenvíe Origin/OPTIONS/headers de Gateway; Android mediante adb reverse. Nunca distribuir claves AWS al frontend/APK. La prueba directa de CORS de Gateway debe hacerse además con requests firmadas; el proxy no demuestra por sí solo CORS real. Ese harness y las pruebas AWS/dispositivo aún no se ejecutaron.

Antes de cualquier corte: inventario de base/índices/contadores vigentes, dump BSON/metadata cifrado con hash y retención definida, restauración en base aislada y comprobación de claves/conteos/muestras/TTL. Practicar primero con datos sintéticos. Si se conserva la misma Mongo productiva, no copiar ni restaurar datos al alternar implementación; desviar a EC2 conserva escrituras recientes. Si cambia la base, pausa de escrituras, copia final y plan para reconciliar escrituras nuevas antes de volver. No reiniciar contadores/budgets. API/EC2 originales permanecen recuperables.

Guardar paquete oficial previo, configuración no sensible, ARN/versiones de secretos y referencias de imágenes/volúmenes EC2. Recuperación de test: redesplegar el paquete previo revisado; en primer despliegue fallido, conservar evidencias y revertir solo recursos nuevos autorizados. No borrar bases, secretos, backups ni despliegues compartidos. Corte/DNS y prueba de recuperación siguen pendientes.

## Estimación previa a autorización

Precios públicos consultados el 26/10/2026, sin asumir free tier: [tres secretos](https://aws.amazon.com/secrets-manager/pricing/) ~USD 1,20/mes más USD 0,05/10.000 lecturas; [HTTP API](https://aws.amazon.com/api-gateway/pricing/) USD 1/millón; [Lambda ARM](https://aws.amazon.com/lambda/pricing/) USD 0,20/millón y ~USD 0,0000133334/GB-s. Ejemplo de 10.000 requests/mes, todas de 15 s a 256 MiB: ~USD 1,71/mes incluyendo secretos y ejecución, antes de lecturas de secretos, S3, logs, transferencia y red. Es una estimación, no un presupuesto total ni una validación de facturación.

Mongo/plan/capacidad y red segura todavía no están cotizados. CDK elimina la dependencia de licencia/cuenta Serverless; se facturan los recursos AWS que se creen. [NAT](https://aws.amazon.com/vpc/pricing/) puede agregar decenas de USD mensuales; no está incluido ni propuesto como recurso automático. No aprobar ejecución con el subtotal como costo total. Presentar recursos, policies finales, red cotizada y recuperación comprobada antes del primer despliegue; proveedores reales y producción requieren revisión propia.

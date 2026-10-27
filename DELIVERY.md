# Delivery and independent test preparation

[Español](DELIVERY.es.md)

## Reviewable state

Local preparation declares four Lambda groups (health, catalog, detail, ingredients), two ZIPs and six recipe operations. Health explicitly changes to an array of independent HTTP configuration and Mongo ping checks. Each entry returns `name/status` even when another fails; HTTP 200 when all pass, otherwise 503/Retry-After. It performs no writes, quotas or provider calls. Ping does not verify indexes, write privileges or provider health.

Ingredients reads cached recipes with one query, fetches missing IDs through [informationBulk](https://spoonacular.com/food-api/docs#Get-Recipe-Information-Bulk), validates IDs/order and groups complete translations. It conservatively reserves one Spoonacular unit per missing recipe; the request budget is not a billing-points budget. Azure retains batches of 100 texts/50,000 characters, now with up to four concurrent batches according to the existing setting. A failed wave finishes before another starts. Fallbacks, byte/5-second limits, UTC budgets and the 27-second deadline remain.

Separate evidence: virtual clock/minimal fixture, 20 recipes with 4,999 ms per call, 9,998 ms total; real ephemeral Mongo with 15 unique ingredients per recipe, 660 texts and eight simulated calls of 4,900 ms, approximately 15 seconds. Real 4,999 ms delays can cross the 5-second timeout due to scheduling and trigger fallback. Neither validates AWS or real providers. Batches exceeding 1 MiB or substantially larger text sets remain bounded by limits/deadline; representative real sizes and latency still need checking.

## CDK assembly and execution

infra/stack.ts declares four Lambdas/four integrations and thirteen explicit routes configured from src/http/routes.ts. catalog groups list/daily/search, detail groups detail/similar, with bounded operation selection inside each group; ingredients and health stay separate. Middy retains HTTP/error middleware. There are no API keys or catch-all routes.

```sh
npm run build
npm run synth:local
# With reviewed actual TEST_* variables, instead of synthetic parameters:
npm run synth
node scripts/review-package.mjs cdk.out
```

Official CDK synthesis now produces CloudFormation and local assets without real credentials or external authentication. The reviewer checks destinations, groups, methods, IAM, CORS, concurrency and three assets (two ZIPs plus template). Synthesis does not validate effective IAM, networking or AWS execution.

build and deploy remains manual from dev/reviewed SHA. Its first job synthesizes and retains assembly/hashes for seven days. The second requires an approved SHA, TEST_NETWORK_REVIEWED=true and TEST_RECOVERY_REVIEWED=true, assumes OIDC and deploys the exact reviewed assembly with an explicit CloudFormation role. It neither rebuilds nor runs the CDK app during deployment. There is no push trigger.

CliCredentialsStackSynthesizer publishes assets with temporary pipeline credentials into the existing bucket and passes a separate execution role to CloudFormation. There are no implicit bootstrap role assumptions or bootstrap/SSM reads. Do not run cdk bootstrap: bucket/role provisioning is reviewed separately. Serverless dependency/configuration and SERVERLESS_ACCESS_KEY were removed.

## Roles, parameters and secrets

Account 650387442642, us-east-1. Roles, bucket and network are provisioned outside the application stack after reviewing the synthesized CDK template and final policies. Repository protections, personal identity and merge workflow remain established.

| Role        | Planned trust and permissions                                                                                                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline    | OIDC, aud sts.amazonaws.com, exact sub `repo:matigaleanodev/foodly-notes-api-cloud:environment:test`; restrict environment to dev. CloudFormation only for foodly-notes-api-cloud-test; S3 delivery bucket/prefix; PassRole only to CF executor with PassedToService=cloudformation.amazonaws.com. No secret reads or IAM/SSM mutations. |
| CF executor | Trust cloudformation.amazonaws.com; service Lambda/logs, test API Gateway and artifact reads; PassRole only to health/recipes with PassedToService=lambda.amazonaws.com. No role/secret/VPC/NAT creation or other stacks. Validate final scopes against cdk.out/FoodlyNotesTest.template.json.                                           |
| Health      | Trust lambda.amazonaws.com; GetSecretValue only mongo-health; own logs and required Lambda VPC ENI permissions. Separate Mongo user without write access.                                                                                                                                                                                |
| Recipes     | Trust lambda.amazonaws.com; GetSecretValue only mongo/providers; three recipe groups' logs and ENI permissions. Mongo user limited to four test collections; index preparation is separate.                                                                                                                                              |

Apply/verify existing personal boundaries before provisioning, preserving STS/SSM denials. ENI permissions requiring Resource=* must follow [Lambda VPC guidance](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html), including separation of service calls from application code. Policies have not been applied; real OIDC/IAM remains unvalidated.

Non-sensitive variables: `TEST_HEALTH_ROLE_ARN`, `TEST_RECIPES_ROLE_ARN`, `TEST_CLOUDFORMATION_ROLE_ARN`, `TEST_PIPELINE_ROLE_ARN`, `TEST_DEPLOYMENT_BUCKET`, `TEST_SUBNET_IDS` (at least two), `TEST_SECURITY_GROUP_IDS`, `TEST_CORS_ORIGIN`, `TEST_HEALTH_MONGO_SECRET_ARN`, `TEST_MONGO_SECRET_ARN`, `TEST_PROVIDER_SECRET_ARN`. Role/bucket prefix: foodly-notes-test-. Secret names: foodly-notes/test/mongo-health, mongo and providers.

Both Mongo secrets contain only `MONGO_URI`, with separate users; providers contains `SPOONACULAR_API_KEY/AZURE_TRANSLATOR_KEY/AZURE_TRANSLATOR_REGION`. Pinned official SDK, runtime reads without retries and a 2-second abort; failed initialization can recover on the next request. Cache lives for the instance lifetime: recycle functions after rotation. Health receives no providers ARN. `REAL_PROVIDERS_ENABLED=false` blocks real test provider calls before budget reservation; enabling them requires another reviewed change.

## Mongo, network and connections

Dedicated test database without production URI/data. Never globally expose Mongo. Configuration requires existing subnets/SGs; establish private Mongo connectivity, verified TLS, minimal users, DNS and HTTPS egress to Secrets Manager/providers before deploying. Public subnets do not give Lambda public IPs. If egress is missing, present options/cost before creating NAT, endpoints or network changes. Current Mongo topology has not been verified.

Initial reserved concurrency: health/ingredients=1, catalog/detail=2; six active invocations total. Recipes retains pool maximum 4; health uses 1; minimum 0 and idle 60 seconds. Estimate for six active environments: 21 application sockets plus up to 12 monitoring sockets per topology server; this is not an absolute connection cap. Retained warm environments, replacements, replicas and other clients add connections. Measure actual topology before increasing concurrency. Providers: up to 20 aggregate active calls; shared Mongo budgets remain the global control. Gateway targets 4 requests/second, burst 6; throttling does not replace quotas.

## Independent test and recovery

| Risk                 | Required independent-environment evidence                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duration/connections | Cold/warm, empty/mixed/full cache, 1/20 recipes in en/es and broad content; integration p50/p95/maximum <27 seconds for accepted cases. Separate complete translation, fallback and 503. Measure per-server sockets, retained/replaced environments, memory and pool errors. |
| Matching/Gateway     | daily/search precedence over id; bodyless HEAD; thirteen routes/four integrations; invalid methods/routes and trailing slash. Record IAM 403, Gateway 404/throttling/integration-timeout JSON/headers separately from handler contracts.                                     |
| CORS                 | Allowed/denied origins and headers on OPTIONS; zero preflight Lambda invocations; browser-readable Retry-After/quota headers including pre-integration errors. HTTP API controls those responses.                                                                            |
| Quotas/budgets       | Two real egress IPs and two functions; distrust client X-Forwarded-For/CF-Connecting-IP. 30/120/20/10, UTC windows, races and DB failure closure. Simulate providers until explicitly enabled.                                                                               |
| Web/Android          | Six operation contracts, languages/fallbacks, ingredient batches of 20, 429/503 and local favorites/lists. Validate the new health contract. Change only temporary API_URL outside versioned code; verify Android on a physical device.                                      |

Test uses [per-route AWS_IAM](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-access-control-iam.html). Unsigned requests cannot reach business logic; CORS preflight still bypasses Lambda. For clients without auth changes, prepare a loopback-only test proxy signing with temporary credentials and forwarding Origin/OPTIONS/Gateway headers; use adb reverse on Android. Never distribute AWS keys to frontend/APK. Also test Gateway CORS directly using signed requests: a proxy alone does not demonstrate real Gateway CORS. That harness and AWS/device tests have not run.

Before any cutover: inventory database/indexes/current counters, encrypted BSON/metadata dump with hash/retention, isolated restore and key/count/sample/TTL comparisons. Rehearse with synthetic data first. Reusing the same production Mongo requires no copy or restore when switching implementation; returning to EC2 preserves recent writes. Moving databases requires write pause, final copy and reconciliation of new writes before rollback. Never reset counters/budgets. Original API/EC2 remains recoverable.

Retain previous official package, non-sensitive configuration, secret ARN/versions and EC2 image/volume references. Test recovery redeploys the previous reviewed package; for failed first deployment, retain evidence and revert only authorized new resources. Never delete databases, secrets, backups or shared deployments. Cutover/DNS and recovery execution remain pending.

## Estimate before authorization

Public prices checked 2026-10-26 without assuming free tier: [three secrets](https://aws.amazon.com/secrets-manager/pricing/) ~USD 1.20/month plus USD 0.05/10,000 reads; [HTTP API](https://aws.amazon.com/api-gateway/pricing/) USD 1/million; [ARM Lambda](https://aws.amazon.com/lambda/pricing/) USD 0.20/million and ~USD 0.0000133334/GB-second. Example: 10,000 monthly requests, each lasting 15 seconds at 256 MiB, ~USD 1.71/month including secrets and execution, before secret reads, S3, logs, transfer and networking. This is an estimate, not a total budget or verified billing.

Mongo plan/capacity and secure networking remain unpriced. CDK removes the Serverless vendor account/license dependency; created AWS resources are billed. [NAT](https://aws.amazon.com/vpc/pricing/) can add tens of USD monthly; it is excluded and is not created automatically. Do not approve execution using this subtotal as the total cost. Present resources, final policies, quoted networking and verified recovery before first deployment; real providers and production need separate review.

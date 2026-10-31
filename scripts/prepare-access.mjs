import { mkdir, writeFile } from 'node:fs/promises';
import {
  applicationPolicies,
  allow,
  CEILING,
  foundationPolicy,
  githubTrust,
  policy,
  parameterSyncPolicy,
  parameterArn,
  parameterNames,
  PREFIX,
  roleArn,
  serviceTrust,
  STACK,
} from '../packages/infrastructure/src/delivery-policies.ts';

const foundationStack = `arn:aws:cloudformation:us-east-1:650387442642:stack/${STACK}-foundation/*`;
const foundationExecutor = roleArn('foundation-cloudformation');
const syncBoundaryName = `${PREFIX}parameters-sync-boundary`;
const access = {
  parameterSyncBoundary: { name: syncBoundaryName, document: parameterSyncPolicy() },
  ceiling: {
    name: `${PREFIX}ceiling`,
    document: policy([
      ...Object.values(
        applicationPolicies(process.argv[2] ?? '*', true, process.argv[3] !== 'none'),
      )
        .flat()
        .map((statement) => {
          if (statement.Action.includes('lambda:CreateFunction'))
            return {
              ...statement,
              Resource: [`arn:aws:lambda:us-east-1:650387442642:function:${STACK}-*`],
            };
          if (statement.Action.includes('kms:Decrypt'))
            return {
              ...statement,
              Condition: {
                StringEquals: {
                  'kms:ViaService': 'ssm.us-east-1.amazonaws.com',
                  'kms:EncryptionContext:PARAMETER_ARN': parameterNames.map(parameterArn),
                },
              },
            };
          return {
            ...statement,
            Resource: [
              ...new Set(
                statement.Resource.map((resource) =>
                  resource.startsWith(
                    `arn:aws:logs:us-east-1:650387442642:log-group:/aws/lambda/${STACK}-`,
                  )
                    ? `arn:aws:logs:us-east-1:650387442642:log-group:/aws/lambda/${STACK}-*`
                    : resource,
                ),
              ),
            ],
          };
        })
        .reduce((merged, statement) => {
          const key = JSON.stringify([statement.Action, statement.Condition]);
          const previous = merged.get(key);
          merged.set(key, {
            ...statement,
            Resource: [...new Set([...(previous?.Resource ?? []), ...statement.Resource])],
          });
          return merged;
        }, new Map())
        .values(),
    ]),
  },
  roles: [
    {
      name: `${PREFIX}parameters-sync`,
      trust: githubTrust('production-parameters'),
      permissionsBoundary: `arn:aws:iam::650387442642:policy/${syncBoundaryName}`,
      permissions: parameterSyncPolicy(),
    },
    {
      name: `${PREFIX}foundation-cloudformation`,
      trust: serviceTrust('cloudformation.amazonaws.com'),
      permissions: foundationPolicy(),
    },
    {
      name: `${PREFIX}foundation`,
      trust: githubTrust('foundation'),
      permissions: policy([
        allow(['cloudformation:CreateChangeSet'], [foundationStack], {
          StringEquals: { 'cloudformation:RoleArn': foundationExecutor },
          StringLike: { 'cloudformation:ChangeSetName': `${STACK}-foundation-*` },
        }),
        allow(
          [
            'cloudformation:DescribeStacks',
            'cloudformation:DescribeStackEvents',
            'cloudformation:DescribeChangeSet',
            'cloudformation:GetTemplate',
            'cloudformation:GetTemplateSummary',
            'cloudformation:DeleteChangeSet',
            'cloudformation:ExecuteChangeSet',
          ],
          [foundationStack],
        ),
        allow(['iam:PassRole'], [foundationExecutor], {
          StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' },
        }),
      ]),
    },
  ],
};
if (!CEILING.endsWith(access.ceiling.name)) throw new Error('Invalid ceiling.');
if (JSON.stringify(access.ceiling.document).length > 6144)
  throw new Error(
    `Ceiling exceeds IAM policy size: ${JSON.stringify(access.ceiling.document).length}.`,
  );
await mkdir('dist', { recursive: true });
await writeFile('dist/delivery-access.json', JSON.stringify(access, null, 2) + '\n');
console.info('Permisos iniciales generados para revisión; sin operaciones AWS.');

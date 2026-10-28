import { mkdir, writeFile } from 'node:fs/promises';
import {
  applicationPolicies,
  allow,
  CEILING,
  foundationPolicy,
  githubTrust,
  policy,
  PREFIX,
  roleArn,
  serviceTrust,
  STACK,
} from '../packages/infrastructure/src/delivery-policies.ts';

const foundationStack = `arn:aws:cloudformation:us-east-1:650387442642:stack/${STACK}-foundation/*`;
const foundationExecutor = roleArn('foundation-cloudformation');
const access = {
  ceiling: {
    name: `${PREFIX}ceiling`,
    document: policy([
      ...new Map(
        Object.values(applicationPolicies(process.argv[2] ?? '*'))
          .flat()
          .map((statement) => {
            const bounded = statement.Action.includes('lambda:CreateFunction')
              ? {
                  ...statement,
                  Resource: [`arn:aws:lambda:us-east-1:650387442642:function:${STACK}-*`],
                }
              : statement;
            return [JSON.stringify(bounded), bounded];
          }),
      ).values(),
    ]),
  },
  roles: [
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
  throw new Error('Ceiling exceeds IAM policy size.');
await mkdir('dist', { recursive: true });
await writeFile('dist/delivery-access.json', JSON.stringify(access, null, 2) + '\n');
console.info('Permisos iniciales generados para revisión; sin operaciones AWS.');

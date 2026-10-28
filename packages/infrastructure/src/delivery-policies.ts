/** Permisos personales de entrega; ningún rol de aplicación puede administrar IAM. */
export const BUCKET = 'foodly-notes-test-assets-650387442642-us-east-1';

export const STACK = 'foodly-notes-api-cloud-test';

export const PREFIX = 'foodly-notes-test-';

export const roleArn = (name: string) => `arn:aws:iam::650387442642:role/${PREFIX}${name}`;

export const CEILING = `arn:aws:iam::650387442642:policy/${PREFIX}ceiling`;

const stackArn = `arn:aws:cloudformation:us-east-1:650387442642:stack/${STACK}/*`;
const assetArn = `arn:aws:s3:::${BUCKET}/${STACK}/*`;

export const allow = (Action: string[], Resource: string[], Condition?: object) => ({
  Effect: 'Allow',
  Action,
  Resource,
  ...(Condition ? { Condition } : {}),
});

export const policy = (Statement: object[]) => ({ Version: '2012-10-17', Statement });

export const serviceTrust = (service: string) =>
  policy([{ Effect: 'Allow', Principal: { Service: service }, Action: 'sts:AssumeRole' }]);

export const githubTrust = (environment: string) =>
  policy([
    {
      Effect: 'Allow',
      Principal: {
        Federated: 'arn:aws:iam::650387442642:oidc-provider/token.actions.githubusercontent.com',
      },
      Action: 'sts:AssumeRoleWithWebIdentity',
      Condition: {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:matigaleanodev@99203645/foodly-notes-api-cloud@1434510465:environment:${environment}`,
        },
      },
    },
  ]);

const readStack = allow(
  [
    'cloudformation:DescribeStacks',
    'cloudformation:DescribeStackEvents',
    'cloudformation:DescribeStackResources',
    'cloudformation:ListStackResources',
    'cloudformation:DescribeChangeSet',
    'cloudformation:GetTemplate',
    'cloudformation:GetTemplateSummary',
  ],
  [stackArn],
);
const readAssets = allow(['s3:GetObject'], [assetArn]);
const logs = (names: string[]) =>
  allow(
    ['logs:CreateLogStream', 'logs:PutLogEvents'],
    names.map(
      (name) => `arn:aws:logs:us-east-1:650387442642:log-group:/aws/lambda/${STACK}-${name}:*`,
    ),
  );
const secrets = (names: string[]) =>
  allow(
    ['secretsmanager:GetSecretValue'],
    names.map(
      (name) =>
        `arn:aws:secretsmanager:us-east-1:650387442642:secret:foodly-notes/test/${name}-??????`,
    ),
  );

export function applicationPolicies(apiId = '*', bootstrap = true) {
  return {
    health: [logs(['health']), secrets(['mongo-health'])],
    recipes: [logs(['catalog', 'detail', 'ingredients']), secrets(['mongo', 'providers'])],
    prepare: [
      readStack,
      readAssets,
      allow(
        ['s3:ListBucket', 's3:GetBucketLocation', 's3:GetEncryptionConfiguration'],
        [`arn:aws:s3:::${BUCKET}`],
      ),
      allow(['s3:PutObject'], [assetArn]),
      allow(['cloudformation:CreateChangeSet'], [stackArn], {
        StringEquals: { 'cloudformation:RoleArn': roleArn('cloudformation') },
        StringLike: { 'cloudformation:ChangeSetName': `${STACK}-*` },
      }),
      allow(['cloudformation:DeleteChangeSet'], [stackArn]),
      allow(['cloudformation:DeleteStack'], [stackArn], {
        StringEquals: { 'cloudformation:RoleArn': roleArn('cloudformation') },
      }),
      allow(['iam:PassRole'], [roleArn('cloudformation')], {
        StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' },
      }),
    ],
    execute: [
      readStack,
      readAssets,
      allow(['cloudformation:ExecuteChangeSet'], [stackArn], {
        StringLike: {
          'cloudformation:ChangeSetName': [
            `arn:aws:cloudformation:us-east-1:650387442642:changeSet/${STACK}-*/*`,
            `${STACK}-*`,
          ],
        },
      }),
    ],
    cloudformation: [
      allow(
        [
          'lambda:CreateFunction',
          'lambda:GetFunction',
          'lambda:GetFunctionConfiguration',
          'lambda:GetFunctionCodeSigningConfig',
          'lambda:GetFunctionRecursionConfig',
          'lambda:GetRuntimeManagementConfig',
          'lambda:GetFunctionScalingConfig',
          'lambda:UpdateFunctionCode',
          'lambda:UpdateFunctionConfiguration',
          'lambda:DeleteFunction',
          'lambda:AddPermission',
          'lambda:RemovePermission',
          'lambda:GetPolicy',
          'lambda:TagResource',
          'lambda:UntagResource',
          'lambda:ListTags',
        ],
        ['health', 'catalog', 'detail', 'ingredients'].map(
          (name) => `arn:aws:lambda:us-east-1:650387442642:function:${STACK}-${name}`,
        ),
      ),
      allow(['iam:PassRole'], [roleArn('health'), roleArn('recipes')], {
        StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' },
      }),
      readAssets,
      allow(
        [
          'logs:CreateLogGroup',
          'logs:DeleteLogGroup',
          'logs:PutRetentionPolicy',
          'logs:DeleteRetentionPolicy',
          'logs:TagResource',
          'logs:UntagResource',
          'logs:ListTagsForResource',
          'logs:GetDataProtectionPolicy',
        ],
        ['health', 'catalog', 'detail', 'ingredients']
          .flatMap((name) => [
            `arn:aws:logs:us-east-1:650387442642:log-group:/aws/lambda/${STACK}-${name}`,
            `arn:aws:logs:us-east-1:650387442642:log-group:/aws/lambda/${STACK}-${name}:*`,
          ])
          .concat([
            `arn:aws:logs:us-east-1:650387442642:log-group:/aws/apigateway/${STACK}`,
            `arn:aws:logs:us-east-1:650387442642:log-group:/aws/apigateway/${STACK}:*`,
          ]),
      ),
      allow(
        [
          'logs:DescribeLogGroups',
          'logs:DescribeResourcePolicies',
          'logs:DescribeIndexPolicies',
          'logs:CreateLogDelivery',
          'logs:GetLogDelivery',
          'logs:UpdateLogDelivery',
          'logs:DeleteLogDelivery',
          'logs:ListLogDeliveries',
          'logs:PutResourcePolicy',
        ],
        ['*'],
        { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } },
      ),
      ...(bootstrap
        ? [
            allow(['apigateway:POST'], ['arn:aws:apigateway:us-east-1::/apis'], {
              StringEquals: { 'apigateway:Request/ApiName': STACK },
            }),
          ]
        : []),
      allow(
        [
          'apigateway:GET',
          'apigateway:POST',
          'apigateway:PATCH',
          'apigateway:PUT',
          'apigateway:DELETE',
          // El proveedor CloudFormation de stage exige esta acción; su catálogo IAM está desfasado.
          'apigateway:TagResource',
        ],
        apiId === '*'
          ? ['arn:aws:apigateway:us-east-1::/apis/*']
          : [
              `arn:aws:apigateway:us-east-1::/apis/${apiId}`,
              `arn:aws:apigateway:us-east-1::/apis/${apiId}/*`,
            ],
      ),
    ],
  };
}

export function foundationPolicy() {
  const roles = Object.keys(applicationPolicies()).map(roleArn);
  return policy([
    allow(['acm:RequestCertificate'], ['*'], {
      StringEquals: { 'aws:RequestedRegion': 'us-east-1', 'acm:ValidationMethod': 'DNS' },
      'ForAllValues:StringEquals': { 'acm:DomainNames': ['api.foodlynotes.app'] },
    }),
    allow(
      [
        'acm:DescribeCertificate',
        'acm:AddTagsToCertificate',
        'acm:ListTagsForCertificate',
        'acm:RemoveTagsFromCertificate',
      ],
      ['arn:aws:acm:us-east-1:650387442642:certificate/*'],
    ),
    allow(['apigateway:POST'], ['arn:aws:apigateway:us-east-1::/domainnames'], {
      StringEquals: { 'aws:RequestTag/Project': 'foodly-notes-api-cloud' },
      'ForAllValues:StringEquals': { 'apigateway:Request/EndpointType': ['REGIONAL'] },
    }),
    allow(
      [
        'apigateway:GET',
        'apigateway:POST',
        'apigateway:PATCH',
        'apigateway:DELETE',
        'apigateway:TagResource',
      ],
      [
        'arn:aws:apigateway:us-east-1::/domainnames/api.foodlynotes.app',
        'arn:aws:apigateway:us-east-1::/domainnames/api.foodlynotes.app/*',
      ],
    ),
    allow(['iam:CreateRole', 'iam:PutRolePermissionsBoundary'], roles, {
      StringEquals: { 'iam:PermissionsBoundary': CEILING },
    }),
    allow(
      [
        'iam:GetRole',
        'iam:DeleteRole',
        'iam:PutRolePolicy',
        'iam:GetRolePolicy',
        'iam:DeleteRolePolicy',
        'iam:ListRolePolicies',
        'iam:ListAttachedRolePolicies',
        'iam:UpdateAssumeRolePolicy',
        'iam:TagRole',
        'iam:UntagRole',
      ],
      roles,
    ),
    allow(
      [
        's3:CreateBucket',
        's3:DeleteBucket',
        's3:GetBucketPolicy',
        's3:PutBucketPolicy',
        's3:DeleteBucketPolicy',
        's3:GetBucketPublicAccessBlock',
        's3:PutBucketPublicAccessBlock',
        's3:GetBucketOwnershipControls',
        's3:PutBucketOwnershipControls',
        's3:GetEncryptionConfiguration',
        's3:PutEncryptionConfiguration',
        's3:GetBucketVersioning',
        's3:PutBucketVersioning',
        's3:GetBucketTagging',
        's3:PutBucketTagging',
        's3:GetBucketLocation',
        's3:ListBucket',
        's3:GetLifecycleConfiguration',
        's3:PutLifecycleConfiguration',
      ],
      [`arn:aws:s3:::${BUCKET}`],
    ),
    allow(
      [
        'secretsmanager:CreateSecret',
        'secretsmanager:DescribeSecret',
        'secretsmanager:TagResource',
        'secretsmanager:UntagResource',
        'secretsmanager:UpdateSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:DeleteSecret',
        'secretsmanager:GetResourcePolicy',
      ],
      ['mongo-health', 'mongo', 'providers'].map(
        (name) =>
          `arn:aws:secretsmanager:us-east-1:650387442642:secret:foodly-notes/test/${name}-??????`,
      ),
    ),
  ]);
}

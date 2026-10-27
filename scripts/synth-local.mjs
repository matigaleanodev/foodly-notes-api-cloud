import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const settings = JSON.parse(
  await readFile('packages/infrastructure/src/local-settings.json', 'utf8'),
);
// Parámetros sintéticos y credenciales ficticias: síntesis sin lookups ni acceso a la cuenta.
execFileSync('npm', ['run', 'synth', '--', '--no-notices'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ...settings,
    AWS_ACCESS_KEY_ID: 'local-synth',
    AWS_SECRET_ACCESS_KEY: 'local-synth',
    AWS_SESSION_TOKEN: '',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_CONFIG_FILE: '/dev/null',
    CDK_DISABLE_VERSION_CHECK: 'true',
  },
});
execFileSync(process.execPath, ['scripts/review-package.mjs', 'cdk.out'], { stdio: 'inherit' });

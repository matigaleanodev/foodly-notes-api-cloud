import { execFileSync } from 'node:child_process';
import { it } from 'vitest';

it('valida sync selectivo, payloads y guardas sin AWS real', () => {
  execFileSync('python3', ['-I', 'test/sync_parameters_test.py'], { stdio: 'pipe' });
});

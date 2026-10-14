import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const shellPath = (path: string) => process.platform === 'win32'
  ? path.replaceAll('\\', '/').replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`)
  : path;

for (const failure of ['', 'pull', 'migration']) {
  test(`deployment ${failure ? `stops after a failed ${failure}` : 'migrates before replacing the API'}`, { skip: !existsSync(shell) }, () => {
    const folder = mkdtempSync(join(tmpdir(), 'servicehub-deploy-test-'));
    const log = join(folder, 'calls.log');
    const mock = join(folder, 'docker');
    try {
      writeFileSync(mock, `#!/bin/sh
printf '%s\\n' "$*" >> "$DEPLOY_TEST_LOG"
case "$*" in
  *"pull app migrate"*) [ "$DEPLOY_TEST_FAIL" != "pull" ] || exit 9 ;;
  *"run --rm --no-deps -T migrate"*) [ "$DEPLOY_TEST_FAIL" != "migration" ] || exit 9 ;;
esac
`, { mode: 0o755 });
      const result = spawnSync(shell, ['-c', 'PATH="$1:$PATH"; export PATH; exec sh "$2"', 'deploy-test', shellPath(folder), shellPath(resolve('scripts/deploy.sh'))], {
        env: { ...process.env, DEPLOY_TEST_LOG: shellPath(log), DEPLOY_TEST_FAIL: failure }, timeout: 20000, encoding: 'utf8',
      });
      assert.equal(result.status, failure ? 9 : 0, result.stderr);
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      const migration = calls.indexOf('compose run --rm --no-deps -T migrate');
      const replace = calls.indexOf('compose up -d --no-deps app');
      if (failure) assert.equal(replace, -1, 'existing API must not be replaced on failure');
      else assert.ok(migration >= 0 && replace > migration, 'schema must be ready before API replacement');
    } finally {
      // Delete only the two known files in the directory created by this test.
      if (existsSync(log)) unlinkSync(log);
      unlinkSync(mock);
      rmdirSync(folder);
    }
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';
const { validateMigrationTarget } = require('../../scripts/deploy-migrations.cjs');

test('deployment migrations require an explicit direct connection to the runtime database', () => {
  const DATABASE_URL = 'postgresql://runtime:example@ep-example-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';
  const DIRECT_URL = 'postgresql://migrator:example@ep-example.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';
  assert.doesNotThrow(() => validateMigrationTarget({ DATABASE_URL, DIRECT_URL }));
  assert.doesNotThrow(() => validateMigrationTarget({ DATABASE_URL: 'postgresql://user:example@localhost/db', DIRECT_URL: 'postgresql://user:example@localhost:5432/db' }));
  assert.throws(() => validateMigrationTarget({ DATABASE_URL }), /both DIRECT_URL/);
  assert.throws(() => validateMigrationTarget({ DATABASE_URL, DIRECT_URL: DATABASE_URL }), /not the transaction pooler/);
  assert.throws(() => validateMigrationTarget({ DATABASE_URL, DIRECT_URL: DIRECT_URL.replace('ep-example.', 'ep-other.') }), /same database/);
  assert.throws(() => validateMigrationTarget({ DATABASE_URL, DIRECT_URL: DIRECT_URL.replace('/neondb?', '/wrongdb?') }), /same database/);
  assert.throws(() => validateMigrationTarget({ DATABASE_URL, DIRECT_URL: `${DIRECT_URL}&schema=other` }), /same database/);
  assert.throws(() => validateMigrationTarget({ DATABASE_URL, DIRECT_URL: 'https://example.test/db' }), /PostgreSQL/);
});

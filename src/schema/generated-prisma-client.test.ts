import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
const { assertPrismaClientMatchesSchema } = require('../../scripts/assert-prisma-client.cjs');

test('rejects the old generated enum that caused production services/mine P2023', () => {
  const schema = 'enum PriceType {\n FIXED\n BY_AGREEMENT\n}';
  assert.throws(() => assertPrismaClientMatchesSchema({ PriceType: { FIXED: 'FIXED' } }, schema), /PriceType is missing BY_AGREEMENT/);
  assert.doesNotThrow(() => assertPrismaClientMatchesSchema({ PriceType: { FIXED: 'FIXED', BY_AGREEMENT: 'BY_AGREEMENT' } }, schema));
});

test('the installed client recognizes all current enum values and the consent field', () => {
  assert.doesNotThrow(() => assertPrismaClientMatchesSchema(require('@prisma/client'), readFileSync(resolve('prisma/schema.prisma'), 'utf8')));
});

test('a stale message client is rejected before serving receipt-dependent reads', () => {
  const schema = 'model Message {\n readAt DateTime?\n}';
  assert.throws(() => assertPrismaClientMatchesSchema({ Prisma:{ dmmf:{datamodel:{models:[{name:'Message',fields:[]}]}} } }, schema), /Message.readAt is missing/);
});

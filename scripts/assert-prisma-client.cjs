const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

function assertPrismaClientMatchesSchema(client, schema) {
  // Prisma's JS enum exports describe the schema understood by this client,
  // independently of the database. Validate every checked-in enum value.
  for (const match of schema.matchAll(/enum\s+(\w+)\s*\{([^}]+)\}/g)) {
    const values = match[2].split('\n').map(line => line.trim().match(/^(\w+)\b/)?.[1]).filter(Boolean);
    const missing = values.filter(value => client[match[1]]?.[value] !== value);
    if (missing.length) {
      throw new Error(`Generated Prisma client is stale: ${match[1]} is missing ${missing.join(', ')}. Rebuild the API image with prisma generate from the current schema; do not rewrite existing listing data.`);
    }
  }
  if (/\bpublicMapPin\s+Boolean\b/.test(schema)
    && !client.Prisma?.dmmf?.datamodel?.models?.find(model => model.name === 'Service')?.fields?.some(field => field.name === 'publicMapPin')) {
    throw new Error('Generated Prisma client is stale: Service.publicMapPin is missing. Rebuild the API image from the current schema.');
  }
}

module.exports = { assertPrismaClientMatchesSchema };
if (require.main === module) {
  try {
    const schema = readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8');
    assertPrismaClientMatchesSchema(require('@prisma/client'), schema);
    console.log('[Prisma] Generated client matches the checked-in enum and listing map contract.');
  } catch (error) {
    console.error(`[Prisma] ${error.message}`);
    process.exitCode = 1;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import '../src/config/load-environment';

/** Category work uses the already recorded development endpoint. It does not
 * relax the separate Git-branch guard used by proximity migration commands. */
export function assertCategoryDevelopmentTarget() {
  const targetPath = path.resolve('.database-backups/proximity-target.json');
  if (!fs.existsSync(targetPath)) throw new Error('Missing recorded development database target; refusing category database work.');
  const target = JSON.parse(fs.readFileSync(targetPath, 'utf8')) as { branch: string; hostname: string; database: string };
  if (target.branch !== 'proximity-development') throw new Error('The recorded database is not the selected development branch.');
  for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
    const url = new URL(process.env[key] || '');
    if (url.hostname.replace('-pooler.', '.') !== target.hostname || url.pathname !== target.database) {
      throw new Error(`${key} does not match the recorded development database; refusing category database work.`);
    }
  }
}

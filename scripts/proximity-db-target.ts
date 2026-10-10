import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import '../src/config/load-environment';

// The local endpoint record is based on the developer's explicitly selected
// proximity-development branch; it contains no passwords and is never committed.
export function assertProximityDatabase() {
  const targetPath = path.resolve('.database-backups/proximity-target.json');
  if (!fs.existsSync(targetPath)) throw new Error('Missing private proximity-development endpoint record. Refusing database changes.');
  const target = JSON.parse(fs.readFileSync(targetPath, 'utf8')) as { branch: string; hostname: string; database: string };
  const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
  if (branch !== 'feature/proximity-marketplace' || target.branch !== 'proximity-development') throw new Error('Refusing database changes outside the proximity feature branch.');
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const url = new URL(process.env[name] || '');
    if (url.hostname.replace(/-pooler(?=\.)/, '') !== target.hostname || url.pathname !== target.database) {
      throw new Error(`${name} differs from the recorded proximity-development endpoint. Refusing database changes.`);
    }
  }
  console.log('Database safety check passed: recorded proximity-development endpoint.');
}

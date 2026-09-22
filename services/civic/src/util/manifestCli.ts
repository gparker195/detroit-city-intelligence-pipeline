import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './archive.ts';
const p = join(dataDir(), 'manifest.json');
if (!existsSync(p)) { console.log(JSON.stringify({ manifest: p, exists: false })); process.exit(0); }
const m = JSON.parse(readFileSync(p, 'utf8'));
console.log(JSON.stringify(m, null, 2));

// Fija el host del relé en todos los archivos que lo necesitan.
//   node scripts/set-relay.mjs mi-relay.mi-cuenta.workers.dev
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const next = process.argv[2];
if (!next || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(next)) {
  console.error('Uso: node scripts/set-relay.mjs <host>   (p. ej. deska-spotify-relay.cuenta.workers.dev)');
  process.exit(1);
}
const cfgPath = path.join(root, 'config/relay.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const prev = cfg.host;
const files = ['config/relay.json', 'panel/relay.js', 'panel/panel.json', 'installers/install.ps1', 'installers/install.sh', 'README.md', 'PRIVACY.md'];
for (const f of files) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, 'utf8');
  if (text.includes(prev)) fs.writeFileSync(p, text.replaceAll(prev, next));
}
console.log(`Relé: ${prev} -> ${next}`);

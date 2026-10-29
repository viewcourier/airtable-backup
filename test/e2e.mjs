#!/usr/bin/env node
// End-to-end check against the real Airtable API: lists every base the token can see, backs each one up
// (with --attachments and --safe), then verifies the result with test/verify.mjs.
//
//   AIRTABLE_TOKEN=... node test/e2e.mjs <empty output directory outside the repo> [appXXX appYYY ...]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [root, ...onlyBases] = process.argv.slice(2);
const token = process.env.AIRTABLE_TOKEN;
if (!root || !token) { console.error('Usage: AIRTABLE_TOKEN=... node test/e2e.mjs <output dir> [base ids]'); process.exit(2); }

const res = await fetch('https://api.airtable.com/v0/meta/bases', { headers: { Authorization: 'Bearer ' + token } });
if (!res.ok) { console.error('Listing bases failed: HTTP ' + res.status); process.exit(1); }
const bases = (await res.json()).bases.filter((b) => !onlyBases.length || onlyBases.includes(b.id));
console.log(`Bases visible to the token: ${bases.length}`);

let failed = 0;
for (const b of bases) {
  const out = path.join(root, b.id);
  console.log(`\n== ${b.id} (${b.name})`);
  const run = spawnSync('node', [path.join(here, '..', 'airtable-backup.mjs'), '--base', b.id, '--out', out, '--attachments', '--safe'], { stdio: 'inherit', env: process.env });
  const ver = run.status === 0
    ? spawnSync('node', [path.join(here, 'verify.mjs'), '--base', b.id, '--out', out, '--attachments'], { stdio: 'inherit', env: process.env })
    : { status: 1 };
  if (run.status !== 0 || ver.status !== 0) failed++;
}
console.log(`\n${bases.length - failed}/${bases.length} bases passed`);
process.exit(failed ? 1 : 0);

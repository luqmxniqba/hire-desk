// Runs every test. Needs the local Postgres described in tests/README.md.
import {execFileSync} from 'node:child_process';
for (const t of ['sql.test.mjs', 'e2e.test.mjs', 'confirm.test.mjs']) {
  console.log('\n=== ' + t);
  execFileSync(process.execPath, [new URL(t, import.meta.url).pathname], {stdio: 'inherit'});
}

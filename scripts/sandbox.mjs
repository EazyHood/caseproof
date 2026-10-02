import { mkdir, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createEvidenceStore } from '../src/evidence-store.js';
import { createSandboxWorkflow, SandboxWorkflowError } from '../src/sandbox-workflow.js';

const DEFAULT_STORE = fileURLToPath(new URL('../evidence/private/sandbox-cases/', import.meta.url));
const EXPORTS = fileURLToPath(new URL('../evidence/exports/', import.meta.url));
const HELP = `Caseproof sandbox workflow — no production endpoint exists.
No action occurs without a subcommand. Network commands also require --run.

create --case ID --invoice INVOICE --value 49.00 [--currency USD] --run
       [--retry-create] only after resolving an uncertain prior create request
read --case ID --run
capture --case ID --confirm-capture --run
reconcile --case ID                  offline, stored evidence only
export --case ID                     offline, minimized JSON artifact

All commands accept --store ABSOLUTE_PATH. Default: project evidence/private/sandbox-cases.
Credentials are read from PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET only at execution.
Never pass credentials as command-line arguments. No webhook JSON import is provided.`;

export function parseSandboxArgs(args) {
  if (!args.length || args.includes('--help')) return { help: true };
  const [command, ...rest] = args;
  const allowed = {
    create: new Set(['case', 'invoice', 'value', 'currency', 'store', 'run', 'retry-create']),
    read: new Set(['case', 'store', 'run']), capture: new Set(['case', 'store', 'run', 'confirm-capture']),
    reconcile: new Set(['case', 'store']), export: new Set(['case', 'store'])
  };
  if (!allowed[command]) throw new TypeError('Unknown command.');
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]?.startsWith('--') ? rest[i].slice(2) : '';
    if (!allowed[command].has(key) || Object.hasOwn(options, key)) throw new TypeError('Unknown or repeated option.');
    if (['run', 'confirm-capture', 'retry-create'].includes(key)) options[key] = true;
    else {
      if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new TypeError('Missing option value.');
      options[key] = rest[++i];
    }
  }
  if (!options.case || (command === 'create' && (!options.invoice || !options.value))) throw new TypeError('Required case or invoice fields are missing.');
  if (['create', 'read', 'capture'].includes(command) && options.run !== true) throw new TypeError('Network actions require --run.');
  if (command === 'capture' && options['confirm-capture'] !== true) throw new TypeError('Capture requires --confirm-capture.');
  return { command, options };
}

async function main(args) {
  const parsed = parseSandboxArgs(args);
  if (parsed.help) { console.log(HELP); return; }
  const { command, options } = parsed;
  const store = await createEvidenceStore({ directory: options.store ?? DEFAULT_STORE });
  const workflow = createSandboxWorkflow({ store, env: process.env });
  let output;
  if (command === 'create') output = await workflow.create({ caseId: options.case, invoiceId: options.invoice, value: options.value, currencyCode: options.currency ?? 'USD', retryCreate: options['retry-create'] === true });
  else if (command === 'read') output = await workflow.read(options.case);
  else if (command === 'capture') output = await workflow.capture(options.case, { confirmCapture: true });
  else if (command === 'reconcile') output = await workflow.reconcile(options.case);
  else {
    const exported = await workflow.exportCase(options.case);
    const body = `${JSON.stringify(exported, null, 2)}\n`;
    if (Buffer.byteLength(body) > 256 * 1024) throw new Error('Export too large.');
    await mkdir(EXPORTS, { recursive: true });
    const filename = `${options.case}-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
    const target = join(EXPORTS, filename);
    const handle = await open(target, 'wx', 0o600);
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    output = { artifact: target, caseId: exported.caseId, provenance: exported.provenance, result: exported.result };
  }
  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    const known = error instanceof SandboxWorkflowError;
    console.error(JSON.stringify({ error: {
      code: known ? error.code : 'WORKFLOW_STOPPED',
      message: known ? error.message : 'The workflow stopped. Check command syntax and private store state. No private diagnostics are printed.',
      outcome: known ? error.outcome : 'unknown', ...(known && error.requestId ? { requestId: error.requestId } : {})
    } }, null, 2));
    process.exitCode = 1;
  });
}

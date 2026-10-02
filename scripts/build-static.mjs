import { readFile, writeFile, mkdir, rm, lstat, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { fixtureCase, FIXTURE_CASES } from '../fixtures/cases.js';
import { reconcileCase } from '../src/reconcile.js';
import { toMinor } from '../src/money.js';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const RECORDED_EXPORT = 'evidence/exports/cp-live-sandbox-001-1790916352260-2e56d58c.json';
export const STATIC_FILES = Object.freeze([
  'index.html', 'app.js', 'styles.css', 'config.json', 'run-locally.html', 'evidence/recorded-sandbox.json',
  ...FIXTURE_CASES.map(id => `cases/${id}.json`)
]);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const html = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const within = (root, path) => { const part = relative(root, path); return part === '' || (!part.startsWith('..') && !isAbsolute(part)); };

export function repositoryLink(value) {
  if (value === undefined || value === null) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) throw new TypeError('Repository must be an HTTPS GitHub owner/repository URL without credentials or query parameters.');
  url.pathname = url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
  return url.href;
}

function requiredId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,127}$/.test(value)) throw new TypeError('Recorded evidence contains an invalid public identifier.');
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError('Recorded evidence needs an original ISO observation timestamp.');
  return value;
}

// Project explicit fields instead of copying an export wholesale. A later
// addition to private exports cannot silently add payer data to this bundle.
export function recordedSummary(source, sourceBytes) {
  if (source?.schemaVersion !== '1.0' || source.provenance?.kind !== 'paypal-sandbox' || source.result?.mode !== 'sandbox') throw new TypeError('The recorded artifact must be an authentic sandbox export.');
  const result = source.result;
  const orderId = requiredId(source.orderId);
  if (result.orderId !== orderId || !Array.isArray(result.evidence)) throw new TypeError('Recorded evidence has inconsistent order identity.');
  const order = result.evidence.find(item => item.kind === 'order');
  if (order?.facts?.id !== orderId || order.facts.source !== 'paypal-sandbox' || order.facts.status !== 'COMPLETED') throw new TypeError('The recorded artifact does not contain the expected completed sandbox order.');
  const currencyCode = result.amounts?.currencyCode;
  const expectedMinor = toMinor(result.amounts?.expected, currencyCode);
  const completedMinor = toMinor(result.amounts?.completed, currencyCode);
  if (String(expectedMinor) !== result.amounts.expectedMinor || String(completedMinor) !== result.amounts.completedMinor || result.state !== 'paid' || expectedMinor !== completedMinor || completedMinor <= 0n) throw new TypeError('Recorded reconciliation amounts do not support a completed full capture.');
  const captures = result.evidence.filter(item => item.kind === 'capture').map(item => {
    const capture = item.facts;
    const id = requiredId(capture?.id);
    if (capture.status !== 'COMPLETED' || capture.amount?.currency_code !== currencyCode) throw new TypeError('Recorded capture status or currency is inconsistent.');
    toMinor(capture.amount.value, currencyCode);
    return { id, status: capture.status, amount: { value: capture.amount.value, currencyCode } };
  });
  if (!captures.length || captures.length > 16 || new Set(captures.map(item => item.id)).size !== captures.length || captures.reduce((sum, item) => sum + toMinor(item.amount.value, currencyCode), 0n) !== completedMinor) throw new TypeError('Recorded capture totals are inconsistent.');
  if (!Number.isInteger(source.receipt?.recordCount) || source.receipt.recordCount < 1 || !/^[a-f0-9]{64}$/.test(source.receipt.latestRecordHash ?? '')) throw new TypeError('Recorded receipt metadata is invalid.');
  return {
    schemaVersion: '1.0', provenance: { kind: 'recorded-paypal-sandbox', source: 'paypal-sandbox', notice: 'Recorded authentic sandbox evidence, with fictitious funds. This static page makes no PayPal request, refreshes no status and performs no model inference. This is not a bank-settlement confirmation.' },
    exportedAt: timestamp(source.exportedAt), observedAt: timestamp(order.facts.fetchedAt),
    order: { id: orderId, status: order.facts.status }, invoice: { id: requiredId(result.invoiceId), expected: result.amounts.expected, currencyCode },
    captures, reconciliationAtObservation: { state: result.state, completed: result.amounts.completed, completedMinor: result.amounts.completedMinor, currencyCode },
    receipt: { recordCount: source.receipt.recordCount, latestRecordHash: source.receipt.latestRecordHash },
    source: { file: RECORDED_EXPORT, sha256: createHash('sha256').update(sourceBytes).digest('hex') }
  };
}

function runInstructions(repositoryUrl) {
  const repository = repositoryUrl ? `<p><a href="${html(repositoryUrl)}">Open the source repository ↗</a></p><pre>git clone ${html(repositoryUrl)}.git\ncd ${html(new URL(repositoryUrl).pathname.split('/').at(-1))}\nnode --test\nnode server.mjs</pre>` : '<p>The source repository URL is not configured in this preview build. Obtain the Caseproof project folder from its maintainer, then run:</p><pre>node --test\nnode server.mjs</pre>';
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Run Caseproof locally</title><link rel="stylesheet" href="./styles.css"></head><body><main class="standalone"><a href="./">← Back to the offline demo</a><p class="eyebrow">LOCAL SETUP / REAL SERVICES ARE OPTIONAL</p><h1>Run the full workbench.</h1><p>This hosted demo only reads saved synthetic scenarios and recorded evidence. The source app can inspect PayPal sandbox orders and call an installed local model.</p><h2>1. Start with the deterministic demo</h2><p>Install Node.js 22 or later. Caseproof has no npm dependencies.</p>${repository}<p>Open <code>http://127.0.0.1:5189</code>. The six synthetic scenarios work without accounts or credentials.</p><h2>2. Enable local model proposals</h2><p>Install Ollama and an appropriate model separately, then set <code>CASEPROOF_OLLAMA_MODEL</code> to its installed name in the server environment. The recorded evaluation used <code>qwen3:4b-instruct-2507-q4_K_M</code>. This app does not install models for you.</p><h2>3. Inspect an existing sandbox order</h2><p>Set <code>PAYPAL_CLIENT_ID</code> and <code>PAYPAL_CLIENT_SECRET</code> in the server environment. Keep secrets out of browser code and source control. Read the repository documentation before enabling any explicit CLI payment operation. The web inspection itself does not create or capture an order.</p><p>The AI explanation remains unverified prose even when its structured checks pass. All sandbox funds are fictitious.</p><h2>Recorded evidence</h2><p><a href="./evidence/recorded-sandbox.json">Read the minimized record of an earlier sandbox capture ↗</a></p><p>This record retains its original observation time. Opening it does not query PayPal or verify current payment status.</p></main></body></html>\n`;
}

export async function buildStatic({ projectRoot = PROJECT_ROOT, repositoryUrl } = {}) {
  const workspace = await realpath(PROJECT_ROOT);
  const requestedRoot = resolve(projectRoot);
  const rootInfo = await lstat(requestedRoot);
  const root = await realpath(requestedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !within(workspace, root)) throw new TypeError('Static builds must stay inside this project workspace.');
  const repository = repositoryLink(repositoryUrl);
  async function sourceFile(path) {
    const absolute = join(root, path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !within(root, await realpath(absolute))) throw new TypeError('Build inputs must be regular files inside the selected project.');
    return readFile(absolute, 'utf8');
  }
  const [index, app, css, exportBytes] = await Promise.all(['public/index.html', 'public/app.js', 'public/styles.css', RECORDED_EXPORT].map(sourceFile));
  if (!index.includes('data-caseproof-mode="local"') || !index.includes('id="offline-panel"')) throw new TypeError('The static-mode HTML markers are missing.');
  const evidence = recordedSummary(JSON.parse(exportBytes), exportBytes);
  const configured = {
    mode: 'offline-demo', aiConfigured: false, sandboxConfigured: false, repositoryUrl: repository, cases: [...FIXTURE_CASES],
    recordedEvidence: { path: './evidence/recorded-sandbox.json', observedAt: evidence.observedAt, notice: `Recorded ${evidence.reconciliationAtObservation.completed} ${evidence.invoice.currencyCode} sandbox capture. Observed ${evidence.observedAt}. Fictitious funds; this saved record is not a live status check.` }
  };
  const files = new Map([
    ['index.html', index.replace('data-caseproof-mode="local"', 'data-caseproof-mode="static"').replace(/(id="offline-panel"[^>]*?) hidden/, '$1').replace('id="mode-tag"><span aria-hidden="true"></span>Local workbench', 'id="mode-tag">Offline demo').replace('content="Trace a PayPal sandbox invoice from expectation to evidence. A local reconciliation workbench."', 'content="Explore six synthetic payment scenarios and separately recorded PayPal sandbox evidence. No live services run in this offline demo."')],
    ['app.js', app], ['styles.css', css], ['config.json', json(configured)], ['run-locally.html', runInstructions(repository)], ['evidence/recorded-sandbox.json', json(evidence)]
  ]);
  for (const id of FIXTURE_CASES) {
    const input = fixtureCase(id);
    files.set(`cases/${id}.json`, json({ input, result: reconcileCase(input), provenance: { kind: 'synthetic-fixture', delivery: 'static-precomputed', notice: 'Offline demo: hand-authored synthetic scenario, reconciled during the build. Its scenario timestamps are fixed. No PayPal request or model inference runs on this page.' } }));
  }
  if (files.size !== STATIC_FILES.length || [...files.keys()].some(path => !STATIC_FILES.includes(path))) throw new Error('Unexpected static output path.');
  const outputDirectory = resolve(root, 'dist');
  if (outputDirectory !== join(root, 'dist') || !within(root, outputDirectory)) throw new TypeError('Unsafe static output path.');
  try {
    const info = await lstat(outputDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(outputDirectory) !== outputDirectory) throw new TypeError('The dist path must be an ordinary project directory.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // The resolved deletion target is the fixed dist child of the verified root.
  // Inputs and the complete output allowlist are validated before replacement.
  await rm(outputDirectory, { recursive: true, force: true });
  for (const [path, content] of files) {
    const destination = join(outputDirectory, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, { encoding: 'utf8', flag: 'wx' });
  }
  return { outputDirectory, files: [...files.keys()], repositoryUrl: repository, provenance: 'offline-demo' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--repository')) throw new TypeError('Usage: node scripts/build-static.mjs [--repository https://github.com/OWNER/REPOSITORY]');
  buildStatic({ repositoryUrl: args[1] }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(`Static build failed: ${error.message}`); process.exitCode = 1; });
}

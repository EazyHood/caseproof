import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildStatic, STATIC_FILES, RECORDED_EXPORT, repositoryLink } from '../scripts/build-static.mjs';
import { reconcileCase } from '../src/reconcile.js';
import { FIXTURE_CASES } from '../fixtures/cases.js';

const testsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testsRoot, '..');
async function setup(t) {
  const root = await mkdtemp(join(testsRoot, '.static-build-test-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${testsRoot}${sep}.static-build-test-`));
    await rm(root, { recursive: true, force: true });
  });
  for (const path of ['public/index.html', 'public/app.js', 'public/styles.css', RECORDED_EXPORT]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(join(projectRoot, path), join(root, path));
  }
  return root;
}
async function filesAt(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) result.push(...await filesAt(root, `${name}/`));
    else result.push(name);
  }
  return result.sort();
}

test('static build emits an exact allowlist and never copies private files or prior output', async t => {
  const root = await setup(t);
  for (const path of ['.env', 'evidence/private/receipt.json', 'artifacts/debug.log', 'public/extra.js', 'dist/old-secret.json']) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), 'FORBIDDEN-BUILD-SENTINEL');
  }
  const built = await buildStatic({ projectRoot: root, repositoryUrl: 'https://github.com/example/caseproof' });
  assert.deepEqual(await filesAt(built.outputDirectory), [...STATIC_FILES].sort());
  for (const path of STATIC_FILES) assert.ok(!(await readFile(join(built.outputDirectory, path), 'utf8')).includes('FORBIDDEN-BUILD-SENTINEL'), path);
  const config = JSON.parse(await readFile(join(built.outputDirectory, 'config.json'), 'utf8'));
  assert.equal(config.mode, 'offline-demo');
  assert.equal(config.aiConfigured, false);
  assert.equal(config.sandboxConfigured, false);
  assert.equal(config.repositoryUrl, 'https://github.com/example/caseproof');
  const index = await readFile(join(built.outputDirectory, 'index.html'), 'utf8');
  assert.ok(index.includes('data-caseproof-mode="static"'));
  assert.match(index, /OFFLINE DEMO \/ SYNTHETIC SCENARIOS/);
  assert.doesNotMatch(index, /id="offline-panel"[^>]*\bhidden/);
  assert.doesNotMatch(index, /(?:src|href)="\/(?!\/)/);
});

test('all six saved scenarios are reproducible and retain their synthetic source and clocks', async t => {
  const root = await setup(t);
  const built = await buildStatic({ projectRoot: root });
  for (const id of FIXTURE_CASES) {
    const saved = JSON.parse(await readFile(join(built.outputDirectory, `cases/${id}.json`), 'utf8'));
    assert.deepEqual(saved.result, reconcileCase(saved.input));
    assert.equal(saved.provenance.kind, 'synthetic-fixture');
    assert.equal(saved.provenance.delivery, 'static-precomputed');
    assert.equal(saved.input.observedAt, '2026-10-02T05:00:20Z');
    assert.equal(saved.result.mode, 'fixture');
  }
});

test('recorded sandbox projection excludes extra provider fields and request IDs', async t => {
  const root = await setup(t);
  const path = join(root, RECORDED_EXPORT);
  const original = JSON.parse(await readFile(path, 'utf8'));
  original.extraSecret = 'PRIVATE-EXPORT-SENTINEL';
  original.result.evidence.find(item => item.kind === 'order').facts.payer = { email: 'PRIVATE-EXPORT-SENTINEL' };
  original.requests[0].requestId = 'PRIVATE-EXPORT-SENTINEL';
  await writeFile(path, JSON.stringify(original));
  const built = await buildStatic({ projectRoot: root });
  const text = await readFile(join(built.outputDirectory, 'evidence/recorded-sandbox.json'), 'utf8');
  const saved = JSON.parse(text);
  assert.equal(saved.provenance.kind, 'recorded-paypal-sandbox');
  assert.equal(saved.order.id, '63W11482XV2348118');
  assert.equal(saved.captures[0].id, '4D1364913R338640H');
  assert.equal(saved.captures[0].amount.value, '49.00');
  assert.equal(saved.observedAt, '2026-10-02T04:45:20.692Z');
  assert.equal(saved.receipt.recordCount, 9);
  assert.doesNotMatch(text, /PRIVATE-EXPORT-SENTINEL|requestId|payer/);
});

test('invalid recorded evidence fails before replacing existing dist', async t => {
  const root = await setup(t);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/keep.txt'), 'previous build');
  const path = join(root, RECORDED_EXPORT);
  const original = JSON.parse(await readFile(path, 'utf8'));
  original.result.amounts.completedMinor = '9999';
  await writeFile(path, JSON.stringify(original));
  await assert.rejects(buildStatic({ projectRoot: root }), /amounts/);
  assert.equal(await readFile(join(root, 'dist/keep.txt'), 'utf8'), 'previous build');
});

test('a linked dist directory is refused without deleting its target', async t => {
  const root = await setup(t);
  await mkdir(join(root, 'retained'));
  await writeFile(join(root, 'retained/keep.txt'), 'do not delete');
  await symlink(join(root, 'retained'), join(root, 'dist'), 'junction');
  await assert.rejects(buildStatic({ projectRoot: root }), /ordinary project directory/);
  assert.equal(await readFile(join(root, 'retained/keep.txt'), 'utf8'), 'do not delete');
});

test('repository links cannot embed credentials, scripts, query tokens or unrelated hosts', () => {
  assert.equal(repositoryLink(undefined), null);
  assert.equal(repositoryLink('https://github.com/example/caseproof.git'), 'https://github.com/example/caseproof');
  for (const url of ['javascript:alert(1)', 'http://github.com/example/repo', 'https://evil.example/example/repo', 'https://user:secret@github.com/example/repo', 'https://github.com/example/repo?token=secret', 'https://github.com/example/repo#fragment']) assert.throws(() => repositoryLink(url));
});

test('static UI loads project-relative JSON and all six cases without calling any service', async t => {
  const root = await setup(t);
  const built = await buildStatic({ projectRoot: root, repositoryUrl: 'https://github.com/example/caseproof' });
  class Element {
    constructor(tag = '') { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.hidden = false; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = [...items]; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    querySelectorAll(tag) { return this.children.filter(child => child.tag === tag); }
    focus() {}
  }
  const nodes = new Map();
  const get = selector => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  const currencyNodes = [new Element(), new Element(), new Element()];
  const document = {
    documentElement: { dataset: { caseproofMode: 'static' } }, baseURI: 'https://pages.example/caseproof/index.html',
    querySelector: get, querySelectorAll: () => currencyNodes, createElement: tag => new Element(tag)
  };
  const requests = [];
  const context = {
    document, URL, AbortSignal, location: { hash: '', pathname: '/caseproof/index.html' }, history: { replaceState() {} },
    fetch: async (url, options) => {
      requests.push({ url, method: options.method });
      assert.equal(options.method, 'GET');
      assert.ok(url.startsWith('https://pages.example/caseproof/'));
      assert.ok(!url.includes('/api/'));
      const path = new URL(url).pathname.slice('/caseproof/'.length);
      assert.ok(STATIC_FILES.includes(path));
      return new Response(await readFile(join(built.outputDirectory, path), 'utf8'), { headers: { 'Content-Type': 'application/json' } });
    }
  };
  // The script's final expression is boot(); await its promise so slow disks
  // cannot race an arbitrary polling limit. No browser or network is involved.
  await vm.runInNewContext(await readFile(join(built.outputDirectory, 'app.js'), 'utf8'), context);
  for (const button of get('#cases').children) await button.listeners.click();
  assert.equal(get('#cases').children.length, 6);
  assert.equal(get('#main-error').hidden, true);
  assert.equal(get('#analyze').disabled, true);
  assert.equal(get('#sandbox-fields').disabled, true);
  assert.equal(get('#mode-tag').textContent, 'Offline demo');
  assert.match(get('#ai-status').textContent, /disabled in this offline demo/);
  const count = requests.length;
  await get('#analyze').listeners.click();
  get('#sandbox-form').listeners.submit({ preventDefault() {} });
  assert.equal(requests.length, count);
  assert.ok(requests.some(item => item.url.endsWith('/cases/unverified-webhook.json')));
});

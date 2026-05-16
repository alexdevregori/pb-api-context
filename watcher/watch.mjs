#!/usr/bin/env node
/**
 * Productboard API Spec Watcher (repo edition)
 *
 * Lives in a GitHub repo that distributes a Claude skill + plugin to your team.
 * On each run:
 *   1. Fetches the live Productboard OpenAPI spec files from the developer portal.
 *   2. Compares each to the cached copy under skill/productboard-api/reference/.
 *   3. If changed: overwrites the reference files, regenerates INDEX.md,
 *      appends a human-readable entry to CHANGELOG.md, mirrors everything
 *      into plugins/productboard-api/skills/productboard-api/, and exits
 *      with code 0. The CI workflow that calls this script will then commit
 *      and push the changes.
 *   4. If unchanged: exits 0 silently, CI commits nothing.
 *
 * Usage:
 *   node watch.mjs                 # check + update files in place
 *   node watch.mjs --check-only    # exit 1 if drift detected, don't write
 *   node watch.mjs --force         # treat as if everything changed (testing)
 */

import { readFile, writeFile, mkdir, readdir, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ---------- CONFIG ----------
const INDEX_URL = 'https://developer.productboard.com/openapi';
const BASE_URL = 'https://developer.productboard.com';

// The skill lives at one canonical path. Claude Code's plugin loader
// expects skills under plugins/<plugin-name>/skills/<skill-name>/.
const SKILL_REF_DIR = join(REPO_ROOT, 'plugins', 'productboard-api', 'skills', 'productboard-api', 'reference');
const CHANGELOG_PATH = join(REPO_ROOT, 'CHANGELOG.md');

// ---------- ARGS ----------
const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check-only');
const FORCE = args.has('--force');

// ---------- MAIN ----------
async function main() {
  await mkdir(SKILL_REF_DIR, { recursive: true });

  log(`Discovering spec files from ${INDEX_URL}...`);
  const files = await discoverSpecFiles();
  log(`Found ${files.length} spec file(s): ${files.join(', ')}`);

  const allDiffs = [];
  const added = [];
  const removed = [];

  // Detect cached files that no longer appear in the index
  const cached = (await readdir(SKILL_REF_DIR).catch(() => [])).filter(f => f.endsWith('.yaml'));
  for (const c of cached) if (!files.includes(c)) removed.push(c);

  for (const file of files) {
    const url = `${BASE_URL}/openapi/${file}`;
    const cachePath = join(SKILL_REF_DIR, file);

    const liveText = await fetchSpec(url);
    const liveHash = sha256(liveText);

    if (!existsSync(cachePath)) {
      added.push(file);
      if (!CHECK_ONLY) await writeFile(cachePath, liveText);
      continue;
    }

    const cachedText = await readFile(cachePath, 'utf8');
    if (!FORCE && sha256(cachedText) === liveHash) {
      log(`  ${file}: unchanged`);
      continue;
    }

    log(`  ${file}: change detected, diffing...`);
    const diff = diffSpecs(parseSpec(cachedText), parseSpec(liveText));
    if (diff.hasChanges || FORCE) {
      allDiffs.push({ file, diff });
    }
    if (!CHECK_ONLY) await writeFile(cachePath, liveText);
  }

  const anyChange = allDiffs.length || added.length || removed.length;
  if (!anyChange) {
    log('No changes. Repo is in sync with live spec.');
    return;
  }

  if (CHECK_ONLY) {
    log('Drift detected. Exiting 1.');
    process.exit(1);
  }

  // Remove cached files that disappeared upstream
  for (const r of removed) {
    log(`  removing stale: ${r}`);
    await unlinkSafe(join(SKILL_REF_DIR, r));
  }

  // Regenerate INDEX.md from the now-updated specs
  await regenerateIndex();

  // Append to changelog
  await appendChangelog({ added, removed, diffs: allDiffs });

  log('Done. Files updated:');
  log('  plugins/productboard-api/skills/productboard-api/reference/*.yaml');
  log('  plugins/productboard-api/skills/productboard-api/reference/INDEX.md');
  log('  CHANGELOG.md');
}

// ---------- HELPERS ----------

async function discoverSpecFiles() {
  const res = await fetch(INDEX_URL, { headers: { 'User-Agent': 'pb-api-context-watcher/1.0' } });
  if (!res.ok) throw new Error(`Index fetch failed: ${res.status}`);
  const html = await res.text();
  const re = /href="\/openapi\/([^"]+\.ya?ml)"/g;
  const found = new Set();
  let m;
  while ((m = re.exec(html)) !== null) found.add(m[1]);
  if (found.size === 0) {
    throw new Error('Could not find spec links in the index page. Layout may have changed.');
  }
  return [...found].sort();
}

async function fetchSpec(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'pb-api-context-watcher/1.0' } });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} for ${url}`);
  return await res.text();
}

function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
function parseSpec(text) { return YAML.parse(text); }

async function unlinkSafe(path) {
  try { const { unlink } = await import('node:fs/promises'); await unlink(path); } catch {}
}

async function regenerateIndex() {
  log('Regenerating INDEX.md...');
  const files = (await readdir(SKILL_REF_DIR)).filter(f => f.endsWith('.yaml')).sort();

  let md = '# Productboard API Spec Index\n\n';
  md += 'High-level map of endpoints across all spec files. ';
  md += 'Use this to decide which spec file to load before generating code.\n\n';
  md += `_Last generated: ${new Date().toISOString().slice(0, 10)}_\n\n`;

  for (const f of files) {
    const text = await readFile(join(SKILL_REF_DIR, f), 'utf8');
    const spec = parseSpec(text);
    md += `## \`${f}\` — ${spec.info?.title || ''}\n\n`;
    if (spec.info?.description) {
      md += `${spec.info.description.split('\n')[0]}\n\n`;
    }
    const paths = Object.keys(spec.paths || {}).sort();
    md += `**Endpoints (${paths.length}):**\n\n`;
    for (const p of paths) {
      const methods = Object.keys(spec.paths[p])
        .filter(k => ['get', 'post', 'put', 'patch', 'delete'].includes(k.toLowerCase()))
        .map(m => m.toUpperCase())
        .join(', ');
      md += `- \`${methods}\` ${p}\n`;
    }
    md += '\n';
  }

  await writeFile(join(SKILL_REF_DIR, 'INDEX.md'), md);
}

async function appendChangelog({ added, removed, diffs }) {
  log('Appending to CHANGELOG.md...');
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`## ${date}`, ''];

  if (added.length) {
    lines.push(`### New spec files`);
    for (const f of added) lines.push(`- \`${f}\``);
    lines.push('');
  }
  if (removed.length) {
    lines.push(`### Removed spec files (breaking)`);
    for (const f of removed) lines.push(`- \`${f}\``);
    lines.push('');
  }
  for (const { file, diff } of diffs) {
    if (!diff.hasChanges) continue;  // skip empty entries (e.g. --force with no real change)
    lines.push(`### \`${file}\``);
    if (diff.infoChanged) {
      lines.push(`- Version: \`${diff.infoChanged.from}\` → \`${diff.infoChanged.to}\``);
    }
    if (diff.pathsAdded.length) lines.push(`- Endpoints added: ${diff.pathsAdded.map(p => `\`${p}\``).join(', ')}`);
    if (diff.pathsRemoved.length) lines.push(`- **Endpoints removed (breaking):** ${diff.pathsRemoved.map(p => `\`${p}\``).join(', ')}`);
    for (const op of diff.operationsChanged) {
      lines.push(`- \`${op.method} ${op.path}\`: ${op.changes.join('; ')}`);
    }
    if (diff.schemasAdded.length) lines.push(`- Schemas added: ${diff.schemasAdded.join(', ')}`);
    if (diff.schemasRemoved.length) lines.push(`- **Schemas removed (breaking):** ${diff.schemasRemoved.join(', ')}`);
    for (const s of diff.schemasChanged) {
      lines.push(`- Schema \`${s.name}\`: ${s.changes.join('; ')}`);
    }
    lines.push('');
  }

  // If nothing actually changed (e.g. --force with no diffs), don't write a noisy entry
  if (lines.length <= 2 && !added.length && !removed.length) return;

  const newBlock = lines.join('\n');
  let existing = '';
  if (existsSync(CHANGELOG_PATH)) {
    existing = await readFile(CHANGELOG_PATH, 'utf8');
  } else {
    existing = '# Productboard API Spec Changelog\n\nAutomated changes detected by the watcher.\n\n';
  }
  // Insert new block after the header
  const headerEnd = existing.indexOf('\n\n', existing.indexOf('#')) + 2;
  const updated = existing.slice(0, headerEnd) + newBlock + '\n' + existing.slice(headerEnd);
  await writeFile(CHANGELOG_PATH, updated);
}

// ---------- DIFF ----------

function diffSpecs(prev, next) {
  const result = {
    hasChanges: false,
    pathsAdded: [], pathsRemoved: [], operationsChanged: [],
    schemasAdded: [], schemasRemoved: [], schemasChanged: [],
    infoChanged: null,
  };
  if (prev?.info?.version !== next?.info?.version) {
    result.infoChanged = { from: prev?.info?.version, to: next?.info?.version };
    result.hasChanges = true;
  }
  const pp = prev?.paths || {}, np = next?.paths || {};
  for (const p of new Set([...Object.keys(pp), ...Object.keys(np)])) {
    if (!pp[p]) { result.pathsAdded.push(p); result.hasChanges = true; continue; }
    if (!np[p]) { result.pathsRemoved.push(p); result.hasChanges = true; continue; }
    for (const m of new Set([...Object.keys(pp[p]).filter(isHttpMethod), ...Object.keys(np[p]).filter(isHttpMethod)])) {
      const c = diffOperation(pp[p][m], np[p][m]);
      if (c.length) { result.operationsChanged.push({ path: p, method: m.toUpperCase(), changes: c }); result.hasChanges = true; }
    }
  }
  const ps = prev?.components?.schemas || {}, ns = next?.components?.schemas || {};
  for (const s of new Set([...Object.keys(ps), ...Object.keys(ns)])) {
    if (!ps[s]) { result.schemasAdded.push(s); result.hasChanges = true; }
    else if (!ns[s]) { result.schemasRemoved.push(s); result.hasChanges = true; }
    else {
      const c = diffSchema(ps[s], ns[s]);
      if (c.length) { result.schemasChanged.push({ name: s, changes: c }); result.hasChanges = true; }
    }
  }
  return result;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
const isHttpMethod = (k) => HTTP_METHODS.has(k.toLowerCase());

function diffOperation(a, b) {
  if (!a || !b) return [];
  const changes = [];
  if (a.operationId !== b.operationId) changes.push(`operationId: ${a.operationId} → ${b.operationId}`);
  if (!!a.deprecated !== !!b.deprecated) changes.push(b.deprecated ? 'NEWLY DEPRECATED' : 'un-deprecated');
  const aP = (a.parameters || []).map(paramKey), bP = (b.parameters || []).map(paramKey);
  const rem = aP.filter(x => !bP.includes(x)), add = bP.filter(x => !aP.includes(x));
  if (rem.length) changes.push(`params removed: ${rem.join(', ')}`);
  if (add.length) changes.push(`params added: ${add.join(', ')}`);
  const aR = (a.parameters || []).filter(p => p.required).map(paramKey);
  const bR = (b.parameters || []).filter(p => p.required).map(paramKey);
  const nReq = bR.filter(x => !aR.includes(x) && aP.includes(x));
  const nOpt = aR.filter(x => !bR.includes(x) && bP.includes(x));
  if (nReq.length) changes.push(`now required: ${nReq.join(', ')}`);
  if (nOpt.length) changes.push(`now optional: ${nOpt.join(', ')}`);
  const aResp = Object.keys(a.responses || {}), bResp = Object.keys(b.responses || {});
  const remR = aResp.filter(x => !bResp.includes(x)), addR = bResp.filter(x => !aResp.includes(x));
  if (remR.length) changes.push(`response codes removed: ${remR.join(', ')}`);
  if (addR.length) changes.push(`response codes added: ${addR.join(', ')}`);
  if (!!a.requestBody?.required !== !!b.requestBody?.required) {
    changes.push(`requestBody required: ${!!a.requestBody?.required} → ${!!b.requestBody?.required}`);
  }
  return changes;
}

function paramKey(p) { return p.$ref ? `ref:${p.$ref}` : `${p.in || '?'}:${p.name || '?'}`; }

function diffSchema(a, b) {
  const changes = [];
  const aP = Object.keys(a?.properties || {}), bP = Object.keys(b?.properties || {});
  const rem = aP.filter(x => !bP.includes(x)), add = bP.filter(x => !aP.includes(x));
  if (rem.length) changes.push(`properties removed: ${rem.join(', ')}`);
  if (add.length) changes.push(`properties added: ${add.join(', ')}`);
  const aR = a?.required || [], bR = b?.required || [];
  const nReq = bR.filter(x => !aR.includes(x)), nOpt = aR.filter(x => !bR.includes(x));
  if (nReq.length) changes.push(`now required: ${nReq.join(', ')}`);
  if (nOpt.length) changes.push(`now optional: ${nOpt.join(', ')}`);
  return changes;
}

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }

main().catch((e) => { console.error('Watcher failed:', e); process.exit(2); });

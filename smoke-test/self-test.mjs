#!/usr/bin/env node
/**
 * Self-test for the smoke test's validation helpers.
 * Runs without needing the Anthropic API.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REF_DIR = join(__dirname, '..', 'plugins', 'productboard-api', 'skills', 'productboard-api', 'reference');

// Import the same helpers test.mjs uses by re-defining them inline (test.mjs doesn't export)
function extractConsultedFiles(response) {
  const match = response.match(/consulted_files:\s*\n((?:\s*-\s*[\w.-]+\n?)+)/);
  if (!match) return [];
  return [...match[1].matchAll(/-\s*([\w.-]+)/g)].map(m => m[1]);
}

function extractApiPaths(response) {
  const paths = new Set();
  const re = /['"`](\/v2\/[^'"`\s\\]+)['"`]/g;
  let m;
  while ((m = re.exec(response)) !== null) {
    let path = m[1].split('?')[0];
    path = path.replace(/\$\{[^}]+\}/g, '{id}');
    path = path.replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, '/{id}');
    paths.add(path);
  }
  return [...paths];
}

function pathMatches(usedPath, knownPaths) {
  if (knownPaths.has(usedPath)) return true;
  const usedNorm = usedPath.replace(/\{[^}]+\}/g, '{X}');
  for (const known of knownPaths) {
    const knownNorm = known.replace(/\{[^}]+\}/g, '{X}');
    if (usedNorm === knownNorm) return true;
  }
  return false;
}

function detectLanguage(response) {
  const langs = {
    python: /```python|import requests|def \w+\(|print\(/,
    apps_script: /UrlFetchApp|PropertiesService|SpreadsheetApp|function \w+\(\)[\s\S]*?Utilities/,
    javascript: /```(javascript|js|ts|typescript)|const \w+ = require|import .* from|await fetch\(/,
    shell: /```(bash|sh|shell)|curl -[XH]|\\\n\s+-H/,
  };
  const matches = [];
  for (const [lang, re] of Object.entries(langs)) {
    if (re.test(response)) matches.push(lang);
  }
  return matches;
}

async function loadKnownPaths() {
  const paths = new Set();
  const files = (await readdir(REF_DIR)).filter(f => f.endsWith('.yaml'));
  for (const f of files) {
    const text = await readFile(join(REF_DIR, f), 'utf8');
    const parsed = YAML.parse(text);
    for (const p of Object.keys(parsed?.paths || {})) paths.add(p);
  }
  return paths;
}

// ---------- TESTS ----------
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${detail}`); fail++; }
}

console.log('\nTest 1: extractConsultedFiles');
const r1 = `Some response.
\`\`\`yaml
consulted_files:
  - notes.yaml
  - entities.yaml
\`\`\``;
const c1 = extractConsultedFiles(r1);
check('extracts 2 files', c1.length === 2);
check('extracts notes.yaml', c1.includes('notes.yaml'));
check('extracts entities.yaml', c1.includes('entities.yaml'));

const r1b = `No yaml block here, just text.`;
check('empty when no block', extractConsultedFiles(r1b).length === 0);

console.log('\nTest 2: extractApiPaths');
const r2 = `Here's code:
const url = "/v2/entities/search";
fetch(\`/v2/notes/\${noteId}\`);
'/v2/entities/abc123-def456/relationships'
'/v2/entities/3a662103-4951-4969-97f7-00f312cfe998/relationships'`;
const p2 = extractApiPaths(r2);
check('finds /v2/entities/search', p2.includes('/v2/entities/search'));
check('normalizes template literal', p2.some(p => p === '/v2/notes/{id}'));
check('normalizes UUID to {id}', p2.some(p => p === '/v2/entities/{id}/relationships'),
  `got: ${p2.join(', ')}`);

console.log('\nTest 3: pathMatches');
const known = new Set(['/v2/entities/search', '/v2/entities/{id}', '/v2/notes/{id}/relationships']);
check('exact match', pathMatches('/v2/entities/search', known));
check('param match', pathMatches('/v2/entities/{anything}', known));
check('param match against UUID-normalized', pathMatches('/v2/notes/{id}/relationships', known));
check('rejects unknown', !pathMatches('/v2/fakething', known));

console.log('\nTest 4: detectLanguage');
check('detects python from import requests', detectLanguage('import requests\nx = 1').includes('python'));
check('detects python from def', detectLanguage('def hello():\n  pass').includes('python'));
check('detects apps_script from UrlFetchApp', detectLanguage('const r = UrlFetchApp.fetch(url)').includes('apps_script'));
check('detects javascript from import', detectLanguage("import { foo } from 'bar';\nawait fetch('/v2/x')").includes('javascript'));
check('detects shell from curl', detectLanguage('curl -X POST \\\n  -H "Authorization: Bearer x"').includes('shell'));
check('detects nothing in plain prose', detectLanguage('Just describing the API').length === 0);

console.log('\nTest 5: full pipeline against real specs');
const known2 = await loadKnownPaths();
console.log(`  loaded ${known2.size} real endpoints`);
check('loaded real endpoints', known2.size > 0);

// Simulate a "good" response
const goodResponse = `Here's a function:
\`\`\`python
import requests
def get_feature(id):
    r = requests.get(f"https://api.productboard.com/v2/entities/{id}")
    return r.json()
\`\`\`
\`\`\`yaml
consulted_files:
  - entities.yaml
\`\`\``;
const usedPaths = extractApiPaths(goodResponse);
const allKnown = usedPaths.every(p => pathMatches(p, known2));
check('good response: paths all match real spec', allKnown, `paths: ${usedPaths.join(', ')}`);
check('good response: language detected as python', detectLanguage(goodResponse).includes('python'));
check('good response: consulted entities.yaml', extractConsultedFiles(goodResponse).includes('entities.yaml'));

// Simulate a "bad" response with a hallucinated endpoint
const badResponse = `\`\`\`python
import requests
r = requests.get("/v2/totally-fake-endpoint/that-does-not-exist")
\`\`\`
\`\`\`yaml
consulted_files:
  - entities.yaml
\`\`\``;
const badPaths = extractApiPaths(badResponse);
const allKnownBad = badPaths.every(p => pathMatches(p, known2));
check('bad response: hallucinated endpoint detected', !allKnownBad);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

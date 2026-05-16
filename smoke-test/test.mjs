#!/usr/bin/env node
/**
 * Productboard API skill smoke test
 *
 * Runs each prompt in prompts.json through the Anthropic API with the skill
 * content injected as a system prompt, then validates Claude's response:
 *
 *   1. Did Claude reference at least one spec file? (skill triggered correctly)
 *   2. Do all API paths in the response exist in the actual YAML specs?
 *      (no hallucinated/stale endpoints)
 *   3. Did Claude write code in the expected language?
 *
 * Exits 0 if all prompts pass, non-zero if any fail.
 * Writes a Markdown report to ./report.md for the GitHub Actions workflow.
 *
 * Environment:
 *   ANTHROPIC_API_KEY — required
 *   ANTHROPIC_MODEL   — optional, defaults to claude-opus-4-7
 *
 * Usage:
 *   node test.mjs              # run all prompts
 *   node test.mjs --prompt name_here   # run a single prompt by name (for debugging)
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SKILL_DIR = join(REPO_ROOT, 'plugins', 'productboard-api', 'skills', 'productboard-api');
const REF_DIR = join(SKILL_DIR, 'reference');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-7';

if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY not set');
  process.exit(2);
}

const args = process.argv.slice(2);
const SINGLE_PROMPT = args.includes('--prompt') ? args[args.indexOf('--prompt') + 1] : null;

// ---------- LOAD SKILL CONTENT ----------

async function loadSkillContext() {
  const skillMd = await readFile(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const dataModel = await readFile(join(REF_DIR, 'DATA_MODEL.md'), 'utf8');
  const indexMd = await readFile(join(REF_DIR, 'INDEX.md'), 'utf8');

  // Strip frontmatter from SKILL.md (the API doesn't need it)
  const skillBody = skillMd.replace(/^---[\s\S]*?---\n/, '');

  // Load all spec files so the test can validate paths against them
  const specs = {};
  const files = (await readdir(REF_DIR)).filter(f => f.endsWith('.yaml'));
  for (const f of files) {
    const text = await readFile(join(REF_DIR, f), 'utf8');
    specs[f] = { text, parsed: YAML.parse(text) };
  }

  return { skillBody, dataModel, indexMd, specs };
}

// ---------- BUILD SYSTEM PROMPT ----------

function buildSystemPrompt(ctx) {
  return `You are operating with the productboard-api skill loaded. Below is the skill content and its supporting documents. Follow the skill's instructions.

---SKILL.md---
${ctx.skillBody}

---reference/INDEX.md---
${ctx.indexMd}

---reference/DATA_MODEL.md---
${ctx.dataModel}

---spec files available---
${Object.keys(ctx.specs).map(f => `- reference/${f}`).join('\n')}

When the user asks for code, follow SKILL.md exactly. At the end of your response, on a new line, write a YAML block listing which spec files you consulted, like this:

\`\`\`yaml
consulted_files:
  - notes.yaml
  - entities.yaml
\`\`\`

This is required for the smoke test to verify the skill activated correctly.`;
}

// ---------- CALL API ----------

async function askClaude(systemPrompt, userPrompt, specs) {
  // For prompts that require reading specific spec files, include them in the system prompt
  // so Claude has them in context (we don't have actual file-read tools in this simulation).
  const expandedSystem = `${systemPrompt}\n\n---spec file contents---\n\n${
    Object.entries(specs).map(([name, { text }]) => `### ${name}\n\n\`\`\`yaml\n${text.slice(0, 30000)}\n\`\`\``).join('\n\n')
  }`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: expandedSystem,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`API call failed: ${res.status} ${errorText}`);
  }

  const body = await res.json();
  return body.content.map(block => block.text || '').join('\n');
}

// ---------- VALIDATION ----------

function extractConsultedFiles(response) {
  const match = response.match(/consulted_files:\s*\n((?:\s*-\s*[\w.-]+\n?)+)/);
  if (!match) return [];
  return [...match[1].matchAll(/-\s*([\w.-]+)/g)].map(m => m[1]);
}

function extractApiPaths(response) {
  // Look for paths starting with /v2/
  const paths = new Set();
  const re = /['"`](\/v2\/[^'"`\s\\]+)['"`]/g;
  let m;
  while ((m = re.exec(response)) !== null) {
    // Normalize: strip query strings, normalize path params
    let path = m[1].split('?')[0];
    // Replace ${variableName} or {variableName} with {id}-style param markers
    path = path.replace(/\$\{[^}]+\}/g, '{id}');
    path = path.replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, '/{id}');
    paths.add(path);
  }
  return [...paths];
}

function allKnownPaths(specs) {
  const paths = new Set();
  for (const { parsed } of Object.values(specs)) {
    for (const p of Object.keys(parsed?.paths || {})) {
      paths.add(p);
    }
  }
  return paths;
}

function pathMatches(usedPath, knownPaths) {
  // Direct match
  if (knownPaths.has(usedPath)) return true;
  // Normalize {param} placeholders to a single wildcard for comparison
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

// ---------- RUN ----------

async function runPrompt(promptDef, ctx, knownPaths) {
  const systemPrompt = buildSystemPrompt(ctx);
  const response = await askClaude(systemPrompt, promptDef.prompt, ctx.specs);

  const consulted = extractConsultedFiles(response);
  const usedPaths = extractApiPaths(response);
  const detected = detectLanguage(response);

  const failures = [];

  // Check 1: skill activated (consulted at least one file)
  if (consulted.length === 0) {
    failures.push('skill did not activate — no consulted_files block in response');
  }

  // Check 2: expected spec files were referenced
  for (const expected of promptDef.must_reference_spec_files) {
    if (!consulted.includes(expected)) {
      failures.push(`expected spec file not consulted: ${expected}`);
    }
  }

  // Check 3: every API path exists in the specs
  const unknownPaths = usedPaths.filter(p => !pathMatches(p, knownPaths));
  if (unknownPaths.length > 0) {
    failures.push(`unknown API paths (not in specs): ${unknownPaths.join(', ')}`);
  }

  // Check 4: language matches expectation
  if (detected.length && !detected.includes(promptDef.expected_language)) {
    failures.push(`expected ${promptDef.expected_language}, got ${detected.join('/')}`);
  } else if (detected.length === 0) {
    failures.push('could not detect any code language in response');
  }

  return {
    name: promptDef.name,
    prompt: promptDef.prompt,
    passed: failures.length === 0,
    failures,
    consulted,
    usedPaths,
    detected,
    responseExcerpt: response.slice(0, 500),
  };
}

async function main() {
  console.log(`Loading skill content from ${SKILL_DIR}...`);
  const ctx = await loadSkillContext();
  const knownPaths = allKnownPaths(ctx.specs);
  console.log(`Loaded ${Object.keys(ctx.specs).length} spec files with ${knownPaths.size} total endpoints.`);

  const promptsRaw = await readFile(join(__dirname, 'prompts.json'), 'utf8');
  let prompts = JSON.parse(promptsRaw);
  if (SINGLE_PROMPT) {
    prompts = prompts.filter(p => p.name === SINGLE_PROMPT);
    if (prompts.length === 0) {
      console.error(`No prompt named "${SINGLE_PROMPT}"`);
      process.exit(2);
    }
  }

  console.log(`Running ${prompts.length} prompt(s) against model ${MODEL}...\n`);

  const results = [];
  for (const p of prompts) {
    process.stdout.write(`  ${p.name}... `);
    try {
      const r = await runPrompt(p, ctx, knownPaths);
      results.push(r);
      console.log(r.passed ? 'PASS' : `FAIL (${r.failures.length} issue${r.failures.length === 1 ? '' : 's'})`);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      results.push({ name: p.name, prompt: p.prompt, passed: false, failures: [`error: ${e.message}`] });
    }
  }

  const failed = results.filter(r => !r.passed);
  const report = renderReport(results, knownPaths.size);
  await writeFile(join(__dirname, 'report.md'), report);

  console.log(`\nReport: ${join(__dirname, 'report.md')}`);
  console.log(`Result: ${results.length - failed.length}/${results.length} passed`);

  if (failed.length > 0) process.exit(1);
}

function renderReport(results, endpointCount) {
  const lines = [];
  lines.push(`# Productboard API Skill Smoke Test`);
  lines.push(`Run: ${new Date().toISOString()}`);
  lines.push(`Model: ${MODEL}`);
  lines.push(`Spec endpoints loaded: ${endpointCount}`);
  lines.push('');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed);
  lines.push(`**${passed}/${results.length} prompts passed.**`);
  lines.push('');

  if (failed.length === 0) {
    lines.push('All prompts passed.');
    return lines.join('\n');
  }

  lines.push(`## Failures (${failed.length})`);
  lines.push('');
  for (const r of failed) {
    lines.push(`### \`${r.name}\``);
    lines.push(`**Prompt:** ${r.prompt}`);
    lines.push('');
    lines.push('**Failures:**');
    for (const f of r.failures) lines.push(`- ${f}`);
    lines.push('');
    if (r.consulted) lines.push(`**Files Claude consulted:** ${r.consulted.length ? r.consulted.join(', ') : '(none)'}`);
    if (r.usedPaths) lines.push(`**API paths Claude used:** ${r.usedPaths.length ? r.usedPaths.join(', ') : '(none)'}`);
    if (r.detected) lines.push(`**Languages detected:** ${r.detected.length ? r.detected.join(', ') : '(none)'}`);
    if (r.responseExcerpt) {
      lines.push('');
      lines.push('**Response excerpt (first 500 chars):**');
      lines.push('```');
      lines.push(r.responseExcerpt);
      lines.push('```');
    }
    lines.push('');
  }

  return lines.join('\n');
}

main().catch((e) => {
  console.error('Smoke test runner crashed:', e);
  process.exit(2);
});

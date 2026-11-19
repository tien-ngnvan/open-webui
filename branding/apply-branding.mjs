#!/usr/bin/env node
/**
 * branding/apply-branding.mjs — generic, dependency-free branding engine.
 *
 * Reads brand.json (values + flags) and patches.json (patch targets + asset
 * copies) from its own directory, then applies idempotent text patches and
 * byte copies to the repository rooted one level above this file. Runs on
 * Node stdlib only so the Docker build stage (node:22-alpine) can execute it.
 *
 * Modes:
 *   --apply    (default) write changes; exit 1 on drift/errors
 *   --check    verify the tree is fully branded; write nothing; exit 1
 *              unless every entry is already in its final state
 *   --report   dry-run; prints per-entry status; exit 1 on drift/errors
 *   --restore  git-restore every repo file this layer touches
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');

const mode = process.argv[2] ?? '--apply';
if (!['--apply', '--check', '--report', '--restore'].includes(mode)) {
	console.error(`Unknown mode: ${mode}. Use --apply | --check | --report | --restore`);
	process.exit(2);
}

const brand = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'brand.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'patches.json'), 'utf8'));

// Optional locale prune config — missing file disables the step entirely.
let localePrune = null;
try {
	localePrune = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'locales.json'), 'utf8'));
	if (!Array.isArray(localePrune.keep)) {
		console.error('branding/locales.json must be {"keep": ["<locale-code>", ...]}');
		process.exit(2);
	}
} catch (e) {
	if (e.code !== 'ENOENT') throw e;
}

const WRITE = mode === '--apply';

function interpolate(value) {
	if (typeof value !== 'string') return value;
	return value.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
		if (!(key in brand)) throw new Error(`Unknown placeholder {{${key}}} in patches.json`);
		return String(brand[key]);
	});
}

function countOccurrences(haystack, needle) {
	if (needle === '') return 0;
	let count = 0;
	let i = 0;
	while ((i = haystack.indexOf(needle, i)) !== -1) {
		count += 1;
		i += needle.length;
	}
	return count;
}

function flagEnabled(flag) {
	return !flag || brand.flags?.[flag] !== false;
}

// ---------- patches ----------

const byFile = new Map();
for (const patch of config.patches) {
	if (!byFile.has(patch.file)) byFile.set(patch.file, []);
	byFile.get(patch.file).push(patch);
}

const results = [];
const touchedFiles = [];

for (const [file, patches] of byFile) {
	touchedFiles.push(file);
	const abs = path.join(ROOT, file);

	let content;
	try {
		content = fs.readFileSync(abs, 'utf8');
	} catch {
		for (const p of patches) results.push({ patch: p, status: 'ERROR', detail: 'file not found', file });
		continue;
	}

	let changed = false;
	for (const p of patches) {
		if (!flagEnabled(p.flag)) {
			results.push({ patch: p, status: 'SKIP', detail: `flag ${p.flag}=false`, file });
			continue;
		}
		if (p.unless && content.includes(p.unless)) {
			results.push({ patch: p, status: 'SKIP', detail: 'marker present', file });
			continue;
		}

		let replace;
		try {
			replace = interpolate(p.replace);
		} catch (e) {
			results.push({ patch: p, status: 'ERROR', detail: e.message, file });
			continue;
		}

		const findCount = countOccurrences(content, p.find);
		const replaceCount = replace === p.find ? 0 : countOccurrences(content, replace);

		if (findCount > 0) {
			if (p.count != null && findCount !== p.count) {
				results.push({
					patch: p,
					status: 'DRIFT',
					detail: `expected ${p.count} occurrence(s), found ${findCount}`,
					file
				});
				continue;
			}
			const next = content.split(p.find).join(replace);
			if (next === content) {
				results.push({ patch: p, status: 'NOOP', detail: 'replace identical to find', file });
				continue;
			}
			content = next;
			changed = true;
			results.push({ patch: p, status: 'APPLIED', detail: `${findCount} occurrence(s)`, file });
		} else if (replaceCount > 0 || p.replace === '') {
			// replace === '' marks a removal patch: the find being gone means applied.
			results.push({ patch: p, status: 'NOOP', detail: 'already applied', file });
		} else {
			results.push({ patch: p, status: 'DRIFT', detail: 'anchor not found', file });
		}
	}

	if (changed && WRITE) fs.writeFileSync(abs, content);
}

// ---------- assets ----------

const assetResults = [];

for (const entry of config.assets ?? []) {
	const srcAbs = path.join(SCRIPT_DIR, 'assets', entry.src);
	let srcBuf;
	try {
		srcBuf = fs.readFileSync(srcAbs);
	} catch {
		const status = entry.required === false || !flagEnabled(entry.flag) ? 'SKIP' : 'ERROR';
		assetResults.push({ entry, status, detail: 'asset missing', dest: null });
		continue;
	}
	if (!flagEnabled(entry.flag)) {
		assetResults.push({ entry, status: 'SKIP', detail: `flag ${entry.flag}=false`, dest: null });
		continue;
	}

	const srcHash = crypto.createHash('sha256').update(srcBuf).digest('hex');
	for (const dest of entry.dests) {
		touchedFiles.push(dest);
		const destAbs = path.join(ROOT, dest);
		if (!fs.existsSync(path.dirname(destAbs))) {
			assetResults.push({ entry, status: 'ERROR', detail: `dest dir missing: ${path.dirname(dest)}`, dest });
			continue;
		}
		let destHash = null;
		try {
			destHash = crypto.createHash('sha256').update(fs.readFileSync(destAbs)).digest('hex');
		} catch {
			/* dest missing */
		}
		if (destHash === srcHash) {
			assetResults.push({ entry, status: 'NOOP', detail: 'identical', dest });
			continue;
		}
		assetResults.push({ entry, status: 'APPLIED', detail: 'copied', dest });
		if (WRITE) {
			fs.mkdirSync(path.dirname(destAbs), { recursive: true });
			fs.copyFileSync(srcAbs, destAbs);
		}
	}
}

// ---------- locales ----------

// Prune UI languages to the keep-list in locales.json: filter
// locales/languages.json and delete locale directories. Upstream languages not
// in the keep-list are removed automatically, so new upstream entries stay
// pruned across syncs. --restore brings every tracked locale back via git.
const localeResults = [];
const LOCALES_DIR = 'src/lib/i18n/locales';

if (localePrune) {
	touchedFiles.push(LOCALES_DIR, `${LOCALES_DIR}/languages.json`);
	const keep = new Set(localePrune.keep);
	const languagesRaw = fs.readFileSync(path.join(ROOT, LOCALES_DIR, 'languages.json'), 'utf8');
	const upstream = JSON.parse(languagesRaw);

	const upstreamCodes = new Set(upstream.map(({ code }) => code));
	for (const code of keep) {
		if (!upstreamCodes.has(code)) {
			localeResults.push({ code, status: 'DRIFT', detail: 'keep-list entry missing upstream' });
		}
	}

	const kept = upstream.filter(({ code }) => keep.has(code));
	const serialized = JSON.stringify(kept, null, '\t') + '\n';
	if (serialized !== languagesRaw) {
		localeResults.push({
			code: 'languages.json',
			status: 'RM',
			detail: `${upstream.length - kept.length} entr(y/ies) ${WRITE ? 'removed' : 'would remove'}`
		});
		if (WRITE) fs.writeFileSync(path.join(ROOT, LOCALES_DIR, 'languages.json'), serialized);
	} else {
		localeResults.push({ code: 'languages.json', status: 'NOOP', detail: 'already pruned' });
	}

	for (const entry of fs.readdirSync(path.join(ROOT, LOCALES_DIR), { withFileTypes: true })) {
		if (!entry.isDirectory() || keep.has(entry.name)) continue;
		localeResults.push({ code: entry.name, status: 'RM', detail: WRITE ? 'removed' : 'would remove' });
		if (WRITE) fs.rmSync(path.join(ROOT, LOCALES_DIR, entry.name), { recursive: true, force: true });
	}
}

// ---------- output ----------

if (mode !== '--restore') {
	const pad = (s, n) => String(s).padEnd(n);
	console.log(`branding: ${brand.name} <${brand.slug}> (mode: ${mode.slice(2)})\n`);

	for (const r of results) {
		console.log(`  [${pad(r.status, 6)}] ${pad(r.patch.id, 38)} ${r.file} — ${r.detail}`);
	}
	for (const r of assetResults) {
		console.log(
			`  [${pad(r.status, 6)}] ${pad(`asset:${r.entry.src}`, 38)} ${r.dest ?? '(all dests)'} — ${r.detail}`
		);
	}
	for (const r of localeResults) {
		console.log(`  [${pad(r.status, 6)}] ${pad(`locale:${r.code}`, 38)} ${LOCALES_DIR}/${r.code} — ${r.detail}`);
	}

	const count = (arr, status) => arr.filter((r) => r.status === status).length;
	const summary = {
		applied: count(results, 'APPLIED') + count(assetResults, 'APPLIED'),
		noop: count(results, 'NOOP') + count(assetResults, 'NOOP'),
		skip: count(results, 'SKIP') + count(assetResults, 'SKIP'),
		drift: count(results, 'DRIFT'),
		error: count(results, 'ERROR') + count(assetResults, 'ERROR')
	};
	const locales = {
		kept: localePrune ? JSON.parse(fs.readFileSync(path.join(ROOT, LOCALES_DIR, 'languages.json'), 'utf8')).length : 0,
		pending: count(localeResults, 'RM'),
		drift: count(localeResults, 'DRIFT')
	};

	console.log(
		`\npatches/assets: applied=${summary.applied} noop=${summary.noop} skip=${summary.skip} drift=${summary.drift} error=${summary.error}`
	);
	if (localePrune) {
		console.log(
			`locales: kept=${locales.kept} ${locales.pending > 0 ? `${WRITE ? 'removed' : 'pending-removal'}=${locales.pending}` : 'pruned'}${locales.drift > 0 ? ` drift=${locales.drift}` : ''}`
		);
	}

	let exit = 0;
	if (summary.drift > 0 || summary.error > 0 || locales.drift > 0) {
		exit = 1;
		console.error(`result: FAILED — update branding/patches.json to match upstream, then re-run.`);
	} else if (mode === '--check' && (summary.applied > 0 || locales.pending > 0)) {
		exit = 1;
		console.error(`result: NOT BRANDED — ${summary.applied + locales.pending} entry(ies) still pending; run with --apply.`);
	} else {
		console.log(`result: OK`);
	}
	process.exit(exit);
}

// ---------- --restore ----------

const uniqueFiles = [...new Set(touchedFiles)];
const bulk = spawnSync('git', ['-C', ROOT, 'restore', '--worktree', '--', ...uniqueFiles], {
	stdio: 'inherit'
});
if (bulk.status !== 0) {
	console.error('bulk restore failed; falling back to per-file restore');
	for (const f of uniqueFiles) {
		const r = spawnSync('git', ['-C', ROOT, 'restore', '--worktree', '--', f], { stdio: 'pipe' });
		if (r.status !== 0) console.warn(`  [WARN] could not restore ${f} (untracked or unchanged?)`);
	}
}
console.log(`restored ${uniqueFiles.length} file(s)`);

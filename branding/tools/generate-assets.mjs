#!/usr/bin/env node
/**
 * branding/tools/generate-assets.mjs — one-time asset generator.
 *
 * Derives the full branding asset set from a single source logo (PNG or SVG)
 * into branding/assets/. Requires sharp: `npm install` inside this directory.
 * The app build never touches this directory.
 *
 * Usage:
 *   npm install               # inside branding/tools/
 *   node generate-assets.mjs <source.png|svg> [--dark <dark.png|svg>]
 *
 * Output (in branding/assets/):
 *   favicon.png 512², favicon-96x96.png, apple-touch-icon.png 180²,
 *   web-app-manifest-192x192.png / -512x512.png, logo.png 500²,
 *   splash.png / splash-dark.png 500², swagger-favicon.png 32²,
 *   favicon.ico (16/32/48/64), favicon.svg (512² PNG wrapped),
 *   plus custom.css / loader.js if not already present.
 *
 * All raster assets are letterboxed onto a transparent square canvas
 * (`fit: contain`), so non-square sources stay undistorted.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(TOOLS_DIR, '..', 'assets');

const args = process.argv.slice(2);
const darkIdx = args.indexOf('--dark');
const darkSource = darkIdx !== -1 ? args[darkIdx + 1] : null;
const source = args.find((a, i) => a !== '--dark' && (darkIdx === -1 || i !== darkIdx + 1));

if (!source) {
	console.error('usage: node generate-assets.mjs <source.png|svg> [--dark <dark.png|svg>]');
	process.exit(2);
}
for (const f of [source, ...(darkSource ? [darkSource] : [])]) {
	if (!fs.existsSync(f)) {
		console.error(`source not found: ${f}`);
		process.exit(2);
	}
}

fs.mkdirSync(ASSETS_DIR, { recursive: true });

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

async function squarePng(input, size) {
	return sharp(input)
		.resize({ width: size, height: size, fit: 'contain', background: TRANSPARENT })
		.png()
		.toBuffer();
}

function buildIco(pngBuffers, sizes) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(pngBuffers.length, 4); // image count
	let offset = 6 + 16 * pngBuffers.length;
	const dirs = pngBuffers.map((buf, i) => {
		const s = sizes[i];
		const e = Buffer.alloc(16);
		e.writeUInt8(s >= 256 ? 0 : s, 0); // width
		e.writeUInt8(s >= 256 ? 0 : s, 1); // height
		e.writeUInt8(0, 2); // palette count
		e.writeUInt8(0, 3); // reserved
		e.writeUInt16LE(1, 4); // color planes
		e.writeUInt16LE(32, 6); // bits per pixel
		e.writeUInt32LE(buf.length, 8);
		e.writeUInt32LE(offset, 12);
		offset += buf.length;
		return e;
	});
	return Buffer.concat([header, ...dirs, ...pngBuffers]);
}

function write(name, data) {
	fs.writeFileSync(path.join(ASSETS_DIR, name), data);
	console.log(`  wrote ${name} (${data.length} bytes)`);
}

console.log(`source: ${source}${darkSource ? ` (dark: ${darkSource})` : ''}`);

const favicon512 = await squarePng(source, 512);
write('favicon.png', favicon512);
write('favicon-96x96.png', await squarePng(source, 96));
write('apple-touch-icon.png', await squarePng(source, 180));
write('web-app-manifest-192x192.png', await squarePng(source, 192));
write('web-app-manifest-512x512.png', await squarePng(source, 512));
write('logo.png', await squarePng(source, 500));
write('swagger-favicon.png', await squarePng(source, 32));

const splashLight = await squarePng(source, 500);
write('splash.png', splashLight);
write('splash-dark.png', darkSource ? await squarePng(darkSource, 500) : splashLight);

const icoSizes = [16, 32, 48, 64];
const icoPngs = [];
for (const s of icoSizes) icoPngs.push(await squarePng(source, s));
write('favicon.ico', buildIco(icoPngs, icoSizes));

// SVG favicon: wrap the 512px raster (same approach upstream uses).
const b64 = favicon512.toString('base64');
write(
	'favicon.svg',
	`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"><image width="512" height="512" xlink:href="data:image/png;base64,${b64}"/></svg>`
);

for (const stub of ['custom.css', 'loader.js']) {
	if (!fs.existsSync(path.join(ASSETS_DIR, stub))) write(stub, '');
}

console.log(`\ndone — assets in ${ASSETS_DIR}`);
console.log('next: node branding/apply-branding.mjs --apply');

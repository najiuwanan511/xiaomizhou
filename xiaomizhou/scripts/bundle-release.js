import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runtimeFiles } from '../update-manager.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const output = path.resolve(process.argv[2] || path.join(root, 'release'));
const name = `xiaomizhou-v${version}.json`;
const files = Object.fromEntries(runtimeFiles.map(file => [file, fs.readFileSync(path.join(root, file)).toString('base64')]));
const contents = JSON.stringify({ format: 1, version, files });
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, name), contents);
fs.writeFileSync(path.join(output, `${name}.sha256`), `${crypto.createHash('sha256').update(contents).digest('hex')}  ${name}\n`);
console.log(`Created ${name}`);

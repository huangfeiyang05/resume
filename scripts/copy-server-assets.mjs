import { cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'server/assets');
// tsc keeps the "server" directory under dist/server because rootDir is the project root;
// keep the renderer's font next to the compiled worker so production PDF export can load it.
const destination = resolve(root, 'dist/server/server/assets');
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
console.log(`Server assets copied: ${destination}`);

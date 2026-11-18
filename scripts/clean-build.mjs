import { rm } from 'node:fs/promises';

// Fixed generated-output path; never accept a cleanup target from arguments.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });

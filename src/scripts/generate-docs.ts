/**
 * Writes the generated reference documents to docs/. Run with: npm run docs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderErrorCatalogue, renderEventCatalogue } from '../docs/render-docs.js';

mkdirSync('docs', { recursive: true });
writeFileSync(join('docs', 'error-codes.md'), renderErrorCatalogue());
writeFileSync(join('docs', 'events.md'), renderEventCatalogue());
console.log('Wrote docs/error-codes.md and docs/events.md');

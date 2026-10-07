/**
 * OpenAPI specification generator
 * Run with: npm run openapi
 */

import { NestFactory } from '@nestjs/core';
import { buildOpenApiDocument } from '../common/api/openapi.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../app.module.js';
import { configureApp } from '../app.setup.js';

async function generate() {
  console.log('Generating OpenAPI specification...');

  const app = await NestFactory.create(AppModule, {
    logger: false, // Suppress logs during generation
  });

  // Same prefix, versioning and pipes as the real server, so the spec paths are /api/v1/...
  configureApp(app);

  const document = buildOpenApiDocument(app);

  // Write to file
  const outputPath = join(process.cwd(), 'openapi.json');
  writeFileSync(outputPath, JSON.stringify(document, null, 2));

  console.log(`✓ OpenAPI spec generated: ${outputPath}`);

  await app.close();
  process.exit(0);
}

generate().catch((error) => {
  console.error('✗ OpenAPI generation failed:', error);
  process.exit(1);
});

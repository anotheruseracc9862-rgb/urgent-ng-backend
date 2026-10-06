/**
 * OpenAPI specification generator
 * Run with: npm run openapi
 */

import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../app.module.js';

async function generate() {
  console.log('Generating OpenAPI specification...');

  const app = await NestFactory.create(AppModule, {
    logger: false, // Suppress logs during generation
  });

  const config = new DocumentBuilder()
    .setTitle('Urgent.ng API')
    .setDescription('Urgent.ng backend API documentation')
    .setVersion('1.0')
    .addBearerAuth()
    .addServer('/api/v1', 'API v1')
    .build();

  const document = SwaggerModule.createDocument(app, config);

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

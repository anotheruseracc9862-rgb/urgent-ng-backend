/**
 * Integration test demonstrating app factory with supertest
 */

import { describe, it, expect, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import {
  createTestApp,
  createTestRequest,
  closeTestApp,
} from './app.factory.js';

describe('App Factory (Integration)', () => {
  let app: INestApplication;

  afterAll(async () => {
    if (app) {
      await closeTestApp(app);
    }
  });

  it('should create a configured test app', async () => {
    app = await createTestApp();
    
    expect(app).toBeDefined();
    expect(app.getHttpServer()).toBeDefined();
  });

  it('should make HTTP requests with supertest', async () => {
    app = await createTestApp();
    const request = createTestRequest(app);
    
    const response = await request
      .get('/api/v1/health')
      .expect(200);
    
    // Response is wrapped in envelope: { data: { status: 'ok' }, meta, requestId }
    expect(response.body).toHaveProperty('data');
    expect(response.body.data).toHaveProperty('status');
    expect(response.body.data.status).toBe('ok');
  });

  it('should apply global prefix and versioning', async () => {
    app = await createTestApp();
    const request = createTestRequest(app);
    
    // Without prefix/version should fail
    await request.get('/health').expect(404);
    
    // With correct prefix/version should work
    await request.get('/api/v1/health').expect(200);
  });

  it('should include request ID in responses', async () => {
    app = await createTestApp();
    const request = createTestRequest(app);
    
    const response = await request
      .get('/api/v1/health')
      .expect(200);
    
    // Response body should have request ID
    expect(response.body).toHaveProperty('requestId');
    expect(response.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    
    // Response header should also have request ID
    expect(response.headers['x-request-id']).toBeDefined();
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
  });
});

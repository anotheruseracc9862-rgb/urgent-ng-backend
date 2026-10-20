import { describe, expect, it } from 'vitest';
import { corsOriginsFrom } from './configuration.js';

describe('corsOriginsFrom()', () => {
  it('allows the web and admin origins, without paths or trailing slashes', () => {
    expect(
      corsOriginsFrom({ NODE_ENV: 'production', WEB_APP_URL: 'https://app.example.com/', ADMIN_APP_URL: 'https://admin.example.com/dashboard' }),
    ).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });

  it('works with the web app only, and does not add the local apps in production', () => {
    expect(corsOriginsFrom({ NODE_ENV: 'production', WEB_APP_URL: 'https://app.example.com' })).toEqual(['https://app.example.com']);
  });

  it('adds the local apps outside production, with no duplicates', () => {
    expect(corsOriginsFrom({ NODE_ENV: 'development' })).toEqual(['http://localhost:4001', 'http://localhost:4002']);
    expect(corsOriginsFrom({ NODE_ENV: 'development', WEB_APP_URL: 'http://localhost:4001' })).toEqual(['http://localhost:4001', 'http://localhost:4002']);
  });

  it('ignores a malformed address instead of throwing', () => {
    expect(corsOriginsFrom({ NODE_ENV: 'production', WEB_APP_URL: 'not a url', ADMIN_APP_URL: 'https://admin.example.com' })).toEqual(['https://admin.example.com']);
  });
});

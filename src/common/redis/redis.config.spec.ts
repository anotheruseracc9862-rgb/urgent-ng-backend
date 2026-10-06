import { describe, expect, it } from 'vitest';
import { redisOptionsFromUrl } from './redis.config.js';

describe('redisOptionsFromUrl', () => {
  it('parses a plain URL with the default port and database 0', () => {
    expect(redisOptionsFromUrl('redis://localhost')).toEqual({
      host: 'localhost',
      port: 6379,
      db: 0,
    });
  });

  it('keeps the port and database index', () => {
    expect(redisOptionsFromUrl('redis://localhost:6399/15')).toMatchObject({
      host: 'localhost',
      port: 6399,
      db: 15,
    });
  });

  it('keeps the password (the bug that dropped it from the old config service)', () => {
    expect(redisOptionsFromUrl('redis://:s3cret@cache.example.ng:6379')).toMatchObject({
      password: 's3cret',
    });
  });

  it('keeps an ACL username and decodes escaped characters', () => {
    const options = redisOptionsFromUrl('redis://app%40prod:p%40ss%2Fword@host:6379');

    expect(options.username).toBe('app@prod');
    expect(options.password).toBe('p@ss/word');
  });

  it('enables TLS for rediss://', () => {
    expect(redisOptionsFromUrl('rediss://:pw@host:6380')).toMatchObject({
      tls: {},
      port: 6380,
    });
    expect(redisOptionsFromUrl('redis://host')).not.toHaveProperty('tls');
  });

  it('rejects a non-redis URL and a bad database index', () => {
    expect(() => redisOptionsFromUrl('http://host')).toThrow('redis://');
    expect(() => redisOptionsFromUrl('redis://host/abc')).toThrow('database index');
  });
});

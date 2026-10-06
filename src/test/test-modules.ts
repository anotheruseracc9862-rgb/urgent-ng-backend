/**
 * Shared Nest module imports for integration tests that build a small module
 * instead of the full AppModule.
 */

import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration.js';

/** Global ConfigModule with the app configuration (reads the test env). */
export function testConfigModule() {
  return ConfigModule.forRoot({
    isGlobal: true,
    load: [configuration],
    ignoreEnvFile: true,
  });
}

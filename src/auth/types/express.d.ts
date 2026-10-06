import type { AuthenticatedUser } from '../decorators/current-user.decorator.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

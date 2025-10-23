import type { FastifyInstance } from 'fastify';
import { postRegisterHandler } from './post.register.controller.js';
import { postLoginHandler } from './post.login.controller.js';
import { postLogoutHandler } from './post.logout.controller.js';
import { postVerifyEmailHandler } from './post.verifyEmail.controller.js';
import { postForgotPasswordHandler } from './post.forgotPassword.controller.js';

export async function authRoutes(server: FastifyInstance) {
  server.post('/register', { handler: postRegisterHandler });
  server.post('/login', { handler: postLoginHandler });
  server.post('/logout', { handler: postLogoutHandler });
  // Use dynamic import to avoid module resolution issues during typecheck
  const { postRefreshHandler } = await import('./post.refresh.controller.js');
  server.post('/refresh', { handler: postRefreshHandler });
  server.post('/verify-email', { handler: postVerifyEmailHandler });
  server.post('/forgot-password', { handler: postForgotPasswordHandler });
}

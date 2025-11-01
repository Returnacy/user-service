import type { FastifyInstance } from 'fastify';

import { postForgotPasswordHandler } from './post.forgotPassword.controller.js';
import { postLoginHandler } from './post.login.controller.js';
import { postLogoutHandler } from './post.logout.controller.js';
import { postRefreshHandler } from './post.refresh.controller.js';
import { postRegisterHandler } from './post.register.controller.js';
import { postVerifyEmailHandler } from './post.verifyEmail.controller.js';

export async function authRoute(server: FastifyInstance) {
  server.post('/register', { handler: postRegisterHandler });
  server.post('/login', { handler: postLoginHandler });
  server.post('/logout', { handler: postLogoutHandler });
  server.post('/refresh', { handler: postRefreshHandler });
  server.post('/verify-email', { handler: postVerifyEmailHandler });
  server.post('/forgot-password', { handler: postForgotPasswordHandler });
}

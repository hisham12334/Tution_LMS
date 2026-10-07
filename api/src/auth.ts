import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { pool } from './db.js';

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required.`);
  return value;
};

const appOrigin = required('APP_ORIGIN');

// In local development, keep reset links in memory when SMTP is not configured so
// an admin can copy the link instead of the invitation failing after account creation.
const developmentResetLinks = new Map<string, { url: string; expiresAt: number }>();
export function takeDevelopmentResetLink(email: string) {
  const key = email.toLowerCase();
  const entry = developmentResetLinks.get(key);
  developmentResetLinks.delete(key);
  return entry && entry.expiresAt > Date.now() ? entry.url : undefined;
}

export const auth = betterAuth({
  database: pool,
  baseURL: process.env.BETTER_AUTH_URL,
  secret: required('BETTER_AUTH_SECRET'),
  trustedOrigins: [appOrigin],
  advanced: { database: { generateId: () => randomUUID() } },
  emailAndPassword: {
    enabled: true,
    disableSignUp: process.env.BOOTSTRAP_ADMIN !== 'true',
    minPasswordLength: 10,
    sendResetPassword: async ({ user, url }) => {
      if (process.env.NODE_ENV === 'development' && (!process.env.SMTP_HOST || !process.env.SMTP_FROM)) {
        developmentResetLinks.set(user.email.toLowerCase(), { url, expiresAt: Date.now() + 60 * 60 * 1000 });
        return;
      }
      await sendAuthEmail(user.email, 'Reset your Astute Academy password', `Use this secure link to set a new password: ${url}`);
    },
  },
  user: {
    changeEmail: { enabled: false },
    deleteUser: { enabled: false },
  },
  plugins: [admin({ adminRoles: ['admin'], defaultRole: 'user' })],
  session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 12 },
});

export async function sendAuthEmail(to: string, subject: string, text: string) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_FROM) throw new Error('Email delivery is not configured.');
  // Keep email delivery behind an adapter; SMTP transport is supplied in deployment configuration.
  const { createTransport } = await import('nodemailer');
  const transport = createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT || 587) === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASSWORD } : undefined,
  });
  await transport.sendMail({ from: SMTP_FROM, to, subject, text });
}

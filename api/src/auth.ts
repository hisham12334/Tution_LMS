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
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

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
      const isInvitation = new URL(url).searchParams.get('callbackURL') === `${appOrigin}/?setup=invite`;
      if (isInvitation) {
        const name = user.name?.trim() || 'there';
        const text = `Dear ${name},

Welcome to Astute Academy! We are delighted to have you join our learning community. Your account has been created and is ready for you to set up.

To get started, please create your password using this secure link:
${url}

This link expires in one hour. Once your password is set, you can sign in at ${appOrigin}.

If you were not expecting this invitation, you can safely ignore this email.

Warm regards,
The Astute Academy Team`;
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:32px 16px;background:#f7f8fc;font-family:Arial,sans-serif;color:#163142"><div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d4d8e8;border-radius:12px;overflow:hidden"><div style="padding:24px 32px;background:#163142;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.03em">ASTUTE ACADEMY</div><div style="padding:32px"><h1 style="margin:0 0 24px;font-size:28px;line-height:1.2">Welcome to Astute Academy</h1><p style="line-height:1.6">Dear ${escapeHtml(name)},</p><p style="line-height:1.6">We are delighted to have you join our learning community. Your account has been created and is ready for you to set up.</p><p style="line-height:1.6">To get started, please create your password using the button below.</p><p style="margin:28px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 22px;border-radius:8px;background:#f7941d;color:#163142;font-weight:700;text-decoration:none">Set your password</a></p><p style="line-height:1.6">This link expires in one hour. Once your password is set, you can <a href="${escapeHtml(appOrigin)}" style="color:#163142">sign in to Astute Academy</a>.</p><p style="line-height:1.6">If you were not expecting this invitation, you can safely ignore this email.</p><p style="margin:28px 0 0;line-height:1.6">Warm regards,<br><strong>The Astute Academy Team</strong></p></div><div style="padding:18px 32px;background:#f7f8fc;color:#6b7194;font-size:12px;line-height:1.5">If the button does not work, copy this link into your browser:<br><a href="${escapeHtml(url)}" style="color:#163142;overflow-wrap:anywhere">${escapeHtml(url)}</a></div></div></body></html>`;
        await sendAuthEmail(user.email, 'Welcome to Astute Academy — set up your account', text, html);
        return;
      }
      await sendAuthEmail(user.email, 'Reset your Astute Academy password', `Hello ${user.name?.trim() || 'there'},\n\nWe received a request to reset your Astute Academy password. Use this secure link to choose a new password:\n${url}\n\nThis link expires in one hour. If you did not request a password reset, you can safely ignore this email.\n\nThe Astute Academy Team`);
    },
  },
  user: {
    changeEmail: { enabled: false },
    deleteUser: { enabled: false },
  },
  plugins: [admin({ adminRoles: ['admin'], defaultRole: 'user' })],
  session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 12 },
});

export async function sendAuthEmail(to: string, subject: string, text: string, html?: string) {
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
  await transport.sendMail({ from: SMTP_FROM, to, subject, text, html });
}

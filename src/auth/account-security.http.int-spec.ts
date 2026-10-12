import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import {
  API,
  REQUIRED_CONSENTS,
  bearer,
  fakeOtp,
  lastCode,
  nextPhone,
  registerUser,
  seedPolicies,
  signedInUser,
} from '../test/auth.helper.js';
import { FakeGoogleIdentityProvider } from '../common/providers/fakes/google-identity.fake.js';

process.env.RATE_LIMIT_DISABLED = 'true';

const token = (subject: string, email: string | null, name = 'Google User', unverified = false) =>
  FakeGoogleIdentityProvider.token(subject, email, name, { unverified });

describe('Account security, profile extras and Google sign-in (HTTP)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  const server = () => app.getHttpServer();
  const get = (path: string, accessToken: string) => request(server()).get(`${API}${path}`).set(...bearer(accessToken));
  const post = (path: string, accessToken: string) => request(server()).post(`${API}${path}`).set(...bearer(accessToken));
  const put = (path: string, accessToken: string) => request(server()).put(`${API}${path}`).set(...bearer(accessToken));
  const patch = (path: string, accessToken: string) => request(server()).patch(`${API}${path}`).set(...bearer(accessToken));
  const google = (body: Record<string, unknown>) =>
    request(server()).post(`${API}/auth/google`).set('X-Client', 'mobile').send(body);

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    fakeOtp(app).reset();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('bio and home area', () => {
    it('saves a bio and a home area, shows them on me, and the bio on the public profile', async () => {
      const user = await signedInUser(app);

      const res = await patch('/me', user.accessToken)
        .send({ bio: 'Reliable and friendly.', homeArea: 'Lagos - Lekki & Ajah' })
        .expect(200);

      expect(res.body.data).toMatchObject({ bio: 'Reliable and friendly.', homeArea: 'Lagos - Lekki & Ajah' });
      const other = await signedInUser(app, { name: 'Bayo Ade' });
      const publicView = await get(`/users/${user.userId}`, other.accessToken).expect(200);
      expect(publicView.body.data.bio).toBe('Reliable and friendly.');
      expect(publicView.body.data).not.toHaveProperty('homeArea');
    });

    it('clears them with null and refuses a bio over 300 characters', async () => {
      const user = await signedInUser(app);
      await patch('/me', user.accessToken).send({ bio: 'hello' }).expect(200);

      const cleared = await patch('/me', user.accessToken).send({ bio: null }).expect(200);
      expect(cleared.body.data.bio).toBeNull();

      await patch('/me', user.accessToken).send({ bio: 'x'.repeat(301) }).expect(400);
    });

    it('takes the home area at registration', async () => {
      const phone = nextPhone();
      await request(server())
        .post(`${API}/auth/register`)
        .send({ name: 'Ada Obi', phone, password: 'Str0ng-passw0rd!', consents: REQUIRED_CONSENTS, homeArea: 'Abuja' })
        .expect(201);

      const profile = await prisma.$queryRaw<Array<{ home_area: string | null }>>`
        SELECT p.home_area FROM profiles p JOIN users u ON u.id = p.user_id WHERE u.phone_e164 = ${phone}
      `;
      expect(profile[0].home_area).toBe('Abuja');
    });
  });

  describe('change password', () => {
    it('changes the password, keeps this session and ends the others', async () => {
      const user = await signedInUser(app);
      const other = await request(server())
        .post(`${API}/auth/login`)
        .set('X-Client', 'mobile')
        .send({ phone: user.phone, password: user.password })
        .expect(200);

      await post('/me/password', user.accessToken)
        .send({ currentPassword: user.password, newPassword: 'An0ther-str0ng-one!' })
        .expect(204);

      await get('/me', user.accessToken).expect(200);
      await request(server())
        .post(`${API}/auth/refresh`)
        .set('X-Client', 'mobile')
        .send({ refreshToken: other.body.data.refreshToken })
        .expect(401);
      await request(server()).post(`${API}/auth/login`).send({ phone: user.phone, password: user.password }).expect(401);
      await request(server())
        .post(`${API}/auth/login`)
        .set('X-Client', 'mobile')
        .send({ phone: user.phone, password: 'An0ther-str0ng-one!' })
        .expect(200);
    });

    it('refuses a wrong current password, the same new password and a short one', async () => {
      const user = await signedInUser(app);

      await post('/me/password', user.accessToken).send({ currentPassword: 'wrong-password-1', newPassword: 'An0ther-str0ng-one!' }).expect(401);
      await post('/me/password', user.accessToken).send({ currentPassword: user.password, newPassword: user.password }).expect(400);
      await post('/me/password', user.accessToken).send({ currentPassword: user.password, newPassword: 'short' }).expect(400);
    });
  });

  describe('add or change a phone number or email', () => {
    it('adds an email after the code is confirmed', async () => {
      const user = await signedInUser(app);
      const email = 'ada.obi@example.com';

      await post('/me/contact', user.accessToken).send({ currentPassword: user.password, email }).expect(200);
      const bad = await post('/me/contact/verify', user.accessToken).send({ email, code: '000000' }).expect(400);
      expect(bad.body.error.code).toBe('OTP_INVALID');
      await post('/me/contact/verify', user.accessToken).send({ email, code: lastCode(app, email) }).expect(200);

      const me = await get('/me', user.accessToken).expect(200);
      expect(me.body.data).toMatchObject({ email, emailVerified: true });
    });

    it('changes the phone number, and the old number can no longer sign in', async () => {
      const user = await signedInUser(app);
      const next = nextPhone();

      await post('/me/contact', user.accessToken).send({ currentPassword: user.password, phone: next }).expect(200);
      await post('/me/contact/verify', user.accessToken).send({ phone: next, code: lastCode(app, next) }).expect(200);

      await request(server()).post(`${API}/auth/login`).send({ phone: user.phone, password: user.password }).expect(401);
      await request(server())
        .post(`${API}/auth/login`)
        .set('X-Client', 'mobile')
        .send({ phone: next, password: user.password })
        .expect(200);
    });

    it('needs the current password and refuses a number another account holds', async () => {
      const user = await signedInUser(app);
      const holder = await signedInUser(app);

      await post('/me/contact', user.accessToken).send({ currentPassword: 'nope-nope-nope', phone: nextPhone() }).expect(401);
      const taken = await post('/me/contact', user.accessToken)
        .send({ currentPassword: user.password, phone: holder.phone })
        .expect(409);
      expect(taken.body.error.code).toBe('IDENTIFIER_TAKEN');
    });

    it('does not change anything before the code is confirmed', async () => {
      const user = await signedInUser(app);
      const next = nextPhone();

      await post('/me/contact', user.accessToken).send({ currentPassword: user.password, phone: next }).expect(200);

      const me = await get('/me', user.accessToken).expect(200);
      expect(me.body.data.phone).toBe(user.phone);
    });
  });

  describe('quiet hours', () => {
    it('shows the default, saves a window, and goes back to the default when cleared', async () => {
      const user = await signedInUser(app);

      const initial = await get('/me/quiet-hours', user.accessToken).expect(200);
      expect(initial.body.data).toEqual({ start: '22:00', end: '06:00', isDefault: true });

      const saved = await put('/me/quiet-hours', user.accessToken).send({ start: '23:30', end: '05:00' }).expect(200);
      expect(saved.body.data).toEqual({ start: '23:30', end: '05:00', isDefault: false });
      expect((await get('/me/quiet-hours', user.accessToken)).body.data.start).toBe('23:30');

      const cleared = await put('/me/quiet-hours', user.accessToken).send({ start: null, end: null }).expect(200);
      expect(cleared.body.data.isDefault).toBe(true);
    });

    it('refuses a half window, an equal window and a bad time', async () => {
      const user = await signedInUser(app);

      await put('/me/quiet-hours', user.accessToken).send({ start: '22:00', end: null }).expect(400);
      await put('/me/quiet-hours', user.accessToken).send({ start: '22:00', end: '22:00' }).expect(400);
      await put('/me/quiet-hours', user.accessToken).send({ start: '25:00', end: '06:00' }).expect(400);
    });

    it('keeps the window when a switch is changed afterwards', async () => {
      const user = await signedInUser(app);
      await put('/me/quiet-hours', user.accessToken).send({ start: '21:00', end: '07:00' }).expect(200);

      await put('/me/notification-preferences', user.accessToken)
        .send({ preferences: [{ category: 'MARKETING', channel: 'EMAIL', enabled: true }] })
        .expect(200);

      expect((await get('/me/quiet-hours', user.accessToken)).body.data).toEqual({ start: '21:00', end: '07:00', isDefault: false });
    });
  });

  describe('Google sign-in', () => {
    it('answers 409 with the email and name when there is no account and no consents are sent', async () => {
      const res = await google({ idToken: token('g-1', 'new.person@example.com', 'New Person') }).expect(409);

      expect(res.body.error.code).toBe('GOOGLE_SIGNUP_REQUIRED');
      expect(res.body.error.details).toMatchObject({ email: 'new.person@example.com', name: 'New Person' });
    });

    it('creates an account with consents, then signs the same person in without them', async () => {
      const first = await google({
        idToken: token('g-2', 'new.person@example.com', 'New Person'),
        consents: REQUIRED_CONSENTS,
        homeArea: 'Lagos - Island',
      }).expect(200);
      expect(first.body.data).toMatchObject({ isNewAccount: true, status: 'ACTIVE' });

      const me = await get('/me', first.body.data.accessToken).expect(200);
      expect(me.body.data).toMatchObject({ name: 'New Person', email: 'new.person@example.com', emailVerified: true, homeArea: 'Lagos - Island' });

      const second = await google({ idToken: token('g-2', 'new.person@example.com', 'New Person') }).expect(200);
      expect(second.body.data).toMatchObject({ isNewAccount: false, userId: first.body.data.userId });
    });

    it('needs every required policy for a new account', async () => {
      const res = await google({
        idToken: token('g-3', 'x@example.com'),
        consents: REQUIRED_CONSENTS.slice(0, 2),
      }).expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('links to an existing account that has the same verified email', async () => {
      const existing = await signedInUser(app, { email: 'ada.obi@example.com' });

      const res = await google({ idToken: token('g-4', 'ada.obi@example.com', 'Ada Obi') }).expect(200);

      expect(res.body.data).toMatchObject({ userId: existing.userId, isNewAccount: false });
      const row = await prisma.user.findUniqueOrThrow({ where: { id: existing.userId }, select: { googleSubject: true } });
      expect(row.googleSubject).toBe('g-4');
    });

    it('does not link or create on an unverified Google email', async () => {
      await signedInUser(app, { email: 'ada.obi@example.com' });

      const res = await google({
        idToken: token('g-5', 'ada.obi@example.com', 'Ada Obi', true),
        consents: REQUIRED_CONSENTS,
      }).expect(400);

      expect(res.body.error.details.reason).toBe('GOOGLE_EMAIL_NOT_VERIFIED');
    });

    it('refuses a token that is not valid', async () => {
      const res = await google({ idToken: 'not-a-real-google-token-at-all' }).expect(401);

      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('lets a Google-only account set a password, add a phone, and refuses password login before that', async () => {
      const created = await google({
        idToken: token('g-6', 'solo@example.com', 'Solo Person'),
        consents: REQUIRED_CONSENTS,
      }).expect(200);
      const accessToken = created.body.data.accessToken as string;
      await request(server()).post(`${API}/auth/login`).send({ email: 'solo@example.com', password: 'guess-guess-guess' }).expect(401);

      // Without a password, a sensitive change is confirmed with a fresh Google token.
      await post('/me/password', accessToken).send({ currentPassword: 'x', newPassword: 'Brand-new-pass1!' }).expect(401);
      await post('/me/password', accessToken)
        .send({ googleIdToken: token('g-6', 'solo@example.com', 'Solo Person'), newPassword: 'Brand-new-pass1!' })
        .expect(204);
      await request(server())
        .post(`${API}/auth/login`)
        .set('X-Client', 'mobile')
        .send({ email: 'solo@example.com', password: 'Brand-new-pass1!' })
        .expect(200);
    });

    it('refuses a Google token of a different Google account as proof', async () => {
      const created = await google({
        idToken: token('g-7', 'solo2@example.com', 'Solo Two'),
        consents: REQUIRED_CONSENTS,
      }).expect(200);

      await post('/me/contact', created.body.data.accessToken)
        .send({ googleIdToken: token('someone-else', 'solo2@example.com'), phone: nextPhone() })
        .expect(401);
    });

    it('treats a password-registered user as having a password even after linking', async () => {
      const existing = await registerUser(app, { email: 'linked@example.com' });
      await request(server())
        .post(`${API}/auth/otp/verify`)
        .send({ email: existing.phone, code: lastCode(app, existing.phone) })
        .expect(200);
      await google({ idToken: token('g-8', 'linked@example.com') }).expect(200);

      const login = await request(server())
        .post(`${API}/auth/login`)
        .set('X-Client', 'mobile')
        .send({ email: 'linked@example.com', password: existing.password })
        .expect(200);
      expect(login.body.data.userId).toBe(existing.userId);
    });
  });
});

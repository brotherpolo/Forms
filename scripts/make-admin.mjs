// Promote an existing user to admin.
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node scripts/make-admin.mjs person@example.com
//   node scripts/make-admin.mjs person@example.com --emulator   (uses the local emulators)
//
// The person must have signed in to Formwright once, so their users/{uid} document exists.

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const [email, flag] = process.argv.slice(2);
if (!email) {
  console.error('Usage: node scripts/make-admin.mjs person@example.com [--emulator]');
  process.exit(1);
}

if (flag === '--emulator') {
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
  initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-formwright' });
} else {
  initializeApp({ credential: applicationDefault() });
}

const user = await getAuth().getUserByEmail(email).catch(() => null);
if (!user) {
  console.error(`No account for ${email}. Ask them to sign in to Formwright once, then run this again.`);
  process.exit(1);
}

const ref = getFirestore().doc(`users/${user.uid}`);
const snap = await ref.get();
if (!snap.exists) {
  console.error(`${email} has an auth account but has not opened Formwright yet. Ask them to sign in once.`);
  process.exit(1);
}

await ref.update({ role: 'admin' });
console.log(`${email} (${user.uid}) is now an admin.`);

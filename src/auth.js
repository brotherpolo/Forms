// Sign-in screen: Google, or email and password (sign in, create account, reset password).
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile,
  signOut,
} from 'firebase/auth';
import { auth, configured } from './firebase.js';
import { $, esc } from './ui.js';
import { saveProfileName } from './store.js';

let mode = 'signin'; // signin | signup | reset
let message = null; // {kind: 'err'|'ok', text}
let busy = false;

const ERRORS = {
  'auth/invalid-credential': 'That email and password don’t match an account.',
  'auth/wrong-password': 'That email and password don’t match an account.',
  'auth/user-not-found': 'There is no account with that email.',
  'auth/email-already-in-use': 'An account with that email already exists. Sign in instead.',
  'auth/weak-password': 'Use a password with at least 6 characters.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/popup-closed-by-user': 'The Google window was closed before signing in.',
  'auth/network-request-failed': 'No connection. Check your network and try again.',
  'auth/operation-not-allowed': 'This sign-in method is turned off in the Firebase console.',
};
const errText = (e) => ERRORS[e?.code] || 'Sign-in failed. Try again.';

export function showAuth() {
  $('#app').hidden = true;
  $('#boot').hidden = true;
  const el = $('#auth');
  el.hidden = false;
  render();
}

export function hideAuth() {
  $('#auth').hidden = true;
}

export async function signOutUser() {
  await signOut(auth);
}

function render() {
  const el = $('#auth');
  if (!configured) {
    el.innerHTML = `<div class="auth"><div class="auth-card"><div class="brand"><span class="brand-mark"><i></i></span><b>Formwright</b></div>
      <h1>Firebase is not configured</h1>
      <p class="sub">Copy <code>.env.example</code> to <code>.env.local</code>, fill in your web app settings from the Firebase console, and restart <code>npm run dev</code>.</p></div></div>`;
    return;
  }
  const title = mode === 'signup' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Sign in';
  el.innerHTML = `
  <div class="auth"><div class="auth-card">
    <div class="brand"><span class="brand-mark"><i></i></span><b>Formwright</b></div>
    <h1>${title}</h1>
    ${message ? `<p class="auth-msg ${message.kind}">${esc(message.text)}</p>` : ''}
    ${mode !== 'reset' ? `<button class="btn google" data-auth="google" ${busy ? 'disabled' : ''}><span class="g">G</span>Continue with Google</button><div class="or"><span>or</span></div>` : ''}
    <form id="auth-form" class="auth-form" novalidate>
      ${mode === 'signup' ? `<label class="prop"><span>Your name</span><input class="in" id="au-name" autocomplete="name" required></label>` : ''}
      <label class="prop"><span>Email</span><input class="in" id="au-email" type="email" inputmode="email" autocomplete="email" required></label>
      ${mode !== 'reset' ? `<label class="prop"><span>Password</span><input class="in" id="au-pass" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" minlength="6" required></label>` : ''}
      <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}</button>
    </form>
    <div class="auth-links">
      ${mode === 'signin' ? `<button data-auth="to-signup">Create an account</button><button data-auth="to-reset">Forgot password?</button>` : `<button data-auth="to-signin">Back to sign in</button>`}
    </div>
  </div></div>`;
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-auth]');
  if (!b) return;
  const a = b.dataset.auth;
  if (a.startsWith('to-')) {
    mode = a.slice(3);
    message = null;
    render();
    return;
  }
  if (a === 'google') {
    busy = true;
    message = null;
    render();
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
      message = { kind: 'err', text: errText(err) };
    }
    busy = false;
    if (!$('#auth').hidden) render();
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'auth-form') return;
  e.preventDefault();
  const email = $('#au-email').value.trim();
  const pass = $('#au-pass')?.value || '';
  const name = $('#au-name')?.value.trim() || '';
  busy = true;
  message = null;
  render();
  try {
    if (mode === 'signin') {
      await signInWithEmailAndPassword(auth, email, pass);
    } else if (mode === 'signup') {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      if (name) {
        await updateProfile(cred.user, { displayName: name });
        await saveProfileName(cred.user.uid, name).catch(() => {});
      }
    } else {
      await sendPasswordResetEmail(auth, email);
      message = { kind: 'ok', text: 'If that email has an account, a reset link is on its way.' };
      mode = 'signin';
    }
  } catch (err) {
    message = { kind: 'err', text: errText(err) };
  }
  busy = false;
  if (!$('#auth').hidden) {
    render();
    const em = $('#au-email');
    if (em && email) em.value = email;
  }
});

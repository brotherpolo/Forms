// Entry point: waits for Firebase Auth, sets up the account, then starts the app.
import { onAuthStateChanged } from 'firebase/auth';
import { auth, configured } from './firebase.js';
import { ensureAccount, startData, stopData } from './store.js';
import { showAuth, hideAuth } from './auth.js';
import { startApp, stopApp } from './app.js';
import { $, esc } from './ui.js';

if (!configured) {
  showAuth();
} else {
  onAuthStateChanged(auth, async (user) => {
    stopApp();
    stopData();
    if (!user) {
      showAuth();
      return;
    }
    hideAuth();
    const boot = $('#boot');
    boot.hidden = false;
    boot.textContent = 'Loading your forms…';
    try {
      await ensureAccount(user);
    } catch (e) {
      console.error('[formwright] account setup failed', e);
      boot.innerHTML = `<div class="panel empty"><h2>Your account couldn’t be set up</h2><p>${
        e?.code === 'permission-denied'
          ? 'The database refused the request. Check that firestore.rules has been deployed.'
          : 'Check your connection and reload the page.'
      }</p><p class="help">${esc(e?.code || '')}</p><button class="btn" data-act="sign-out-boot">Sign out</button></div>`;
      return;
    }
    startApp();
    startData(user);
  });
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-act="sign-out-boot"]')) auth.signOut();
});

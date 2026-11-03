// Captures Chrome's install prompt so the app can offer its own "Install" button.

import { emit } from './store.js';
import { requestPersistence } from './db.js';

export const installState = {
  canInstall: false,
  installed: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
};
let deferred = null;

addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferred = e;
  installState.canInstall = true;
  emit('install');
});

addEventListener('appinstalled', () => {
  deferred = null;
  installState.canInstall = false;
  installState.installed = true;
  requestPersistence();
  emit('install');
});

export async function promptInstall() {
  if (!deferred) return false;
  deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  installState.canInstall = false;
  emit('install');
  return outcome === 'accepted';
}

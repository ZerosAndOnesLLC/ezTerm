/** In-app broadcast for vault credential mutations. The credential
 *  manager can rename/delete credentials of any kind while multiple
 *  CredentialPickers are mounted (the session editor shows a private-key
 *  picker and a passphrase picker side by side), so every picker
 *  subscribes and re-syncs its list — including the ones that didn't
 *  open the manager. */
const EVENT = 'ezterm:credentials-changed';

export function emitCredentialsChanged() {
  window.dispatchEvent(new Event(EVENT));
}

/** Returns the unsubscribe function. */
export function onCredentialsChanged(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}

/* ========================================
   Google Photos import (Picker API)

   Google retired the old "read the user's library" scopes, so the only
   supported way for a web app to reach an album now is the Picker API:
   the app opens a Google-hosted picker, the user chooses photos (an
   entire album in a couple of taps), and the app polls until they are
   done. Nothing here can browse the library on its own.

   This page is a static site with no server, so it cannot ship its own
   OAuth credentials - the user pastes a client ID from their own Google
   Cloud project (see README). Everything runs in the browser; photos go
   from Google straight into the tab and are never uploaded anywhere.
   ======================================== */

const GooglePhotos = (() => {
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
  const API = 'https://photospicker.googleapis.com/v1';

  let token = null;
  let tokenExpiresAt = 0;
  let tokenClient = null;
  let tokenClientId = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('Could not load Google sign-in. Check your connection.'));
      document.head.appendChild(el);
    });
  }

  async function getToken(clientId) {
    if (token && Date.now() < tokenExpiresAt - 60000 && tokenClientId === clientId) return token;
    await loadScript(GIS_SRC);
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      throw new Error('Google sign-in is unavailable in this browser.');
    }
    if (!tokenClient || tokenClientId !== clientId) {
      tokenClientId = clientId;
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: () => {},
      });
    }
    return new Promise((resolve, reject) => {
      tokenClient.callback = (res) => {
        if (res.error) {
          reject(new Error(describeAuthError(res)));
          return;
        }
        token = res.access_token;
        tokenExpiresAt = Date.now() + (Number(res.expires_in) || 3600) * 1000;
        resolve(token);
      };
      try {
        tokenClient.requestAccessToken({ prompt: '' });
      } catch (err) {
        reject(err);
      }
    });
  }

  function describeAuthError(res) {
    if (res.error === 'popup_closed_by_user' || res.error === 'popup_failed_to_open') {
      return 'Sign-in window was closed or blocked. Allow pop-ups for this site and try again.';
    }
    if (res.error === 'access_denied') return 'Google denied access for this client ID.';
    return `Google sign-in failed: ${res.error_description || res.error}`;
  }

  async function api(path, options) {
    const res = await fetch(`${API}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options && options.headers) },
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = (body.error && body.error.message) || '';
      } catch { /* non-JSON error body */ }
      if (res.status === 403 && /Picker API has not been used|disabled/i.test(detail)) {
        throw new Error('Enable the "Photos Picker API" in your Google Cloud project, then retry.');
      }
      throw new Error(`Google Photos API ${res.status}: ${detail || res.statusText}`);
    }
    return res.json();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const seconds = (v) => (typeof v === 'string' ? parseFloat(v.replace('s', '')) : NaN);

  /**
   * Run the whole picker flow.
   *
   * @param {object} opts
   * @param {string} opts.clientId
   * @param {(msg: string) => void} opts.onStatus
   * @param {(uri: string) => void} opts.onPickerUri - show the user a link/button;
   *   opening it must come from their tap or the browser blocks it.
   * @param {(done: number, total: number) => void} [opts.onProgress]
   * @param {{aborted: boolean}} [opts.cancel] - flip .aborted to stop
   * @returns {Promise<Array<{name: string, blob: Blob, timeMs: number, source: string}>>}
   */
  async function pick(opts) {
    const { clientId, onStatus = () => {}, onPickerUri = () => {}, onProgress = () => {}, cancel } = opts;
    const stopped = () => cancel && cancel.aborted;

    onStatus('Signing in to Google…');
    await getToken(clientId);
    if (stopped()) return [];

    onStatus('Opening the Google Photos picker…');
    const session = await api('/sessions', { method: 'POST', body: '{}' });
    onPickerUri(session.pickerUri);

    const pollMs = Math.max(1000, (seconds(session.pollingConfig && session.pollingConfig.pollInterval) || 3) * 1000);
    const timeoutMs = Math.max(60000, (seconds(session.pollingConfig && session.pollingConfig.timeoutIn) || 900) * 1000);
    const deadline = Date.now() + timeoutMs;

    onStatus('Waiting for you to choose photos…');
    let ready = session.mediaItemsSet;
    while (!ready) {
      if (stopped()) { await deleteSession(session.id); return []; }
      if (Date.now() > deadline) {
        await deleteSession(session.id);
        throw new Error('Timed out waiting for the Google Photos picker.');
      }
      await sleep(pollMs);
      const latest = await api(`/sessions/${encodeURIComponent(session.id)}`);
      ready = latest.mediaItemsSet;
    }

    onStatus('Reading your selection…');
    const items = [];
    let pageToken = '';
    do {
      const query = `?sessionId=${encodeURIComponent(session.id)}&pageSize=100` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const page = await api(`/mediaItems${query}`);
      for (const item of page.mediaItems || []) {
        if (item.type && item.type !== 'PHOTO') continue; // videos can't be aligned
        items.push(item);
      }
      pageToken = page.nextPageToken || '';
    } while (pageToken && !stopped());

    const photos = [];
    for (let i = 0; i < items.length; i++) {
      if (stopped()) break;
      onProgress(i, items.length);
      onStatus(`Downloading ${i + 1} of ${items.length}…`);
      try {
        photos.push(await download(items[i]));
      } catch (err) {
        // One unreadable photo shouldn't sink the whole album.
        console.warn('Google Photos download failed', err);
      }
    }
    onProgress(items.length, items.length);
    await deleteSession(session.id);

    if (items.length && !photos.length) {
      throw new Error(
        'Google returned the photos but this browser could not download them ' +
        '(the picker blocks cross-origin reads in some browsers). ' +
        'Save the album to your device and use "Choose photos" instead.'
      );
    }
    return photos;
  }

  async function download(item) {
    const file = item.mediaFile || {};
    const base = file.baseUrl || item.baseUrl;
    if (!base) throw new Error('media item has no baseUrl');
    // Ask for a long edge of 2560: plenty for a 1080p timelapse, far less
    // to move than a 48MP original.
    const url = `${base}=w2560-h2560`;
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch {
      res = await fetch(url); // some deployments serve the signed URL directly
    }
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const blob = await res.blob();
    const created = item.createTime || (file.mediaFileMetadata && file.mediaFileMetadata.creationTime);
    return {
      name: file.filename || `${item.id || 'photo'}.jpg`,
      blob,
      timeMs: created ? Date.parse(created) : NaN,
      source: 'google-photos',
    };
  }

  async function deleteSession(id) {
    try {
      await api(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch { /* the session expires on its own anyway */ }
  }

  function signOut() {
    if (token && window.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(token); } catch { /* already gone */ }
    }
    token = null;
    tokenExpiresAt = 0;
  }

  return { pick, signOut, SCOPE };
})();

if (typeof window !== 'undefined') window.GooglePhotos = GooglePhotos;

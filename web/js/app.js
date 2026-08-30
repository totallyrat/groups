/* Bootstrap. Wires the dock, the live feed, deep links and the service worker. */

import { $, el, toast, haptic } from './ui.js';
import { auth } from './api.js';
import {
  state, subscribe, loadMe, loadGroup, connectLive, onServerEvent,
  rememberGroup, lastGroup, flushQueue,
} from './store.js';
import { config, resolveServer } from './config.js';
import { initRouter, show, reset, current } from './router.js';
import { openConnect } from './views/connect.js';
import { initOnboarding, joinGroup } from './views/onboarding.js';
import { renderHome } from './views/home.js';
import { openHangoutSheet } from './views/hangout.js';
import { initCamera, openCamera } from './views/camera.js';
import { initReel, openReel } from './views/reel.js';
import { openArchive } from './views/archive.js';
import { openSettings, openGroupSwitcher, isStandalone, enablePush } from './views/settings.js';

/* --------------------------------------------------------- service worker -- */

async function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    // Relative, because on GitHub Pages the app lives at /<repo>/, not at the root.
    const registration = await navigator.serviceWorker.register('sw.js', { scope: './' });
    // The worker answers hangout notifications on its own and needs to know
    // which server to talk to.
    const tellWorker = () => registration.active?.postMessage(
      { type: 'api-base', value: new URL(config.apiBase || '.', location.href).toString() },
    );
    tellWorker();
    navigator.serviceWorker.ready.then(tellWorker).catch(() => {});
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          worker.postMessage({ type: 'skip-waiting' });
        }
      });
    });
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'navigate') handleDeepLink(new URL(event.data.url, location.origin));
    });
  } catch (err) {
    console.warn('[groups] service worker not registered', err);
  }
}

/* ------------------------------------------------------------- deep links -- */

async function handleDeepLink(url = new URL(location.href)) {
  const params = url.searchParams;
  const join = params.get('join');
  const gid = params.get('g');
  const watch = params.get('watch');
  const hangout = params.get('hangout');

  // Clean the address bar so a refresh does not repeat the action.
  if ([...params.keys()].length) {
    history.replaceState(null, '', location.pathname);
  }

  if (join && state.me) {
    await joinGroup(join);
    return;
  }
  if (join && !state.me) {
    sessionStorage.setItem('groups.pendingJoin', join);
    return;
  }
  if (gid && state.me) {
    if (gid !== state.groupId) {
      rememberGroup(gid);
      await loadGroup(gid).catch(() => {});
    }
    reset('home');
    renderHome();
    if (watch) openReel(gid, watch);
    else if (hangout) toast('Opening the hangout…', '', 1200);
  }
}

/* ----------------------------------------------------------- live updates -- */

let refreshTimer = null;

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await loadGroup().catch(() => {});
    if (current() === 'home') renderHome();
  }, 250);
}

function wireLiveEvents() {
  onServerEvent((event) => {
    if (event.groupId && event.groupId !== state.groupId) {
      // Something happened in another group — surface it, do not steal focus.
      if (event.type === 'hangout') toast('A hangout started in another group');
      return;
    }

    switch (event.type) {
      case 'hangout':
        haptic(12);
        toast('Someone wants to hang 👋', 'good');
        scheduleRefresh();
        break;
      case 'hangout-response':
        if (event.payload?.answer === 'yes') toast('Someone said yes', 'good');
        scheduleRefresh();
        break;
      case 'vault-opened':
        document.body.classList.add('ignited');
        setTimeout(() => document.body.classList.remove('ignited'), 2600);
        toast('Tonight just opened 🌇', 'good', 6000);
        scheduleRefresh();
        break;
      case 'local-upload-done':
        toast('Clip landed in the vault', 'good');
        scheduleRefresh();
        break;
      case 'local-upload-failed':
        toast(event.payload?.message || 'A clip failed to upload', 'warn', 5000);
        break;
      default:
        scheduleRefresh();
    }
  });
}

/* ------------------------------------------------------------ upload bar -- */

function renderUploads() {
  const existing = $('#upload-bar');
  const active = state.uploads;
  if (!active.length) {
    existing?.remove();
    return;
  }
  const progress = active.reduce((sum, u) => sum + (u.progress || 0), 0) / active.length;
  const bar = existing || el('div', { class: 'upload-bar', id: 'upload-bar' }, [
    el('span', {}, ['🎬']),
    el('span', { class: 'label' }, ['Uploading']),
    el('div', { class: 'bar' }, [el('i')]),
  ]);
  if (!existing) document.body.append(bar);
  bar.querySelector('.label').textContent =
    active.length > 1 ? `Uploading ${active.length} clips` : 'Uploading your clip';
  bar.querySelector('.bar i').style.setProperty('--p', `${Math.round(progress * 100)}%`);
}

/* ------------------------------------------------------------------ boot -- */

async function boot() {
  initRouter();

  // Find the server before anything else: without one there is nothing to show.
  await resolveServer();
  if (!config.connected) {
    registerWorker();
    openConnect({ onConnected: () => location.reload() });
    return;
  }

  initOnboarding();
  initCamera();
  initReel();

  $('#btn-hangout').addEventListener('click', openHangoutSheet);
  $('#btn-record').addEventListener('click', openCamera);
  $('#go-settings').addEventListener('click', openSettings);
  $('#go-archive').addEventListener('click', openArchive);
  $('#group-switch').addEventListener('click', openGroupSwitcher);
  $('#scrim').addEventListener('click', () => import('./ui.js').then((m) => m.closeSheet()));

  // One subscription drives the home view: anything that changes state — a
  // hangout answer, a new clip, a live event — repaints it. Upload progress
  // bumps `uploads` many times a second without touching `homeVersion`, so it
  // only ever redraws the little progress bar.
  let paintedVersion = -1;
  subscribe(() => {
    renderUploads();
    if (current() === 'home' && state.home && state.homeVersion !== paintedVersion) {
      paintedVersion = state.homeVersion;
      renderHome();
    }
  });
  wireLiveEvents();
  registerWorker();

  if (!auth.token) {
    reset('welcome');
    await handleDeepLink();
    return;
  }

  try {
    const me = await loadMe();
    const pendingJoin = sessionStorage.getItem('groups.pendingJoin');
    if (pendingJoin) {
      sessionStorage.removeItem('groups.pendingJoin');
      await joinGroup(pendingJoin);
    }

    const target = new URL(location.href).searchParams.get('g')
      || lastGroup()
      || me.groups[0]?.id;

    if (!target) {
      reset('setup');
    } else {
      await loadGroup(target).catch(async () => {
        // The remembered group is gone — fall back to any other.
        const fallback = me.groups[0]?.id;
        if (fallback) await loadGroup(fallback);
      });
      if (state.home) {
        reset('home');
        renderHome();
      } else {
        reset('setup');
      }
    }

    connectLive();
    flushQueue();
    await handleDeepLink();

    // Once installed, ask for notifications — they are the point of the app.
    if (isStandalone() && state.push?.enabled && Notification?.permission === 'default') {
      setTimeout(() => {
        if (current() === 'home') {
          toast('Turn on notifications in Settings to hear about hangouts', '', 5000);
        }
      }, 4000);
    } else if (isStandalone() && Notification?.permission === 'granted') {
      enablePush({ quiet: true });
    }
  } catch (err) {
    if (err.status === 401) {
      auth.token = null;
      reset('welcome');
    } else {
      toast(err.message || 'Could not reach the server', 'warn');
      reset(state.me ? 'home' : 'welcome');
    }
  }
}

/* Refresh when the app comes back to the foreground — phones sleep a lot. */
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.groupId) return;
  connectLive();
  flushQueue();
  loadGroup().then(() => { if (current() === 'home') renderHome(); }).catch(() => {});
});

// Block the rubber-band scroll that makes a PWA feel like a web page.
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

document.addEventListener('gesturestart', (e) => e.preventDefault());

boot();

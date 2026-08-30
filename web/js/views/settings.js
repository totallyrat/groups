/* Settings, invites, group switching, notifications, and the install coach. */

import {
  $, el, frag, clear, openSheet, closeSheet, confirmSheet, toast, toastBusy,
  avatar, haptic, icon, ICONS,
} from '../ui.js';
import { api, auth } from '../api.js';
import { config } from '../config.js';
import { state, loadMe, loadGroup, rememberGroup, patch } from '../store.js';
import { show, reset } from '../router.js';

const EMOJI = ['🙂', '😎', '🦊', '🐢', '🐙', '🐳', '🦉', '🐝', '🌵', '🍄', '🌙', '⭐️',
  '🔥', '🌈', '🍒', '🍕', '🎧', '🎸', '🛹', '⚡️', '👾', '🤖', '👻', '🦄'];

export const isStandalone = () =>
  window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;

export const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* --------------------------------------------------------------- screen -- */

export function openSettings() {
  show('settings');
  renderSettings();
}

export function renderSettings() {
  const body = clear($('#settings-body'));
  const me = state.me;
  const group = state.home?.group;
  if (!me) return;

  /* profile */
  body.append(el('div', { class: 'card row gap-4' }, [
    el('button', {
      class: 'row',
      style: { padding: 0 },
      onclick: openProfileSheet,
    }, [avatar(me)]),
    el('div', { class: 'grow' }, [
      el('div', { style: { fontSize: '19px', fontWeight: 700, letterSpacing: '-.02em' } }, [me.name]),
      el('div', { class: 't-meta t-dim' }, ['Tap to change your look']),
    ]),
    el('button', { class: 'chip', onclick: openProfileSheet }, ['Edit']),
  ]));

  /* the install coach — the whole point of the app on iPhone */
  if (!isStandalone()) body.append(installCard());

  /* notifications */
  body.append(el('div', { class: 'stack gap-3' }, [
    el('h3', { class: 't-section' }, ['Notifications']),
    notificationsCard(),
  ]));

  /* group */
  if (group) {
    body.append(el('div', { class: 'stack gap-3' }, [
      el('h3', { class: 't-section' }, [group.name]),
      el('div', { class: 'list' }, [
        row('Invite friends', `Code ${group.inviteCode}`, () => openInviteSheet(group)),
        row('Members', `${group.members.length} in the group`, () => openMembersSheet(group)),
        row('Memories open at', `${String(group.unlockHour).padStart(2, '0')}:00 · ${group.tz}`,
          group.role === 'owner' ? () => openGroupSheet(group) : null),
        row('Switch group', `${state.groups.length} joined`, openGroupSwitcher),
      ]),
    ]));
  }

  /* account */
  body.append(el('div', { class: 'stack gap-3' }, [
    el('h3', { class: 't-section' }, ['Account']),
    el('div', { class: 'list' }, [
      row('Recovery phrase', 'Move your account to a new phone', openRecoverySheet),
      row('Sign out', 'Keeps your memories on the server', signOut),
      group ? row('Leave group', 'Your clips stay behind', () => leaveGroup(group)) : null,
    ]),
  ]));

  body.append(el('p', {
    class: 't-meta t-dim',
    style: { textAlign: 'center', padding: 'var(--s5) 0 var(--s7)' },
  }, ['Groups · your people, every day']));
}

function row(title, sub, onclick) {
  return el(onclick ? 'button' : 'div', {
    class: 'list-item',
    ...(onclick ? { onclick } : {}),
  }, [
    el('div', { class: 'grow' }, [
      el('div', { class: 'li-title' }, [title]),
      el('div', { class: 'li-sub' }, [sub]),
    ]),
    onclick ? el('span', { class: 't-dim' }, ['›']) : null,
  ]);
}

/* -------------------------------------------------------------- install -- */

function installCard() {
  if (isIos()) {
    return el('div', { class: 'card stack gap-3' }, [
      el('div', { class: 'row gap-3' }, [
        el('span', { style: { fontSize: '26px' } }, ['📲']),
        el('div', { class: 'grow' }, [
          el('div', { style: { fontWeight: 700 } }, ['Add Groups to your Home Screen']),
          el('div', { class: 't-meta' }, ['It becomes a real app — and it is the only way iPhone will send you notifications.']),
        ]),
      ]),
      el('ol', { class: 't-meta', style: { paddingLeft: '18px', listStyle: 'decimal', lineHeight: '1.9' } }, [
        el('li', {}, ['Tap the Share button in Safari']),
        el('li', {}, ['Choose “Add to Home Screen”']),
        el('li', {}, ['Open Groups from your Home Screen']),
      ]),
    ]);
  }
  return el('div', { class: 'card row gap-3' }, [
    el('span', { style: { fontSize: '26px' } }, ['📲']),
    el('div', { class: 'grow' }, [
      el('div', { style: { fontWeight: 700 } }, ['Install Groups']),
      el('div', { class: 't-meta' }, ['Use your browser menu › Install app.']),
    ]),
  ]);
}

/* -------------------------------------------------------- notifications -- */

function notificationsCard() {
  const supported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  const granted = supported && Notification.permission === 'granted';
  const blocked = supported && Notification.permission === 'denied';

  if (!supported || (isIos() && !isStandalone())) {
    return el('div', { class: 'list' }, [
      el('div', { class: 'list-item' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'li-title' }, ['Push notifications']),
          el('div', { class: 'li-sub' }, [
            isIos()
              ? 'Add Groups to your Home Screen first — iPhone only allows push from installed apps.'
              : 'This browser cannot do push.',
          ]),
        ]),
      ]),
    ]);
  }

  const toggle = el('button', {
    class: 'list-item',
    onclick: async () => {
      if (granted) {
        toast('Turn them off in your phone settings');
        return;
      }
      if (blocked) {
        toast('Notifications are blocked in your phone settings', 'warn');
        return;
      }
      await enablePush();
      renderSettings();
    },
  }, [
    el('div', { class: 'grow' }, [
      el('div', { class: 'li-title' }, ['Hangouts and the 20:00 drop']),
      el('div', { class: 'li-sub' }, [
        granted ? 'On — you will hear about both.' : 'Off — tap to turn on.',
      ]),
    ]),
    el('span', { class: 'switch', 'aria-checked': String(granted) }),
  ]);

  const list = el('div', { class: 'list' }, [toggle]);
  if (granted) {
    list.append(row('Send a test', 'Check it reaches your lock screen', async () => {
      const busy = toastBusy('Sending…');
      try {
        const res = await api.testPush();
        busy.done(res.subs ? 'Sent — watch your lock screen' : 'No device registered', res.subs ? 'good' : 'warn');
      } catch (err) {
        busy.done(err.message || 'Failed', 'warn');
      }
    }));
  }
  return list;
}

const urlB64ToBytes = (base64) => {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};

export async function enablePush({ quiet = false } = {}) {
  try {
    if (!state.push?.publicKey) {
      if (!quiet) toast('Push is not configured on this server', 'warn');
      return false;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      if (!quiet) toast('No notifications then', 'warn');
      return false;
    }
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToBytes(state.push.publicKey),
    });
    await api.subscribePush(subscription.toJSON());
    if (!quiet) toast('Notifications on', 'good');
    return true;
  } catch (err) {
    if (!quiet) toast(err.message || 'Could not turn on notifications', 'warn');
    return false;
  }
}

/* --------------------------------------------------------------- sheets -- */

function openProfileSheet() {
  let emoji = state.me.emoji;
  const name = el('input', { class: 'field', value: state.me.name, maxlength: '24', enterkeyhint: 'done' });
  const grid = el('div', { class: 'emoji-picker' },
    EMOJI.map((e) => el('button', {
      'aria-pressed': e === emoji,
      onclick: (ev) => {
        emoji = e;
        haptic();
        [...grid.children].forEach((c) => c.setAttribute('aria-pressed', 'false'));
        ev.currentTarget.setAttribute('aria-pressed', 'true');
      },
    }, [e])));

  openSheet(frag([
    el('h3', { class: 't-title' }, ['You']),
    el('div', { class: 'stack gap-4', style: { marginTop: 'var(--s4)' } }, [
      name,
      grid,
      el('button', {
        class: 'btn btn-primary btn-block',
        onclick: async () => {
          await api.updateMe({ name: name.value.trim() || state.me.name, emoji });
          await loadMe();
          await loadGroup();
          closeSheet();
          renderSettings();
          toast('Updated', 'good');
        },
      }, ['Save']),
    ]),
  ]));
}

export function openInviteSheet(group) {
  // The link carries the server as well as the code, so a friend opening it
  // from a static host (GitHub Pages) never has to know an address exists.
  const url = new URL('.', location.href);
  url.searchParams.set('join', group.inviteCode);
  if (!config.local) url.searchParams.set('s', config.apiBase);
  const link = url.toString();
  const codeBox = el('div', { class: 'code-box' }, [group.inviteCode]);

  openSheet(frag([
    el('h3', { class: 't-title' }, ['Bring the others in']),
    el('p', { class: 't-meta', style: { marginTop: '2px' } }, [
      'Send the link, or read out the code.',
    ]),
    el('div', { style: { margin: 'var(--s5) 0' } }, [codeBox]),
    el('div', { class: 'stack gap-2' }, [
      el('button', {
        class: 'btn btn-primary btn-block',
        onclick: async () => {
          const payload = {
            title: `Join ${group.name} on Groups`,
            text: `Join ${group.name} on Groups — code ${group.inviteCode}`,
            url: link,
          };
          try {
            if (navigator.share) await navigator.share(payload);
            else throw new Error('no share');
          } catch {
            await copy(link);
          }
        },
      }, ['Share invite link']),
      el('button', {
        class: 'btn btn-ghost btn-block',
        onclick: () => copy(group.inviteCode),
      }, ['Copy the code']),
    ]),
  ]));
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied', 'good');
  } catch {
    const field = el('input', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(field);
    field.select();
    document.execCommand?.('copy');
    field.remove();
    toast('Copied', 'good');
  }
}

function openMembersSheet(group) {
  openSheet(frag([
    el('h3', { class: 't-title' }, [`${group.members.length} in ${group.name}`]),
    el('div', { class: 'list', style: { marginTop: 'var(--s4)' } },
      group.members.map((m) => el('div', { class: 'list-item' }, [
        avatar(m, 'sm'),
        el('div', { class: 'grow' }, [
          el('div', { class: 'li-title' }, [m.id === state.me?.id ? `${m.name} (you)` : m.name]),
          el('div', { class: 'li-sub' }, [m.role === 'owner' ? 'Owner' : 'Member']),
        ]),
      ]))),
    el('button', {
      class: 'btn btn-primary btn-block',
      style: { marginTop: 'var(--s4)' },
      onclick: () => { closeSheet(); openInviteSheet(group); },
    }, ['Invite someone']),
  ]));
}

function openGroupSheet(group) {
  const name = el('input', { class: 'field', value: group.name, maxlength: '40' });
  let hour = group.unlockHour;
  const hours = el('div', { class: 'row gap-2 wrap' },
    [18, 19, 20, 21, 22].map((h) => el('button', {
      class: 'chip',
      'aria-pressed': h === hour,
      onclick: (e) => {
        hour = h;
        [...hours.children].forEach((c) => c.setAttribute('aria-pressed', 'false'));
        e.currentTarget.setAttribute('aria-pressed', 'true');
      },
    }, [`${h}:00`])));

  openSheet(frag([
    el('h3', { class: 't-title' }, ['Group settings']),
    el('div', { class: 'stack gap-4', style: { marginTop: 'var(--s4)' } }, [
      name,
      el('div', {}, [
        el('h4', { class: 't-section', style: { marginBottom: 'var(--s2)' } }, ['Memories open at']),
        hours,
        el('p', { class: 't-meta t-dim', style: { marginTop: 'var(--s2)' } }, [
          `In ${group.tz}. Clips filmed after the drop go into the next day.`,
        ]),
      ]),
      el('button', {
        class: 'btn btn-primary btn-block',
        onclick: async () => {
          await api.updateGroup(group.id, { name: name.value.trim() || group.name, unlockHour: hour });
          await loadGroup();
          closeSheet();
          renderSettings();
          toast('Saved', 'good');
        },
      }, ['Save']),
    ]),
  ]));
}

export function openGroupSwitcher() {
  const list = el('div', { class: 'list' },
    state.groups.map((g) => el('button', {
      class: 'list-item',
      onclick: async () => {
        closeSheet();
        rememberGroup(g.id);
        await loadGroup(g.id);
        const { renderHome } = await import('./home.js');
        show('home');
        renderHome();
      },
    }, [
      el('span', { class: 'ge', style: { width: '36px', height: '36px', borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--dusk)' } }, [g.emoji]),
      el('div', { class: 'grow' }, [
        el('div', { class: 'li-title' }, [g.name]),
        el('div', { class: 'li-sub' }, [`${g.members} member${g.members === 1 ? '' : 's'}`]),
      ]),
      g.id === state.groupId ? el('span', { style: { color: 'var(--aurora)' } }, [icon(ICONS.check, 18)]) : null,
    ])));

  openSheet(frag([
    el('h3', { class: 't-title' }, ['Your groups']),
    el('div', { style: { marginTop: 'var(--s4)' } }, [list]),
    el('button', {
      class: 'btn btn-ghost btn-block',
      style: { marginTop: 'var(--s4)' },
      onclick: () => { closeSheet(); show('setup'); },
    }, ['New group or join one']),
  ]));
}

function openRecoverySheet() {
  const stored = (() => {
    try { return localStorage.getItem('groups.recovery'); } catch { return null; }
  })();

  openSheet(frag([
    el('h3', { class: 't-title' }, ['Recovery phrase']),
    el('p', { class: 't-meta', style: { marginTop: '2px' } }, [
      'Six words that are your account. Write them down — they are the only way back in on a new phone.',
    ]),
    el('div', { class: 'phrase-box', style: { margin: 'var(--s5) 0' } }, [
      stored ? stored.replace(/-/g, ' ') : 'Only shown once, when you signed up.',
    ]),
    stored
      ? el('button', { class: 'btn btn-ghost btn-block', onclick: () => copy(stored) }, ['Copy'])
      : null,
  ]));
}

async function signOut() {
  if (!await confirmSheet({
    title: 'Sign out?',
    body: 'You will need your recovery phrase to get back in.',
    confirm: 'Sign out',
    danger: true,
  })) return;
  auth.token = null;
  try { localStorage.removeItem('groups.lastGroup'); } catch { /* ignore */ }
  patch({ me: null, groups: [], home: null, groupId: null });
  reset('welcome');
}

async function leaveGroup(group) {
  if (!await confirmSheet({
    title: `Leave ${group.name}?`,
    body: 'Your clips stay in the group memories. You can rejoin with the code.',
    confirm: 'Leave',
    danger: true,
  })) return;
  await api.leaveGroup(group.id);
  await loadMe();
  const next = state.groups[0];
  if (next) {
    rememberGroup(next.id);
    await loadGroup(next.id);
    const { renderHome } = await import('./home.js');
    reset('home');
    renderHome();
  } else {
    patch({ home: null, groupId: null });
    reset('setup');
  }
}

/* First run: pick a name, then start a group or join one with a code. */

import { $, el, frag, clear, openSheet, closeSheet, toast, haptic } from '../ui.js';
import { api, auth } from '../api.js';
import { state, loadMe, loadGroup, rememberGroup, patch } from '../store.js';
import { show, reset } from '../router.js';

const EMOJI = ['🙂', '😎', '🦊', '🐢', '🐙', '🐳', '🦉', '🐝', '🌵', '🍄', '🌙', '⭐️',
  '🔥', '🌈', '🍒', '🍕', '🎧', '🎸', '🛹', '⚡️', '👾', '🤖', '👻', '🦄'];

const GROUP_EMOJI = ['✨', '🌇', '🏠', '🍕', '🎬', '🏀', '🌊', '🔥', '🎧', '🛹', '🌵', '🧃'];

let chosenEmoji = EMOJI[Math.floor(Math.random() * EMOJI.length)];
let groupEmoji = '✨';

export function initOnboarding() {
  const picker = clear($('#welcome-emoji'));
  for (const emoji of EMOJI.slice(0, 16)) {
    picker.append(el('button', {
      'aria-pressed': emoji === chosenEmoji,
      onclick: (e) => {
        chosenEmoji = emoji;
        haptic();
        [...picker.children].forEach((c) => c.setAttribute('aria-pressed', 'false'));
        e.currentTarget.setAttribute('aria-pressed', 'true');
      },
    }, [emoji]));
  }

  $('#welcome-go').addEventListener('click', createAccount);
  $('#welcome-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createAccount();
  });
  $('#welcome-restore').addEventListener('click', openRestoreSheet);

  $('#group-emoji-btn').textContent = groupEmoji;
  $('#group-emoji-btn').addEventListener('click', pickGroupEmoji);
  $('#group-create').addEventListener('click', createGroup);
  $('#group-join').addEventListener('click', () => joinGroup($('#join-code').value));
  $('#join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  $('#group-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createGroup();
  });
}

async function createAccount() {
  const button = $('#welcome-go');
  const name = $('#welcome-name').value.trim();
  if (!name) {
    $('#welcome-name').focus();
    return toast('Your friends need to know who you are');
  }
  button.disabled = true;
  button.replaceChildren(el('span', { class: 'spinner' }), document.createTextNode('One sec…'));
  try {
    const hue = Math.floor(Math.random() * 360);
    const res = await api.register(name, chosenEmoji, hue);
    auth.token = res.token;
    try { localStorage.setItem('groups.recovery', res.recoveryPhrase); } catch { /* ignore */ }
    await loadMe();
    showRecoveryPhrase(res.recoveryPhrase);
  } catch (err) {
    toast(err.message || 'Could not sign you up', 'warn');
    button.disabled = false;
    button.textContent = 'Get started';
  }
}

/**
 * Someone who arrived on an invite link should land straight in the group,
 * not on the "create or join" screen with a code they no longer have.
 */
async function afterSignUp() {
  let pending = null;
  try {
    pending = sessionStorage.getItem('groups.pendingJoin');
    sessionStorage.removeItem('groups.pendingJoin');
  } catch { /* private mode */ }

  if (pending) {
    await joinGroup(pending);
    if (state.groupId) return;
  }
  reset('setup');
}

function showRecoveryPhrase(phrase) {
  let moved = false;
  const go = () => {
    if (moved) return;
    moved = true;
    afterSignUp();
  };
  openSheet(frag([
    el('h3', { class: 't-title' }, [`Hey ${state.me.name} ${state.me.emoji}`]),
    el('p', { class: 't-meta', style: { marginTop: '2px' } }, [
      'These six words are your account. Screenshot them — they are how you get back in on a new phone.',
    ]),
    el('div', { class: 'phrase-box', style: { margin: 'var(--s5) 0' } }, [phrase.replace(/-/g, ' ')]),
    el('button', {
      class: 'btn btn-primary btn-block',
      onclick: () => { closeSheet(); go(); },
    }, ['Got it']),
  ]), { onClose: go });
}

function openRestoreSheet() {
  const field = el('input', {
    class: 'field',
    placeholder: 'six words from your old phone',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
    style: { textAlign: 'center' },
  });
  const go = el('button', { class: 'btn btn-primary btn-block' }, ['Restore']);

  const submit = async () => {
    const phrase = field.value.trim();
    if (!phrase) return;
    go.disabled = true;
    go.replaceChildren(el('span', { class: 'spinner' }));
    try {
      const res = await api.restore(phrase);
      auth.token = res.token;
      try { localStorage.setItem('groups.recovery', phrase.toLowerCase().replace(/\s+/g, '-')); }
      catch { /* ignore */ }
      const me = await loadMe();
      closeSheet();
      const first = me.groups[0];
      if (first) {
        rememberGroup(first.id);
        await loadGroup(first.id);
        const { renderHome } = await import('./home.js');
        reset('home');
        renderHome();
      } else {
        reset('setup');
      }
      toast(`Welcome back, ${me.user.name}`, 'good');
    } catch (err) {
      go.disabled = false;
      go.textContent = 'Restore';
      toast(err.message || 'That phrase did not match', 'warn');
    }
  };

  go.addEventListener('click', submit);
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  openSheet(frag([
    el('h3', { class: 't-title' }, ['Welcome back']),
    el('p', { class: 't-meta', style: { marginTop: '2px' } }, ['Enter your recovery phrase.']),
    el('div', { class: 'stack gap-3', style: { marginTop: 'var(--s4)' } }, [field, go]),
  ]));
}

function pickGroupEmoji() {
  const grid = el('div', { class: 'emoji-picker' },
    GROUP_EMOJI.map((e) => el('button', {
      'aria-pressed': e === groupEmoji,
      onclick: () => {
        groupEmoji = e;
        $('#group-emoji-btn').textContent = e;
        closeSheet();
      },
    }, [e])));
  openSheet(frag([el('h3', { class: 't-title' }, ['Pick an emoji']), el('div', { style: { marginTop: 'var(--s4)' } }, [grid])]));
}

async function createGroup() {
  const name = $('#group-name').value.trim();
  if (!name) {
    $('#group-name').focus();
    return toast('Give the group a name');
  }
  const button = $('#group-create');
  button.disabled = true;
  button.replaceChildren(el('span', { class: 'spinner' }));
  try {
    const { group } = await api.createGroup(name, groupEmoji);
    await loadMe();
    rememberGroup(group.id);
    await loadGroup(group.id);
    const { renderHome } = await import('./home.js');
    reset('home');
    renderHome();
    haptic([10, 40, 10]);
    const { openInviteSheet } = await import('./settings.js');
    openInviteSheet(group);
  } catch (err) {
    toast(err.message || 'Could not create the group', 'warn');
  } finally {
    button.disabled = false;
    button.textContent = 'Create group';
  }
}

export async function joinGroup(rawCode) {
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 4) return toast('That code looks short');
  const button = $('#group-join');
  if (button) button.disabled = true;
  try {
    const { group } = await api.joinGroup(code);
    await loadMe();
    rememberGroup(group.id);
    await loadGroup(group.id);
    const { renderHome } = await import('./home.js');
    reset('home');
    renderHome();
    haptic([10, 40, 10]);
    toast(`You're in ${group.name}`, 'good');
  } catch (err) {
    toast(err.message || 'Could not join', 'warn');
  } finally {
    if (button) button.disabled = false;
  }
}

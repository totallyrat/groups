/* The Hangout button: ask the group, and trade a yes for a location. */

import { el, frag, openSheet, closeSheet, toast, toastBusy, haptic, icon, ICONS } from '../ui.js';
import { api } from '../api.js';
import { state, loadGroup } from '../store.js';

const VIBES = [
  { key: 'hang', label: 'Just hang', emoji: '🛋️' },
  { key: 'food', label: 'Food', emoji: '🍜' },
  { key: 'walk', label: 'Walk', emoji: '🚶' },
  { key: 'drink', label: 'Drinks', emoji: '🍹' },
  { key: 'move', label: 'Move', emoji: '🏀' },
  { key: 'game', label: 'Game', emoji: '🎮' },
  { key: 'study', label: 'Study', emoji: '📚' },
  { key: 'out', label: 'Go out', emoji: '🌃' },
];

/** Ask for a fix, but never block the flow on it. */
export function getLocation({ timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    setTimeout(() => finish(null), timeout + 500);
    navigator.geolocation.getCurrentPosition(
      (pos) => finish({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
      () => finish(null),
      { enableHighAccuracy: true, timeout, maximumAge: 60_000 },
    );
  });
}

export function openHangoutSheet() {
  if (!state.groupId) return toast('Join a group first');

  let vibe = 'hang';
  let hours = 3;
  let shareLocation = true;

  const grid = el('div', { class: 'vibe-grid' },
    VIBES.map((v) => el('button', {
      class: 'vibe',
      'aria-pressed': v.key === vibe,
      onclick: (e) => {
        vibe = v.key;
        haptic();
        [...grid.children].forEach((c) => c.setAttribute('aria-pressed', 'false'));
        e.currentTarget.setAttribute('aria-pressed', 'true');
      },
    }, [el('b', {}, [v.emoji]), v.label])));

  const note = el('input', {
    class: 'field',
    placeholder: 'Add a line (optional)',
    maxlength: '140',
    enterkeyhint: 'send',
  });

  const windowChips = el('div', { class: 'row gap-2 wrap' },
    [1, 3, 6, 12].map((h) => el('button', {
      class: 'chip',
      'aria-pressed': h === hours,
      onclick: (e) => {
        hours = h;
        [...windowChips.children].forEach((c) => c.setAttribute('aria-pressed', 'false'));
        e.currentTarget.setAttribute('aria-pressed', 'true');
      },
    }, [h === 12 ? 'All day' : `${h}h`])));

  const locToggle = el('button', {
    class: 'list-item',
    'aria-pressed': 'true',
    onclick: (e) => {
      shareLocation = !shareLocation;
      e.currentTarget.querySelector('.switch').setAttribute('aria-checked', String(shareLocation));
    },
    style: { borderBottom: '0' },
  }, [
    el('span', { class: 'map-dot', style: { width: '38px', height: '38px' } }, [icon(ICONS.location, 18)]),
    el('div', { class: 'grow' }, [
      el('div', { class: 'li-title' }, ['Share where I am']),
      el('div', { class: 'li-sub' }, ['Only people who say yes will see it']),
    ]),
    el('span', { class: 'switch', 'aria-checked': 'true' }),
  ]);

  const send = el('button', { class: 'btn btn-primary btn-block' }, ['Send it']);
  send.addEventListener('click', async () => {
    send.disabled = true;
    send.replaceChildren(el('span', { class: 'spinner' }), document.createTextNode('Sending…'));
    const position = shareLocation ? await getLocation() : null;
    try {
      await api.startHangout(state.groupId, {
        vibe,
        note: note.value.trim(),
        hours,
        ...(position || {}),
      });
      haptic([10, 40, 10]);
      closeSheet();
      toast(
        position ? 'Sent. Everyone just got a nudge.' : 'Sent — without your location.',
        'good',
      );
      await loadGroup();
    } catch (err) {
      send.disabled = false;
      send.textContent = 'Send it';
      toast(err.message || 'Could not send', 'warn');
    }
  });

  openSheet(frag([
    el('h3', { class: 't-title' }, ['Who wants to hang?']),
    el('p', { class: 't-meta', style: { marginTop: '2px' } }, [
      `Nudges everyone in ${state.home?.group?.name || 'your group'}.`,
    ]),
    grid,
    note,
    el('h4', { class: 't-section', style: { margin: 'var(--s5) 0 var(--s2)' } }, ['Stays live for']),
    windowChips,
    el('div', { style: { margin: 'var(--s4) calc(-1 * var(--s3))' } }, [locToggle]),
    send,
  ]));
}

/** Answer someone's ping. A yes trades your location for theirs. */
export async function respondToHangout(hangout, answer, button) {
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.replaceChildren(el('span', { class: 'spinner' }));
  }
  try {
    const position = answer === 'yes' ? await getLocation({ timeout: 6000 }) : null;
    const { hangout: updated } = await api.respond(hangout.id, { answer, ...(position || {}) });
    haptic(answer === 'yes' ? [10, 40, 10] : 8);
    await loadGroup();
    if (answer === 'yes') {
      toast(
        updated.location
          ? `You're in — ${updated.host.name} just got pinged`
          : `You're in!`,
        'good',
      );
    }
  } catch (err) {
    toast(err.message || 'Could not answer', 'warn');
    if (button) {
      button.disabled = false;
      button.textContent = original || 'Retry';
    }
  }
}

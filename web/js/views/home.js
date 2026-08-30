/* The group hub: who's around, live hangout pings, and tonight's vault. */

import { $, el, clear, avatar, toast, fmtCountdown, fmtDay, fmtClock, timeAgo, icon, ICONS, haptic }
  from '../ui.js';
import { api } from '../api.js';
import { state, loadGroup } from '../store.js';
import { mediaUrl } from '../config.js';
import { openHangoutSheet, respondToHangout } from './hangout.js';
import { openReel } from './reel.js';

const ONLINE_WINDOW = 4 * 60_000;

let countdownTimer = null;

export function renderHome() {
  const home = state.home;
  if (!home) return;

  $('#group-emoji').textContent = home.group.emoji;
  $('#group-name-label').textContent = home.group.name;

  renderMembers(home);
  renderPings(home);
  renderVault(home);
  renderRecent(home);
  paintSky(home);
  startCountdown();
}

/* --------------------------------------------------------------- members -- */

function renderMembers(home) {
  const row = clear($('#members-row'));
  const posted = new Set((home.vault.contributors || []).map((c) => c.id));
  const now = Date.now();

  for (const member of home.group.members) {
    const av = avatar(member);
    if (now - member.lastSeen < ONLINE_WINDOW) av.classList.add('online');
    if (posted.has(member.id)) av.classList.add('posted');
    row.append(el('div', { class: 'member' }, [
      av,
      el('span', { class: 'nm' }, [member.id === state.me?.id ? 'You' : member.name.split(' ')[0]]),
    ]));
  }

  row.append(el('button', {
    class: 'member add',
    onclick: () => import('./settings.js').then((m) => m.openInviteSheet(home.group)),
  }, [
    el('span', { class: 'avatar' }, ['+']),
    el('span', { class: 'nm' }, ['Invite']),
  ]));
}

/* -------------------------------------------------------------- hangouts -- */

function renderPings(home) {
  const host = clear($('#home-pings'));
  const live = home.hangouts.filter((h) => h.live);
  if (!live.length) return;

  for (const hangout of live) host.append(pingCard(hangout));
}

function pingCard(hangout) {
  const mine = hangout.myAnswer === 'host';
  const yes = hangout.responses.filter((r) => r.answer === 'yes');

  const card = el('article', { class: `ping ${mine ? 'mine' : ''}`.trim() }, [
    el('div', { class: 'row gap-3' }, [
      el('span', { class: 'ping-vibe' }, [hangout.vibeEmoji]),
      el('div', { class: 'grow' }, [
        el('div', { class: 'ping-title' }, [
          mine ? `You asked to hang` : `${hangout.host.name} wants to hang`,
        ]),
        el('div', { class: 'ping-note' }, [
          hangout.note || `${hangout.vibeLabel} · until ${fmtClock(hangout.expiresAt)}`,
        ]),
      ]),
      el('span', { class: 'pill-live' }, ['live']),
    ]),
  ]);

  if (!mine && !hangout.myAnswer) {
    card.append(el('div', { class: 'answers' }, [
      el('button', {
        class: 'btn btn-primary',
        onclick: (e) => { haptic(12); respondToHangout(hangout, 'yes', e.currentTarget); },
      }, ["I'm in"]),
      el('button', {
        class: 'btn btn-ghost',
        onclick: () => respondToHangout(hangout, 'no'),
      }, ["Can't"]),
    ]));
  }

  if (hangout.myAnswer === 'yes' || mine) {
    if (yes.length) {
      card.append(el('div', { class: 'yes-row' }, [
        ...yes.slice(0, 6).map((r) => avatar(r.user, 'xs')),
        el('span', { class: 't-meta' }, [
          `${yes.map((r) => r.user.name.split(' ')[0]).join(', ')} ${yes.length === 1 ? 'is' : 'are'} in`,
        ]),
      ]));
    } else if (mine) {
      card.append(el('div', { class: 'yes-row' }, [
        el('span', { class: 't-meta t-dim' }, ['Waiting for someone to say yes…']),
      ]));
    }
  }

  // The payoff: once you are in, you get where they are.
  if (hangout.location) {
    card.append(locationCard(hangout));
  } else if (hangout.hasLocation && !mine && hangout.myAnswer !== 'yes') {
    card.append(el('div', { class: 't-meta t-dim row gap-2', style: { marginTop: 'var(--s3)' } }, [
      icon(ICONS.lock, 15), 'Say yes to see where they are',
    ]));
  }

  if (mine) {
    card.append(el('button', {
      class: 'btn btn-quiet btn-block',
      style: { marginTop: 'var(--s2)', minHeight: '40px' },
      onclick: async () => {
        await api.closeHangout(hangout.id);
        toast('Hangout ended');
        loadGroup();
      },
    }, ['End hangout']));
  }

  if (hangout.myAnswer === 'no') {
    card.append(el('button', {
      class: 'btn btn-quiet btn-block',
      style: { marginTop: 'var(--s2)', minHeight: '40px' },
      onclick: (e) => respondToHangout(hangout, 'yes', e.currentTarget),
    }, ['Actually, I’m in']));
  }

  return card;
}

function locationCard(hangout) {
  const { lat, lng } = hangout.location;
  const maps = `https://maps.apple.com/?ll=${lat},${lng}&q=${encodeURIComponent(hangout.host.name)}`;
  return el('a', {
    class: 'map-card',
    href: maps,
    target: '_blank',
    rel: 'noopener',
  }, [
    el('div', { class: 'm-body' }, [
      el('span', { class: 'map-dot' }, [icon(ICONS.location, 20)]),
      el('div', { class: 'grow' }, [
        el('div', { style: { fontWeight: 600, fontSize: '15px' } }, [
          hangout.place || (hangout.myAnswer === 'host' ? 'Your spot' : `${hangout.host.name}'s spot`),
        ]),
        el('div', { class: 't-meta t-dim tnum' }, [
          `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
          hangout.location.accuracy ? ` · ±${Math.round(hangout.location.accuracy)}m` : '',
        ]),
      ]),
      el('span', { class: 't-meta', style: { color: 'var(--aurora)' } }, ['Open ›']),
    ]),
  ]);
}

/* ----------------------------------------------------------------- vault -- */

function renderVault(home) {
  const host = clear($('#home-vault'));
  const { vault, lastNight } = home;

  // A drop that just landed and has not been watched is the loudest thing on
  // the screen; otherwise the countdown carries the accent.
  const freshDrop = lastNight && !lastNight.watched && lastNight.counts.n > 0;

  if (freshDrop) host.append(dropCard(lastNight, home, true));
  host.append(countdownCard(vault, home, !freshDrop));
  if (lastNight && !freshDrop && lastNight.counts.n > 0) {
    host.append(el('div', { style: { marginTop: 'var(--s4)' } }, [dropCard(lastNight, home, false)]));
  }
}

function countdownCard(vault, home, accent) {
  // "Tonight" is only honest before the drop; after 20:00 the next one is tomorrow.
  const opensToday = new Date(vault.opensAt).toDateString() === new Date().toDateString();
  const card = el('section', { class: `vault ${accent ? '' : 'quiet'}`.trim() }, [
    el('div', { class: 'row between' }, [
      el('h3', { class: 't-section' }, [opensToday ? 'Tonight' : 'Tomorrow']),
      el('span', { class: 't-meta t-dim tnum' }, [`opens ${fmtClock(vault.opensAt)}`]),
    ]),
    el('div', { class: 'countdown', id: 'vault-countdown', dataset: { opens: String(vault.opensAt) } }, ['—']),
    el('div', { class: 'vault-ring' }, [el('i', { id: 'vault-progress' })]),
  ]);

  const n = vault.counts.n;
  const people = vault.contributors || [];
  card.append(el('div', { class: 'row gap-2 wrap' }, [
    ...people.slice(0, 8).map((p) => avatar(p, 'xs')),
    el('span', { class: 't-meta' }, [
      n === 0
        ? 'Nothing in the vault yet. Be the first.'
        : `${n} clip${n === 1 ? '' : 's'} from ${people.length} of you, sealed until then.`,

    ]),
  ]));

  if (n > 0) {
    const strip = el('div', { class: 'poster-strip' });
    for (let i = 0; i < Math.min(n, 8); i++) {
      strip.append(el('div', { class: 'poster locked' }, [icon(ICONS.lock, 18)]));
    }
    card.append(strip);
  }

  return card;
}

function dropCard(drop, home, accent) {
  const card = el('section', {
    class: `vault ${accent ? 'open' : ''}`.trim(),
    style: accent ? {} : { background: 'var(--ink-700)' },
  }, [
    el('div', { class: 'row between' }, [
      el('h3', { class: 't-section' }, [
        fmtDay(drop.day) === 'Today' ? 'Tonight — open' : `${fmtDay(drop.day)}'s memory`,
      ]),
      drop.watched ? null : el('span', { class: 'pill-live' }, ['new']),
    ]),
    el('div', { class: 'row gap-3', style: { marginTop: 'var(--s3)' } }, [
      drop.poster
        ? el('div', {
            class: 'poster',
            style: { width: '58px', backgroundImage: `url(${mediaUrl(drop.poster)})` },
          })
        : el('div', {
            class: 'poster',
            style: { width: '58px', display: 'grid', placeItems: 'center', fontSize: '22px' },
          }, ['🎞️']),
      el('div', { class: 'grow' }, [
        el('div', { style: { fontSize: '20px', fontWeight: 700, letterSpacing: '-.02em' } }, [
          `${drop.counts.n} clip${drop.counts.n === 1 ? '' : 's'}`,
        ]),
        el('div', { class: 't-meta' }, [
          `${(drop.contributors || []).map((c) => c.name.split(' ')[0]).join(', ') || 'your group'}`,
        ]),
      ]),
    ]),
    el('button', {
      class: `btn ${accent ? 'btn-primary' : 'btn-ghost'} btn-block`,
      style: { marginTop: 'var(--s4)' },
      onclick: () => openReel(home.group.id, drop.day),
    }, [drop.watched ? 'Watch again' : 'Watch the day']),
  ]);
  return card;
}

/* ---------------------------------------------------------------- recent -- */

function renderRecent(home) {
  const host = clear($('#home-recent'));
  const past = home.recent.filter((h) => !h.live).slice(0, 4);
  if (!past.length) return;

  host.append(el('h3', { class: 't-section', style: { marginBottom: 'var(--s3)' } }, ['Earlier']));
  const list = el('div', { class: 'list' });
  for (const h of past) {
    list.append(el('div', { class: 'list-item' }, [
      el('span', { style: { fontSize: '20px' } }, [h.vibeEmoji]),
      el('div', { class: 'grow' }, [
        el('div', { class: 'li-title', style: { fontSize: '15px' } }, [
          `${h.myAnswer === 'host' ? 'You' : h.host.name} · ${h.vibeLabel}`,
        ]),
        el('div', { class: 'li-sub' }, [
          `${timeAgo(h.createdAt)} · ${h.yes} ${h.yes === 1 ? 'person' : 'people'} in`,
        ]),
      ]),
    ]));
  }
  host.append(list);
}

/* ------------------------------------------------------------------- sky -- */

/** Push the horizon up as the drop approaches — the app's clock, made visual. */
function paintSky(home) {
  const { opensAt } = home.vault;
  const span = 24 * 3600_000;
  const remaining = Math.max(0, opensAt - Date.now());
  const progress = Math.min(1, Math.max(0, 1 - remaining / span));
  const eased = progress ** 2.2;
  document.documentElement.style.setProperty('--horizon-rise', (0.15 + eased * 0.85).toFixed(3));
  document.documentElement.style.setProperty('--horizon-opacity', (0.12 + eased * 0.62).toFixed(3));
  const bar = $('#vault-progress');
  if (bar) bar.style.setProperty('--p', `${(progress * 100).toFixed(1)}%`);
}

function startCountdown() {
  clearInterval(countdownTimer);
  const tick = () => {
    const node = $('#vault-countdown');
    if (!node) return clearInterval(countdownTimer);
    const opens = Number(node.dataset.opens);
    const left = opens - Date.now();
    if (left <= 0) {
      node.textContent = 'opening…';
      clearInterval(countdownTimer);
      setTimeout(() => loadGroup().then(renderHome), 2500);
      return;
    }
    const { text } = fmtCountdown(left);
    node.textContent = text;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

export function stopCountdown() {
  clearInterval(countdownTimer);
}

export { openHangoutSheet };

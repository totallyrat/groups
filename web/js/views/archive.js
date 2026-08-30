/* Memory Lane — every night your group has recorded, newest first. */

import { $, el, clear, toast, fmtDay, fmtDuration, icon, ICONS } from '../ui.js';
import { api } from '../api.js';
import { state } from '../store.js';
import { mediaUrl } from '../config.js';
import { show } from '../router.js';
import { openReel } from './reel.js';

export async function openArchive() {
  if (!state.groupId) return toast('Join a group first');
  show('archive');
  const grid = clear($('#archive-grid'));
  grid.append(el('div', { class: 'empty' }, [el('span', { class: 'spinner' })]));

  let days = [];
  try {
    ({ days } = await api.memories(state.groupId));
  } catch (err) {
    clear(grid).append(el('div', { class: 'empty' }, [err.message || 'Could not load']));
    return;
  }

  clear(grid);
  if (!days.length) {
    grid.append(el('div', {
      class: 'empty',
      style: { gridColumn: '1 / -1' },
    }, [
      el('div', { class: 'big' }, ['🎞️']),
      el('div', {}, ['No memories yet.']),
      el('div', { class: 't-meta t-dim', style: { marginTop: 'var(--s2)' } }, [
        'Hit the record button and start tonight off.',
      ]),
    ]));
    return;
  }

  for (const day of days) grid.append(tile(day));
}

function tile(day) {
  const locked = !day.unlocked;
  const node = el('button', {
    class: `mem-tile ${locked ? 'locked' : ''} ${!locked && !day.watched ? 'unwatched' : ''}`.trim(),
    style: day.poster ? { backgroundImage: `url(${mediaUrl(day.poster)})` } : {},
    onclick: () => {
      if (locked) {
        const hours = Math.max(1, Math.round((day.opensAt - Date.now()) / 3600_000));
        toast(`Sealed for ${hours}h more`);
        return;
      }
      openReel(state.groupId, day.day);
    },
  }, [
    el('span', { class: 'mem-date' }, [fmtDay(day.day)]),
    el('span', { class: 'mem-sub' }, [
      locked
        ? `${day.clips} sealed`
        : `${day.clips} clip${day.clips === 1 ? '' : 's'} · ${fmtDuration(day.seconds)}`,
    ]),
  ]);

  if (locked) {
    node.append(el('span', {
      style: {
        position: 'absolute', top: '10px', left: '10px', zIndex: '2',
        color: 'var(--fog-300)',
      },
    }, [icon(ICONS.lock, 16)]));
  }
  return node;
}

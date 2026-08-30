/* A back stack over five screens. Uses history entries so the iOS swipe-back
   gesture and the Android back button both do the obvious thing. */

import { $, $$, closeSheet } from './ui.js';

const stack = ['welcome'];
const onLeave = new Map();

export const current = () => stack[stack.length - 1];

export function onScreenLeave(name, fn) {
  onLeave.set(name, fn);
}

function paint(name) {
  for (const screen of $$('.screen')) {
    screen.classList.toggle('active', screen.dataset.screen === name);
  }
  // Hangout and Record only mean something inside a group.
  const dock = $('#dock');
  const wanted = name === 'home' && document.body.dataset.dock !== 'hidden';
  dock.classList.toggle('away', !wanted);
  document.documentElement.dataset.screen = name;
  window.scrollTo(0, 0);
}

export function show(name, { replace = false } = {}) {
  const from = current();
  if (from === name) return;
  closeSheet();
  onLeave.get(from)?.();
  if (replace) stack[stack.length - 1] = name;
  else stack.push(name);
  paint(name);
  try {
    history.pushState({ screen: name, depth: stack.length }, '', location.pathname);
  } catch { /* history is unavailable in some embedded webviews */ }
}

/**
 * Pop one screen. Goes through history so the in-app back button and the iOS
 * swipe-back gesture stay in step — `popstate` below does the actual pop.
 */
export function back(fallback = 'home') {
  if (stack.length > 1) {
    try {
      history.back();
      return;
    } catch { /* no history API — fall through to painting directly */ }
    onLeave.get(current())?.();
    stack.pop();
    paint(current());
    return;
  }
  reset(fallback);
}

export function reset(name) {
  onLeave.get(current())?.();
  stack.length = 0;
  stack.push(name);
  paint(name);
}

export function initRouter() {
  window.addEventListener('popstate', () => {
    if (stack.length > 1) {
      onLeave.get(current())?.();
      stack.pop();
      paint(current());
    }
  });

  for (const button of $$('[data-back]')) {
    button.addEventListener('click', () => back());
  }
}

/**
 * Shown when the app cannot find a server.
 *
 * A copy served from GitHub Pages (or any static host) is only the front end —
 * the groups, the clips and the hangouts live on a server your friendgroup
 * runs. This is where the two get introduced.
 */

import { $, el, clear, toast } from '../ui.js';
import { config, useServer, normalizeServer } from '../config.js';
import { reset } from '../router.js';

export function openConnect({ onConnected }) {
  reset('connect');
  const body = clear($('#connect-body'));

  const field = el('input', {
    class: 'field',
    id: 'server-field',
    placeholder: 'groups.yourdomain.com',
    inputmode: 'url',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
    style: { textAlign: 'center' },
  });

  const button = el('button', { class: 'btn btn-primary btn-block' }, ['Connect']);

  const connect = async () => {
    const typed = field.value.trim();
    if (!typed) {
      field.focus();
      return toast('Paste your group’s address');
    }

    // Someone will paste the whole invite link; take the server out of it.
    let candidate = typed;
    try {
      const asUrl = new URL(/^https?:\/\//i.test(typed) ? typed : `https://${typed}`);
      const embedded = asUrl.searchParams.get('s');
      if (embedded) candidate = embedded;
    } catch { /* not a URL, treat it as a host */ }

    button.disabled = true;
    button.replaceChildren(el('span', { class: 'spinner' }), document.createTextNode('Looking…'));

    const result = await useServer(candidate);
    button.disabled = false;
    button.textContent = 'Connect';

    if (!result.ok) {
      toast(result.error, 'warn', 5000);
      return;
    }
    toast('Connected', 'good');
    onConnected();
  };

  button.addEventListener('click', connect);
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });

  body.append(
    el('div', { class: 'welcome-mark', style: { margin: '0 auto var(--s5)' } }, [
      el('span', {
        html: `<svg width="46" height="46" viewBox="0 0 100 100" fill="none">
          <circle cx="50" cy="50" r="22" stroke="#FFF5E6" stroke-opacity=".35" stroke-width="2"/>
          <circle cx="50" cy="28" r="9" fill="#FFFBF5"/>
          <circle cx="69.05" cy="61" r="9" fill="#FFFBF5"/>
          <circle cx="30.95" cy="61" r="9" fill="#FFFBF5"/></svg>`,
      }),
    ]),

    el('h1', { class: 't-title', style: { textAlign: 'center' } }, ['Point it at your group']),
    el('p', {
      class: 't-meta',
      style: { textAlign: 'center', margin: 'var(--s3) auto var(--s6)', maxWidth: '30ch' },
    }, [
      'This copy of Groups is just the app. Your videos and hangouts live on a ' +
      'server your friendgroup runs — enter its address once and you are set.',
    ]),

    el('div', { class: 'stack gap-3' }, [field, button]),

    el('div', { class: 'card stack gap-3', style: { marginTop: 'var(--s6)' } }, [
      el('h3', { class: 't-section' }, ['No server yet?']),
      el('p', { class: 't-meta' }, [
        'One person in the group sets it up once — it is a single small ' +
        'container with no database to configure. The README walks through ' +
        'Fly.io (a few commands) or Docker on any machine.',
      ]),
      el('p', { class: 't-meta t-dim' }, [
        'Whoever sets it up sends everyone else an invite link, and this screen ' +
        'never appears again.',
      ]),
    ]),

    el('p', {
      class: 't-meta t-dim',
      style: { textAlign: 'center', padding: 'var(--s5) 0 var(--s7)' },
    }, [`Add to Home Screen works either way · ${location.host}`]),
  );

  // An invite link may have carried the server, but it was unreachable.
  const fromLink = normalizeServer(new URLSearchParams(location.search).get('s'));
  if (fromLink) {
    field.value = fromLink;
    toast('That server did not answer — check the address', 'warn', 5000);
  } else if (!config.local) {
    field.value = config.apiBase;
  }
}

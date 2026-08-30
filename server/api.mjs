import fsp from 'node:fs/promises';
import {
  id, inviteCode, token, sha256, recoveryPhrase, normalizePhrase,
  memoryDay, unlockAt, windowStart, addDays, localParts, dayKeyOf, isValidTz,
  json, readJson, HttpError, bad, unauthorized, forbidden, notFound,
  clean, clamp,
} from './util.mjs';
import { serveFile, extForMime, stitchReel, hasFfmpeg, extractPoster } from './media.mjs';

const YEAR = 365 * 24 * 3600;
const MAX_CLIP_BYTES = 220 * 1024 * 1024; // ~3 min of iPhone 1080p
const MAX_CLIP_SECONDS = 185;             // 3:00 with a little slack for rounding
const HANGOUT_MAX_HOURS = 12;

const VIBES = {
  hang:   { label: 'Just hang',  emoji: '🛋️' },
  food:   { label: 'Food',       emoji: '🍜' },
  walk:   { label: 'Walk',       emoji: '🚶' },
  drink:  { label: 'Drinks',     emoji: '🍹' },
  move:   { label: 'Move',       emoji: '🏀' },
  game:   { label: 'Game',       emoji: '🎮' },
  study:  { label: 'Study',      emoji: '📚' },
  out:    { label: 'Go out',     emoji: '🌃' },
};

export function createApi({ db, media, pusher, bus, config, signer }) {
  /* ------------------------------------------------------------ queries -- */

  const q = {
    userByToken: db.prepare(
      `SELECT u.*, s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`),
    touchSession: db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?'),
    insertUser: db.prepare(
      'INSERT INTO users (id, name, emoji, hue, recovery_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    userByRecovery: db.prepare('SELECT * FROM users WHERE recovery_hash = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    updateUser: db.prepare('UPDATE users SET name = ?, emoji = ?, hue = ? WHERE id = ?'),
    insertSession: db.prepare(
      'INSERT INTO sessions (token_hash, user_id, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?)'),

    insertGroup: db.prepare(
      `INSERT INTO groups (id, name, emoji, tz, unlock_hour, invite_code, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    groupById: db.prepare('SELECT * FROM groups WHERE id = ?'),
    groupByCode: db.prepare('SELECT * FROM groups WHERE invite_code = ?'),
    updateGroup: db.prepare('UPDATE groups SET name = ?, emoji = ?, tz = ?, unlock_hour = ? WHERE id = ?'),
    addMember: db.prepare(
      'INSERT OR IGNORE INTO members (group_id, user_id, role, joined_at, last_seen) VALUES (?, ?, ?, ?, ?)'),
    removeMember: db.prepare('DELETE FROM members WHERE group_id = ? AND user_id = ?'),
    membership: db.prepare('SELECT * FROM members WHERE group_id = ? AND user_id = ?'),
    membersOf: db.prepare(
      `SELECT u.id, u.name, u.emoji, u.hue, m.role, m.joined_at, m.last_seen
       FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.group_id = ? ORDER BY m.joined_at`),
    memberIds: db.prepare('SELECT user_id FROM members WHERE group_id = ?'),
    groupsOf: db.prepare(
      `SELECT g.*, m.role FROM members m JOIN groups g ON g.id = m.group_id
       WHERE m.user_id = ? ORDER BY m.joined_at DESC`),
    touchMember: db.prepare('UPDATE members SET last_seen = ? WHERE group_id = ? AND user_id = ?'),
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM members WHERE group_id = ?'),

    insertHangout: db.prepare(
      `INSERT INTO hangouts (id, group_id, user_id, vibe, note, lat, lng, accuracy, place, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    hangoutById: db.prepare('SELECT * FROM hangouts WHERE id = ?'),
    liveHangouts: db.prepare(
      `SELECT * FROM hangouts WHERE group_id = ? AND closed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`),
    recentHangouts: db.prepare(
      'SELECT * FROM hangouts WHERE group_id = ? ORDER BY created_at DESC LIMIT ?'),
    closeHangout: db.prepare('UPDATE hangouts SET closed_at = ? WHERE id = ?'),
    respond: db.prepare(
      `INSERT INTO hangout_responses (hangout_id, user_id, answer, lat, lng, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(hangout_id, user_id) DO UPDATE SET
         answer = excluded.answer, lat = excluded.lat, lng = excluded.lng,
         created_at = excluded.created_at`),
    responsesFor: db.prepare(
      `SELECT r.*, u.name, u.emoji, u.hue FROM hangout_responses r
       JOIN users u ON u.id = r.user_id WHERE r.hangout_id = ? ORDER BY r.created_at`),
    myResponse: db.prepare('SELECT * FROM hangout_responses WHERE hangout_id = ? AND user_id = ?'),

    insertClip: db.prepare(
      `INSERT INTO clips (id, group_id, user_id, day, shot_at, duration, caption, mime, ext, size, width, height, has_poster, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    clipById: db.prepare('SELECT * FROM clips WHERE id = ?'),
    clipsOfDay: db.prepare(
      `SELECT c.*, u.name, u.emoji, u.hue FROM clips c JOIN users u ON u.id = c.user_id
       WHERE c.group_id = ? AND c.day = ? ORDER BY c.shot_at ASC`),
    clipCount: db.prepare(
      'SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS people FROM clips WHERE group_id = ? AND day = ?'),
    contributorsOf: db.prepare(
      `SELECT DISTINCT u.id, u.name, u.emoji, u.hue FROM clips c JOIN users u ON u.id = c.user_id
       WHERE c.group_id = ? AND c.day = ? ORDER BY u.name`),
    firstPosterOf: db.prepare(
      `SELECT id FROM clips WHERE group_id = ? AND day = ? AND has_poster = 1
       ORDER BY shot_at LIMIT 1`),
    latestDayBefore: db.prepare(
      `SELECT day FROM clips WHERE group_id = ? AND day < ? ORDER BY day DESC LIMIT 1`),
    deleteClip: db.prepare('DELETE FROM clips WHERE id = ?'),
    setPoster: db.prepare('UPDATE clips SET has_poster = 1 WHERE id = ?'),
    daysWithClips: db.prepare(
      `SELECT day, COUNT(*) AS clips, COUNT(DISTINCT user_id) AS people, SUM(duration) AS seconds
       FROM clips WHERE group_id = ? GROUP BY day ORDER BY day DESC LIMIT ? OFFSET ?`),
    markSeen: db.prepare(
      'INSERT OR IGNORE INTO clip_views (clip_id, user_id, seen_at) VALUES (?, ?, ?)'),
    seenDays: db.prepare(
      `SELECT DISTINCT c.day FROM clip_views v JOIN clips c ON c.id = v.clip_id
       WHERE v.user_id = ? AND c.group_id = ?`),
    viewersOf: db.prepare(
      `SELECT u.id, u.name, u.emoji FROM clip_views v JOIN users u ON u.id = v.user_id
       WHERE v.clip_id = ?`),
    react: db.prepare(
      'INSERT OR IGNORE INTO reactions (clip_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)'),
    unreact: db.prepare('DELETE FROM reactions WHERE clip_id = ? AND user_id = ? AND emoji = ?'),
    reactionsForDay: db.prepare(
      `SELECT r.clip_id, r.emoji, r.user_id FROM reactions r JOIN clips c ON c.id = r.clip_id
       WHERE c.group_id = ? AND c.day = ?`),

    upsertReel: db.prepare(
      `INSERT INTO reels (group_id, day, status, clip_ids, size, error, built_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id, day) DO UPDATE SET
         status = excluded.status, clip_ids = excluded.clip_ids, size = excluded.size,
         error = excluded.error, built_at = excluded.built_at`),
    reel: db.prepare('SELECT * FROM reels WHERE group_id = ? AND day = ?'),

    savePush: db.prepare(
      `INSERT INTO push_subs (id, user_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, failures = 0`),
    pushFor: db.prepare('SELECT * FROM push_subs WHERE user_id = ?'),
    pushForMany: (ids) => db.prepare(
      `SELECT * FROM push_subs WHERE user_id IN (${ids.map(() => '?').join(',')})`).all(...ids),
    dropPush: db.prepare('DELETE FROM push_subs WHERE id = ?'),
    dropPushByEndpoint: db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?'),
    bumpPushFailure: db.prepare('UPDATE push_subs SET failures = failures + 1 WHERE id = ?'),

    insertEvent: db.prepare(
      'INSERT INTO events (group_id, type, payload, created_at) VALUES (?, ?, ?, ?)'),
    eventsSince: db.prepare(
      `SELECT * FROM events WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT 100`),
  };

  /* -------------------------------------------------------------- helpers -- */

  const now = () => Date.now();

  function authenticate(req) {
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
    const raw = bearer || req.cookies?.g_sess;
    if (!raw) return null;
    const hash = sha256(raw);
    const user = q.userByToken.get(hash);
    if (!user) return null;
    q.touchSession.run(now(), hash);
    return user;
  }

  const requireUser = (req) => {
    const user = authenticate(req);
    if (!user) throw unauthorized();
    return user;
  };

  function requireMember(groupId, userId) {
    const group = q.groupById.get(groupId);
    if (!group) throw notFound('Group not found');
    if (!q.membership.get(groupId, userId)) throw forbidden('You are not in this group');
    q.touchMember.run(now(), groupId, userId);
    return group;
  }

  const publicUser = (u) => ({ id: u.id, name: u.name, emoji: u.emoji, hue: u.hue });

  function sessionCookie(tok, secure) {
    return `g_sess=${tok}; Path=/; Max-Age=${YEAR}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  }

  /** Persist an event and fan it out to live SSE listeners in that group. */
  function emit(groupId, type, payload) {
    const created = now();
    const info = q.insertEvent.run(groupId, type, JSON.stringify(payload), created);
    const event = {
      seq: Number(info.lastInsertRowid),
      group_id: groupId,
      type,
      payload,
      created_at: created,
    };
    bus.publish(q.memberIds.all(groupId).map((r) => r.user_id), event);
    return event;
  }

  /** Fire-and-forget push to a set of users, minus whoever triggered it. */
  async function notify(userIds, payload) {
    if (!pusher.enabled || !userIds.length) return;
    const subs = q.pushForMany(userIds);
    await Promise.all(subs.map(async (sub) => {
      const result = await pusher.send(sub, payload);
      if (result.gone) q.dropPush.run(sub.id);
      else if (!result.ok) q.bumpPushFailure.run(sub.id);
    }));
  }

  function groupClock(group, at = now()) {
    const day = memoryDay(at, group.tz, group.unlock_hour);
    const opensAt = unlockAt(day, group.tz, group.unlock_hour);
    const previous = addDays(day, -1);
    return {
      day,
      previousDay: previous,
      opensAt,
      windowStart: windowStart(day, group.tz, group.unlock_hour),
      unlocked: false,
      serverTime: at,
    };
  }

  const isUnlocked = (group, day, at = now()) =>
    at >= unlockAt(day, group.tz, group.unlock_hour);

  /** A media URL that proves who it is for, so <video> and downloads work
      even when the app is served from another origin. */
  const signedClip = (clipId, kind, viewerId) =>
    `/api/clips/${clipId}/${kind}?t=${signer.sign(viewerId, `clip:${clipId}`)}`;

  function clipView(c, { includeUrls, viewerId }) {
    return {
      id: c.id,
      user: { id: c.user_id, name: c.name, emoji: c.emoji, hue: c.hue },
      shotAt: c.shot_at,
      duration: c.duration,
      caption: c.caption || '',
      width: c.width,
      height: c.height,
      size: c.size,
      mime: c.mime,
      poster: c.has_poster ? signedClip(c.id, 'poster', viewerId) : null,
      url: includeUrls ? signedClip(c.id, 'video', viewerId) : null,
    };
  }

  function hangoutView(h, viewerId) {
    const responses = q.responsesFor.all(h.id);
    const mine = responses.find((r) => r.user_id === viewerId);
    const isHost = h.user_id === viewerId;
    const saidYes = isHost || mine?.answer === 'yes';
    const host = q.userById.get(h.user_id);
    return {
      id: h.id,
      groupId: h.group_id,
      host: host ? publicUser(host) : null,
      vibe: h.vibe,
      vibeLabel: VIBES[h.vibe]?.label || 'Hang',
      vibeEmoji: VIBES[h.vibe]?.emoji || '👋',
      note: h.note || '',
      place: h.place || '',
      createdAt: h.created_at,
      expiresAt: h.expires_at,
      closedAt: h.closed_at,
      live: !h.closed_at && h.expires_at > now(),
      myAnswer: isHost ? 'host' : (mine?.answer || null),
      // The location is the payoff for saying yes — it is only ever sent to the
      // host and to people who are in.
      location: saidYes && h.lat != null
        ? { lat: h.lat, lng: h.lng, accuracy: h.accuracy }
        : null,
      hasLocation: h.lat != null,
      responses: responses.map((r) => ({
        user: { id: r.user_id, name: r.name, emoji: r.emoji, hue: r.hue },
        answer: r.answer,
        at: r.created_at,
        location: isHost && r.answer === 'yes' && r.lat != null
          ? { lat: r.lat, lng: r.lng } : null,
      })),
      yes: responses.filter((r) => r.answer === 'yes').length,
    };
  }

  /* ---------------------------------------------------------------- reels -- */

  const building = new Set();

  async function buildReel(group, day) {
    const key = `${group.id}:${day}`;
    if (building.has(key)) return;
    building.add(key);
    try {
      const clips = q.clipsOfDay.all(group.id, day);
      if (!clips.length) {
        q.upsertReel.run(group.id, day, 'empty', '', 0, null, now());
        return;
      }
      const ids = clips.map((c) => c.id).join(',');
      const existing = q.reel.get(group.id, day);
      if (existing?.status === 'ready' && existing.clip_ids === ids) return;

      q.upsertReel.run(group.id, day, 'building', ids, 0, null, null);
      emit(group.id, 'reel', { day, status: 'building' });

      const out = media.reelPath(group.id, day);
      const files = clips.map((c) => media.clipPath(c.id, c.ext));
      const result = await stitchReel(files, out, {
        expectedSeconds: clips.reduce((sum, c) => sum + (c.duration || 0), 0),
      });

      if (result.ok) {
        const st = await fsp.stat(out).catch(() => ({ size: 0 }));
        q.upsertReel.run(group.id, day, 'ready', ids, st.size, null, now());
        emit(group.id, 'reel', { day, status: 'ready', size: st.size });
      } else {
        q.upsertReel.run(group.id, day, 'unavailable', ids, 0, result.error, now());
        emit(group.id, 'reel', { day, status: 'unavailable' });
      }
    } finally {
      building.delete(key);
    }
  }

  /* --------------------------------------------------------------- routes -- */

  const routes = [];
  const route = (method, pattern, handler) => {
    const names = [];
    const rx = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, n) => {
      names.push(n);
      return '([^/]+)';
    }) + '$');
    routes.push({ method, rx, names, handler });
  };

  /* auth */

  route('POST', '/api/auth/register', async (req, res) => {
    const body = await readJson(req);
    const name = clean(body.name, 24);
    if (name.length < 1) throw bad('Pick a name');
    const phrase = recoveryPhrase();
    const userId = id('u');
    q.insertUser.run(
      userId, name, clean(body.emoji, 8) || '🙂',
      clamp(Number(body.hue) || Math.floor(Math.random() * 360), 0, 359),
      sha256(phrase), now(),
    );
    const tok = token();
    q.insertSession.run(sha256(tok), userId, clean(body.device, 60), now(), now());
    json(res, 200, {
      user: publicUser(q.userById.get(userId)),
      token: tok,
      recoveryPhrase: phrase,
    }, { 'set-cookie': sessionCookie(tok, config.secureCookies) });
  });

  route('POST', '/api/auth/restore', async (req, res) => {
    const body = await readJson(req);
    const phrase = normalizePhrase(body.recoveryPhrase);
    if (!phrase) throw bad('Enter your recovery phrase');
    const user = q.userByRecovery.get(sha256(phrase));
    if (!user) throw new HttpError(404, 'No account matches that phrase', 'no_account');
    const tok = token();
    q.insertSession.run(sha256(tok), user.id, clean(body.device, 60), now(), now());
    json(res, 200, { user: publicUser(user), token: tok },
      { 'set-cookie': sessionCookie(tok, config.secureCookies) });
  });

  route('GET', '/api/me', async (req, res) => {
    const user = requireUser(req);
    // EventSource cannot send an Authorization header and neither can <video>,
    // so a client holding only a bearer token gets the cookie re-issued here.
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
    const extra = bearer && !req.cookies?.g_sess
      ? { 'set-cookie': sessionCookie(bearer, config.secureCookies) }
      : {};
    json(res, 200, {
      user: publicUser(user),
      groups: q.groupsOf.all(user.id).map((g) => ({
        id: g.id, name: g.name, emoji: g.emoji, tz: g.tz,
        unlockHour: g.unlock_hour, inviteCode: g.invite_code, role: g.role,
        members: q.memberCount.get(g.id).n,
      })),
      push: { enabled: pusher.enabled, publicKey: pusher.publicKey || null },
      capabilities: { reelDownload: await hasFfmpeg() },
    }, extra);
  });

  route('PATCH', '/api/me', async (req, res) => {
    const user = requireUser(req);
    const body = await readJson(req);
    const name = clean(body.name, 24) || user.name;
    const emoji = clean(body.emoji, 8) || user.emoji;
    const hue = body.hue == null ? user.hue : clamp(Number(body.hue) || 0, 0, 359);
    q.updateUser.run(name, emoji, hue, user.id);
    const updated = q.userById.get(user.id);
    for (const g of q.groupsOf.all(user.id)) emit(g.id, 'member', { user: publicUser(updated) });
    json(res, 200, { user: publicUser(updated) });
  });

  /* groups */

  route('POST', '/api/groups', async (req, res) => {
    const user = requireUser(req);
    const body = await readJson(req);
    const name = clean(body.name, 40);
    if (!name) throw bad('Name your group');
    const tz = isValidTz(body.tz) ? body.tz : 'UTC';
    const groupId = id('g');
    let code = inviteCode();
    for (let i = 0; i < 5 && q.groupByCode.get(code); i++) code = inviteCode();
    q.insertGroup.run(
      groupId, name, clean(body.emoji, 8) || '✨', tz,
      clamp(Math.round(Number(body.unlockHour ?? 20)), 0, 23),
      code, user.id, now(),
    );
    q.addMember.run(groupId, user.id, 'owner', now(), now());
    json(res, 200, { group: groupSummary(q.groupById.get(groupId), user.id) });
  });

  route('POST', '/api/groups/join', async (req, res) => {
    const user = requireUser(req);
    const body = await readJson(req);
    const code = clean(body.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const group = q.groupByCode.get(code);
    if (!group) throw notFound('No group with that code');
    const fresh = !q.membership.get(group.id, user.id);
    q.addMember.run(group.id, user.id, 'member', now(), now());
    if (fresh) {
      emit(group.id, 'member-joined', { user: publicUser(user) });
      const others = q.memberIds.all(group.id)
        .map((r) => r.user_id).filter((uid) => uid !== user.id);
      notify(others, {
        title: `${user.name} joined ${group.name}`,
        body: `${user.emoji} say hi`,
        tag: `join-${group.id}`,
        url: `/?g=${group.id}`,
      }).catch(() => {});
    }
    json(res, 200, { group: groupSummary(group, user.id) });
  });

  function groupSummary(g, userId) {
    const clock = groupClock(g);
    const counts = q.clipCount.get(g.id, clock.day);
    return {
      id: g.id, name: g.name, emoji: g.emoji, tz: g.tz,
      unlockHour: g.unlock_hour, inviteCode: g.invite_code,
      role: q.membership.get(g.id, userId)?.role || 'member',
      members: q.membersOf.all(g.id).map((m) => ({
        id: m.id, name: m.name, emoji: m.emoji, hue: m.hue,
        role: m.role, lastSeen: m.last_seen,
      })),
      clock: { ...clock, unlocked: isUnlocked(g, clock.day) },
      today: { clips: counts.n, people: counts.people },
    };
  }

  route('GET', '/api/groups/:gid', async (req, res, params) => {
    const user = requireUser(req);
    const group = requireMember(params.gid, user.id);
    const live = q.liveHangouts.all(group.id, now()).map((h) => hangoutView(h, user.id));
    const clock = groupClock(group);
    const unlocked = isUnlocked(group, clock.day);
    const seen = new Set(q.seenDays.all(user.id, group.id).map((r) => r.day));

    // The home screen features the most recent memory that has anything in it —
    // a quiet Tuesday should not hide Monday's reel behind the archive. Any day
    // before the current one has necessarily already opened.
    const lastDay = q.latestDayBefore.get(group.id, clock.day)?.day || null;

    json(res, 200, {
      group: groupSummary(group, user.id),
      hangouts: live,
      recent: q.recentHangouts.all(group.id, 8).map((h) => hangoutView(h, user.id)),
      vault: {
        day: clock.day,
        unlocked,
        opensAt: clock.opensAt,
        counts: q.clipCount.get(group.id, clock.day),
        // Before the drop you can see the *shape* of tonight — who filmed, how
        // many clips — but never the contents.
        contributors: q.contributorsOf.all(group.id, clock.day),
        clips: unlocked
          ? q.clipsOfDay.all(group.id, clock.day).map((c) => clipView(c, { includeUrls: true, viewerId: user.id }))
          : [],
        watched: seen.has(clock.day),
      },
      lastNight: lastDay
        ? {
            day: lastDay,
            counts: q.clipCount.get(group.id, lastDay),
            contributors: q.contributorsOf.all(group.id, lastDay),
            openedAt: unlockAt(lastDay, group.tz, group.unlock_hour),
            poster: (() => {
              const row = q.firstPosterOf.get(group.id, lastDay);
              return row ? signedClip(row.id, 'poster', user.id) : null;
            })(),
            watched: seen.has(lastDay),
          }
        : null,
    });
  });

  route('PATCH', '/api/groups/:gid', async (req, res, params) => {
    const user = requireUser(req);
    const group = requireMember(params.gid, user.id);
    const body = await readJson(req);
    if (q.membership.get(group.id, user.id).role !== 'owner') throw forbidden('Only the owner can edit the group');
    q.updateGroup.run(
      clean(body.name, 40) || group.name,
      clean(body.emoji, 8) || group.emoji,
      isValidTz(body.tz) ? body.tz : group.tz,
      body.unlockHour == null ? group.unlock_hour : clamp(Math.round(Number(body.unlockHour)), 0, 23),
      group.id,
    );
    const updated = q.groupById.get(group.id);
    emit(group.id, 'group', { group: { id: updated.id, name: updated.name, emoji: updated.emoji } });
    json(res, 200, { group: groupSummary(updated, user.id) });
  });

  route('POST', '/api/groups/:gid/leave', async (req, res, params) => {
    const user = requireUser(req);
    const group = requireMember(params.gid, user.id);
    q.removeMember.run(group.id, user.id);
    emit(group.id, 'member-left', { userId: user.id });
    json(res, 200, { ok: true });
  });

  /* hangouts */

  route('POST', '/api/groups/:gid/hangouts', async (req, res, params) => {
    const user = requireUser(req);
    const group = requireMember(params.gid, user.id);
    const body = await readJson(req);

    const vibe = VIBES[body.vibe] ? body.vibe : 'hang';
    const hours = clamp(Number(body.hours) || 3, 1, HANGOUT_MAX_HOURS);
    const hangoutId = id('h');
    const lat = Number.isFinite(Number(body.lat)) ? Number(body.lat) : null;
    const lng = Number.isFinite(Number(body.lng)) ? Number(body.lng) : null;

    q.insertHangout.run(
      hangoutId, group.id, user.id, vibe, clean(body.note, 140),
      lat, lng, Number(body.accuracy) || null, clean(body.place, 80),
      now(), now() + hours * 3600_000,
    );

    const view = hangoutView(q.hangoutById.get(hangoutId), user.id);
    emit(group.id, 'hangout', { hangout: { id: hangoutId } });

    const others = q.memberIds.all(group.id)
      .map((r) => r.user_id).filter((uid) => uid !== user.id);
    notify(others, {
      title: `${user.name} wants to hang`,
      body: body.note
        ? `${VIBES[vibe].emoji} ${clean(body.note, 100)}`
        : `${VIBES[vibe].emoji} ${VIBES[vibe].label} — you in?`,
      tag: `hangout-${hangoutId}`,
      url: `/?g=${group.id}&hangout=${hangoutId}`,
      actions: [
        { action: 'yes', title: "I'm in" },
        { action: 'no', title: 'Cant' },
      ],
      data: { kind: 'hangout', hangoutId, groupId: group.id },
    }).catch(() => {});

    json(res, 200, { hangout: view });
  });

  route('GET', '/api/hangouts/:hid', async (req, res, params) => {
    const user = requireUser(req);
    const hangout = q.hangoutById.get(params.hid);
    if (!hangout) throw notFound('Hangout not found');
    requireMember(hangout.group_id, user.id);
    json(res, 200, { hangout: hangoutView(hangout, user.id) });
  });

  route('POST', '/api/hangouts/:hid/respond', async (req, res, params) => {
    const user = requireUser(req);
    const body = await readJson(req);
    const hangout = q.hangoutById.get(params.hid);
    if (!hangout) throw notFound('Hangout not found');
    requireMember(hangout.group_id, user.id);
    if (hangout.user_id === user.id) throw bad('You started this one');

    const answer = ['yes', 'no', 'maybe'].includes(body.answer) ? body.answer : 'no';
    const lat = answer === 'yes' && Number.isFinite(Number(body.lat)) ? Number(body.lat) : null;
    const lng = answer === 'yes' && Number.isFinite(Number(body.lng)) ? Number(body.lng) : null;
    q.respond.run(hangout.id, user.id, answer, lat, lng, now());

    emit(hangout.group_id, 'hangout-response', {
      hangoutId: hangout.id, userId: user.id, answer,
    });

    if (answer === 'yes') {
      notify([hangout.user_id], {
        title: `${user.name} is in! ${user.emoji}`,
        body: 'They just got your location.',
        tag: `hangout-${hangout.id}-yes`,
        url: `/?g=${hangout.group_id}&hangout=${hangout.id}`,
      }).catch(() => {});
    }

    // The reward for saying yes: the host's location comes back in the response.
    json(res, 200, { hangout: hangoutView(q.hangoutById.get(hangout.id), user.id) });
  });

  route('POST', '/api/hangouts/:hid/close', async (req, res, params) => {
    const user = requireUser(req);
    const hangout = q.hangoutById.get(params.hid);
    if (!hangout) throw notFound('Hangout not found');
    requireMember(hangout.group_id, user.id);
    if (hangout.user_id !== user.id) throw forbidden('Only the host can end it');
    q.closeHangout.run(now(), hangout.id);
    emit(hangout.group_id, 'hangout-closed', { hangoutId: hangout.id });
    json(res, 200, { ok: true });
  });

  /* clips */

  route('POST', '/api/groups/:gid/clips', async (req, res, params) => {
    const user = requireUser(req);
    const group = requireMember(params.gid, user.id);

    const mime = String(req.headers['content-type'] || 'video/mp4').split(';')[0].trim();
    if (!mime.startsWith('video/')) throw bad('Send a video');
    const ext = extForMime(mime);

    const head = (name) => req.headers[name] ? String(req.headers[name]) : '';
    const shotAtRaw = Number(head('x-shot-at'));
    const shotAt = Number.isFinite(shotAtRaw) && shotAtRaw > 0
      ? clamp(shotAtRaw, now() - 7 * 86400_000, now() + 60_000)
      : now();
    const duration = clamp(Number(head('x-duration')) || 0, 0, MAX_CLIP_SECONDS);
    let caption = '';
    try { caption = clean(Buffer.from(head('x-caption'), 'base64').toString('utf8'), 140); }
    catch { caption = ''; }

    const clipId = id('c');
    const dest = media.clipPath(clipId, ext);
    const size = await media.saveStream(dest, req, MAX_CLIP_BYTES);
    if (size < 1024) {
      await media.remove(dest);
      throw bad('That clip is empty');
    }

    const day = memoryDay(shotAt, group.tz, group.unlock_hour);
    q.insertClip.run(
      clipId, group.id, user.id, day, shotAt, duration, caption, mime, ext, size,
      Number(head('x-width')) || null, Number(head('x-height')) || null, 0, now(),
    );

    // Any cached stitch for that day is now stale.
    q.upsertReel.run(group.id, day, 'stale', '', 0, null, null);
    emit(group.id, 'clip', {
      day, clipId, user: publicUser(user),
      counts: q.clipCount.get(group.id, day),
    });

    if (isUnlocked(group, day)) {
      const others = q.memberIds.all(group.id)
        .map((r) => r.user_id).filter((uid) => uid !== user.id);
      notify(others, {
        title: `${user.name} added to tonight`,
        body: `${user.emoji} a new clip is in the memory`,
        tag: `clip-${group.id}-${day}`,
        url: `/?g=${group.id}&watch=${day}`,
      }).catch(() => {});
    }

    json(res, 200, {
      clip: { id: clipId, day, shotAt, duration, size },
      day,
      opensAt: unlockAt(day, group.tz, group.unlock_hour),
      counts: q.clipCount.get(group.id, day),
    });
  });

  route('POST', '/api/clips/:cid/poster', async (req, res, params) => {
    const user = requireUser(req);
    const clip = q.clipById.get(params.cid);
    if (!clip) throw notFound('Clip not found');
    if (clip.user_id !== user.id) throw forbidden('Not your clip');
    await media.saveStream(media.posterPath(clip.id), req, 4 * 1024 * 1024);
    q.setPoster.run(clip.id);
    json(res, 200, { ok: true });
  });

  /** Session first, then a signed link — one of the two must name a user. */
  function mediaUser(req, scope) {
    const session = authenticate(req);
    if (session) return session;
    const token = new URL(req.url, 'http://x').searchParams.get('t');
    const userId = token ? signer.verify(token, scope) : null;
    const user = userId ? q.userById.get(userId) : null;
    if (!user) throw unauthorized();
    return user;
  }

  route('GET', '/api/clips/:cid/video', async (req, res, params) => {
    const user = mediaUser(req, `clip:${params.cid}`);
    const clip = q.clipById.get(params.cid);
    if (!clip) throw notFound('Clip not found');
    const group = requireMember(clip.group_id, user.id);
    if (!isUnlocked(group, clip.day) && clip.user_id !== user.id) {
      throw forbidden('That memory has not opened yet');
    }
    const url = new URL(req.url, 'http://x');
    const download = url.searchParams.get('download')
      ? `groups-${clip.day}-${clip.id.slice(-6)}.${clip.ext}`
      : null;
    q.markSeen.run(clip.id, user.id, now());
    await serveFile(req, res, media.clipPath(clip.id, clip.ext), { mime: clip.mime, download });
  });

  route('GET', '/api/clips/:cid/poster', async (req, res, params) => {
    const user = mediaUser(req, `clip:${params.cid}`);
    const clip = q.clipById.get(params.cid);
    if (!clip || !clip.has_poster) throw notFound('No poster');
    const group = requireMember(clip.group_id, user.id);
    if (!isUnlocked(group, clip.day) && clip.user_id !== user.id) throw forbidden('Locked');
    await serveFile(req, res, media.posterPath(clip.id), { mime: 'image/jpeg' });
  });

  route('DELETE', '/api/clips/:cid', async (req, res, params) => {
    const user = requireUser(req);
    const clip = q.clipById.get(params.cid);
    if (!clip) throw notFound('Clip not found');
    if (clip.user_id !== user.id) throw forbidden('Not your clip');
    q.deleteClip.run(clip.id);
    await media.remove(media.clipPath(clip.id, clip.ext));
    await media.remove(media.posterPath(clip.id));
    q.upsertReel.run(clip.group_id, clip.day, 'stale', '', 0, null, null);
    emit(clip.group_id, 'clip-removed', { clipId: clip.id, day: clip.day });
    json(res, 200, { ok: true });
  });

  route('POST', '/api/clips/:cid/react', async (req, res, params) => {
    const user = requireUser(req);
    const body = await readJson(req);
    const clip = q.clipById.get(params.cid);
    if (!clip) throw notFound('Clip not found');
    requireMember(clip.group_id, user.id);
    const emoji = clean(body.emoji, 8) || '❤️';
    if (body.remove) q.unreact.run(clip.id, user.id, emoji);
    else q.react.run(clip.id, user.id, emoji, now());
    emit(clip.group_id, 'reaction', {
      clipId: clip.id, day: clip.day, emoji, userId: user.id, removed: !!body.remove,
    });
    json(res, 200, { ok: true });
  });

  /* memories */

  route('GET', '/api/groups/:gid/memories', async (req, res, params) => {
    const user = requireUser(req);
    const group = requireMember(params.gid, user.id);
    const url = new URL(req.url, 'http://x');
    const limit = clamp(Number(url.searchParams.get('limit')) || 30, 1, 90);
    const offset = clamp(Number(url.searchParams.get('offset')) || 0, 0, 5000);
    const seen = new Set(q.seenDays.all(user.id, group.id).map((r) => r.day));

    const days = q.daysWithClips.all(group.id, limit, offset).map((row) => {
      const unlocked = isUnlocked(group, row.day);
      const first = unlocked
        ? q.clipsOfDay.all(group.id, row.day).find((c) => c.has_poster)
        : null;
      return {
        day: row.day,
        clips: row.clips,
        people: row.people,
        seconds: Math.round(row.seconds || 0),
        unlocked,
        opensAt: unlockAt(row.day, group.tz, group.unlock_hour),
        watched: seen.has(row.day),
        poster: first ? signedClip(first.id, 'poster', user.id) : null,
      };
    });
    json(res, 200, { days });
  });

  route('GET', '/api/groups/:gid/memories/:day', async (req, res, params) => {
    const user = requireUser(req);
    const group = requireMember(params.gid, user.id);
    const day = params.day;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw bad('Bad day');
    const unlocked = isUnlocked(group, day);
    const counts = q.clipCount.get(group.id, day);

    if (!unlocked) {
      json(res, 200, {
        day, unlocked: false,
        opensAt: unlockAt(day, group.tz, group.unlock_hour),
        counts, clips: [],
      });
      return;
    }

    const clips = q.clipsOfDay.all(group.id, day);
    const reactions = q.reactionsForDay.all(group.id, day);
    const byClip = new Map();
    for (const r of reactions) {
      const list = byClip.get(r.clip_id) || [];
      list.push({ emoji: r.emoji, userId: r.user_id });
      byClip.set(r.clip_id, list);
    }
    const reel = q.reel.get(group.id, day);

    json(res, 200, {
      day,
      unlocked: true,
      opensAt: unlockAt(day, group.tz, group.unlock_hour),
      counts,
      totalSeconds: clips.reduce((s, c) => s + (c.duration || 0), 0),
      clips: clips.map((c) => ({
        ...clipView(c, { includeUrls: true, viewerId: user.id }),
        reactions: byClip.get(c.id) || [],
      })),
      reel: {
        available: await hasFfmpeg(),
        status: reel?.status || 'stale',
        url: reel?.status === 'ready'
          ? `/api/groups/${group.id}/memories/${day}/reel.mp4`
            + `?t=${signer.sign(user.id, `reel:${group.id}:${day}`)}`
          : null,
        size: reel?.size || 0,
      },
    });
  });

  route('POST', '/api/groups/:gid/memories/:day/mark-watched', async (req, res, params) => {
    const user = requireUser(req);
    const group = requireMember(params.gid, user.id);
    const at = now();
    for (const c of q.clipsOfDay.all(group.id, params.day)) q.markSeen.run(c.id, user.id, at);
    emit(group.id, 'watched', { day: params.day, userId: user.id });
    json(res, 200, { ok: true });
  });

  route('POST', '/api/groups/:gid/memories/:day/reel', async (req, res, params) => {
    const user = requireUser(req);
    const group = requireMember(params.gid, user.id);
    if (!isUnlocked(group, params.day)) throw forbidden('Not open yet');
    if (!(await hasFfmpeg())) {
      json(res, 200, { status: 'unavailable', reason: 'ffmpeg_unavailable' });
      return;
    }
    const existing = q.reel.get(group.id, params.day);
    const ids = q.clipsOfDay.all(group.id, params.day).map((c) => c.id).join(',');
    if (existing?.status === 'ready' && existing.clip_ids === ids) {
      json(res, 200, {
        status: 'ready',
        url: `/api/groups/${group.id}/memories/${params.day}/reel.mp4`
          + `?t=${signer.sign(user.id, `reel:${group.id}:${params.day}`)}`,
        size: existing.size,
      });
      return;
    }
    buildReel(group, params.day).catch(() => {});
    json(res, 200, { status: 'building' });
  });

  route('GET', '/api/groups/:gid/memories/:day/reel.mp4', async (req, res, params) => {
    const user = mediaUser(req, `reel:${params.gid}:${params.day}`);
    const group = requireMember(params.gid, user.id);
    if (!isUnlocked(group, params.day)) throw forbidden('Not open yet');
    const reel = q.reel.get(group.id, params.day);
    if (reel?.status !== 'ready') throw notFound('Reel not built yet');
    await serveFile(req, res, media.reelPath(group.id, params.day), {
      mime: 'video/mp4',
      download: `${group.name.replace(/[^\w]+/g, '-')}-${params.day}.mp4`,
    });
  });

  /* push */

  route('POST', '/api/push/subscribe', async (req, res) => {
    const user = requireUser(req);
    const body = await readJson(req);
    const sub = body.subscription || body;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw bad('Bad subscription');
    q.savePush.run(id('p'), user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, now());
    json(res, 200, { ok: true });
  });

  route('POST', '/api/push/unsubscribe', async (req, res) => {
    const user = requireUser(req);
    const body = await readJson(req);
    if (body.endpoint) q.dropPushByEndpoint.run(body.endpoint, user.id);
    json(res, 200, { ok: true });
  });

  route('POST', '/api/push/test', async (req, res) => {
    const user = requireUser(req);
    await notify([user.id], {
      title: 'Notifications are on 🎉',
      body: "You'll hear about hangouts and when memories open.",
      tag: 'test',
      url: '/',
    });
    json(res, 200, { ok: true, subs: q.pushFor.all(user.id).length });
  });

  /* realtime */

  route('POST', '/api/stream/ticket', async (req, res) => {
    const user = requireUser(req);
    json(res, 200, { ticket: signer.sign(user.id, 'stream', 120) });
  });

  route('GET', '/api/stream', async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const ticket = url.searchParams.get('ticket');
    const viaTicket = ticket ? q.userById.get(signer.verify(ticket, 'stream') || '') : null;
    const user = viaTicket || requireUser(req);
    const since = Number(req.headers['last-event-id'] || url.searchParams.get('since') || 0);

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const groups = q.groupsOf.all(user.id);
    if (since > 0) {
      for (const g of groups) {
        for (const ev of q.eventsSince.all(g.id, since)) {
          res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify({
            seq: ev.seq, groupId: ev.group_id, type: ev.type,
            payload: JSON.parse(ev.payload), at: ev.created_at,
          })}\n\n`);
        }
      }
    }

    const unsubscribe = bus.subscribe(user.id, (event) => {
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({
        seq: event.seq, groupId: event.group_id, type: event.type,
        payload: event.payload, at: event.created_at,
      })}\n\n`);
    });

    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); unsubscribe(); });
  });

  route('GET', '/api/health', async (req, res) => {
    json(res, 200, {
      ok: true,
      time: now(),
      push: pusher.enabled,
      ffmpeg: await hasFfmpeg(),
      version: config.version,
    });
  });

  route('GET', '/api/vibes', async (req, res) => {
    json(res, 200, {
      vibes: Object.entries(VIBES).map(([key, v]) => ({ key, ...v })),
    });
  });

  /* ------------------------------------------------------------ dispatch -- */

  async function handle(req, res, pathname) {
    for (const r of routes) {
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      const m = r.rx.exec(pathname);
      if (!m) continue;
      const params = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      await r.handler(req, res, params);
      return true;
    }
    return false;
  }

  return { handle, buildReel, groupClock, isUnlocked, q, notify, emit, extractPoster };
}

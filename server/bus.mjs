/**
 * In-process pub/sub for Server-Sent Events.
 *
 * Keyed by user id, because a person can have the phone and a laptop open at
 * once and both should light up.
 */
export function createBus() {
  const listeners = new Map(); // userId -> Set<fn>

  return {
    subscribe(userId, fn) {
      let set = listeners.get(userId);
      if (!set) listeners.set(userId, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
        if (!set.size) listeners.delete(userId);
      };
    },

    publish(userIds, event) {
      for (const userId of userIds) {
        const set = listeners.get(userId);
        if (!set) continue;
        for (const fn of set) {
          try { fn(event); } catch { /* a dead socket must not break the others */ }
        }
      }
    },

    get connections() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}

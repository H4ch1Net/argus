// Rate / budget governor (proxy job 6). Sits in front of metered feeds so a
// panning session can never burn a month of credits. Per feed it enforces a
// requests-per-minute rate and a credit budget over a rolling window; the cost
// of a request can depend on its path (e.g. Shodan's /count is free, /search is
// metered). In-memory and per-process, which is enough for the local-first model.
//
// A feed opts in with a `governor` config:
//   { ratePerMinute?, creditBudget?, creditWindowMs?, creditCost? (number | (path)=>number) }

const costOf = (cfg, path) =>
  typeof cfg.creditCost === 'function' ? cfg.creditCost(path) : (cfg.creditCost ?? 1);

export function createGovernor(feeds, now = () => Date.now()) {
  const configFor = (id) => feeds.find((f) => f.id === id)?.governor || null;
  const state = new Map(); // id -> { reqTimes: number[], credits, windowStart }

  const ensure = (id) => {
    if (!state.has(id)) state.set(id, { reqTimes: [], credits: 0, windowStart: now() });
    return state.get(id);
  };

  return {
    /** Returns { ok, cost, status?, message? }. Call before forwarding. */
    check(feedId, path) {
      const cfg = configFor(feedId);
      if (!cfg) return { ok: true, cost: 0 };
      const st = ensure(feedId);
      const t = now();

      if (cfg.creditWindowMs && t - st.windowStart > cfg.creditWindowMs) {
        st.credits = 0;
        st.windowStart = t;
      }
      if (cfg.ratePerMinute) {
        st.reqTimes = st.reqTimes.filter((x) => t - x < 60_000);
        if (st.reqTimes.length >= cfg.ratePerMinute) {
          return { ok: false, status: 429, message: `rate limit for ${feedId}`, cost: 0 };
        }
      }
      const cost = costOf(cfg, path);
      if (cfg.creditBudget != null && st.credits + cost > cfg.creditBudget) {
        return {
          ok: false,
          status: 429,
          message: `credit budget for ${feedId} exhausted`,
          cost,
        };
      }
      return { ok: true, cost };
    },

    /** Record a forwarded request (after check passes). */
    record(feedId, cost) {
      const cfg = configFor(feedId);
      if (!cfg) return;
      const st = ensure(feedId);
      st.reqTimes.push(now());
      st.credits += cost || 0;
    },

    usage(feedId) {
      const st = state.get(feedId);
      const cfg = configFor(feedId);
      if (!st || !cfg) return null;
      const t = now();
      return {
        credits: st.credits,
        creditBudget: cfg.creditBudget ?? null,
        reqLastMinute: st.reqTimes.filter((x) => t - x < 60_000).length,
      };
    },
  };
}

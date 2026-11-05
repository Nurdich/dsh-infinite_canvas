/**
 * 图片/视频批量生成的并发池。
 * 图片默认 4 路，视频默认 2 路。429 时把该供应商的并发减半并退避，成功后再慢慢加回来。
 * 一个任务失败不会取消其他任务。要接上一段尾帧的视频会等上一段结束。
 */

export function defaultGenConcurrency(kind) {
  return kind === 'video' ? 2 : 4;
}

export function clampGenConcurrency(value, kind) {
  const n = Number(value);
  const fallback = defaultGenConcurrency(kind);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.max(1, Math.min(8, Math.round(n)));
}

/** 供应商上的「并发数」优先；扩展 JSON 里的 concurrency / parallel 其次；否则用默认。 */
export function providerConcurrency(provider, kind) {
  const p = provider || {};
  if (p.concurrency != null && String(p.concurrency).trim() !== '') return clampGenConcurrency(p.concurrency, kind);
  let extra = p.extra;
  if (typeof extra === 'string' && extra.trim()) {
    try { extra = JSON.parse(extra); } catch { extra = null; }
  }
  if (extra && typeof extra === 'object') {
    const n = extra.concurrency || extra.parallel || extra.maxConcurrency;
    if (n != null && String(n).trim() !== '') return clampGenConcurrency(n, kind);
  }
  return defaultGenConcurrency(kind);
}

export function isRateLimitError(err) {
  const status = Number(err && err.status) || 0;
  const msg = String((err && err.message) || err || '');
  return status === 429 || /429|rate limit|too many requests/i.test(msg);
}

/**
 * 按顺序排列的视频段。continued 或 join=continuous 的段必须等上一段成功。
 * 硬切的段彼此独立，可以同时进池。
 */
export function videoDeps(items) {
  const list = items || [];
  return list.map((item, i) => {
    const prev = i > 0 ? list[i - 1] : null;
    const chained = !!(item && (item.continued || item.join === 'continuous'));
    return { id: item.id, waitFor: chained && prev ? prev.id : null, item };
  });
}

export function createAimd(limit) {
  const max = Math.max(1, Number(limit) || 1);
  let current = max;
  let backoffMs = 1000;
  let until = 0;
  let streak = 0;
  return {
    limit() { return current; },
    max() { return max; },
    pauseUntil() { return until; },
    onRateLimit(now) {
      current = Math.max(1, Math.floor(current / 2));
      backoffMs = Math.min(30000, Math.max(1000, backoffMs * 2));
      until = (now == null ? Date.now() : now) + backoffMs;
      streak = 0;
      return { limit: current, backoffMs, pauseUntil: until };
    },
    onSuccess() {
      streak += 1;
      if (streak >= 2 && current < max) {
        current += 1;
        streak = 0;
        backoffMs = 1000;
      }
      return current;
    },
  };
}

/**
 * 有上限的工人池。waitFor 没完成时不会开工。
 * 429 把该任务放回队列并降低并发；其他错误只记这一项，兄弟任务继续。
 * 上游失败时，依赖它的任务标失败，不继续用缺失的尾帧。
 */
export async function runGenPool(items, worker, opts) {
  const options = opts || {};
  const cap = Math.max(1, Number(options.concurrency) || 4);
  const aimd = options.aimd || createAimd(cap);
  const isRate = options.isRateLimit || isRateLimitError;
  const now = () => (options.now ? options.now() : Date.now());
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const signal = options.signal;
  const onState = options.onState || (() => {});
  const list = (items || []).map((item, i) => ({
    id: item && item.id != null ? item.id : String(i),
    item,
    waitFor: item && item.waitFor || null,
    state: 'queued',
    rateTries: 0,
  }));
  const byId = new Map(list.map((t) => [t.id, t]));
  const results = [];
  let active = 0;
  let launching = false;

  const snapshot = (task) => onState({
    id: task && task.id,
    state: task && task.state,
    active,
    limit: Math.min(cap, aimd.limit()),
    done: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    total: list.length,
  });

  function failDependents(id, error) {
    for (const t of list) {
      if (t.waitFor !== id || t.state !== 'queued') continue;
      t.state = 'failed';
      t.error = error;
      results.push({ id: t.id, ok: false, error });
      snapshot(t);
      failDependents(t.id, error);
    }
  }

  function readyTasks() {
    return list.filter((t) => {
      if (t.state !== 'queued') return false;
      if (!t.waitFor) return true;
      const dep = byId.get(t.waitFor);
      return !!(dep && dep.state === 'done');
    });
  }

  async function launch() {
    if (launching) return;
    launching = true;
    try {
      while (true) {
        if (signal && signal.aborted) {
          for (const t of list) {
            if (t.state === 'queued') {
              t.state = 'cancelled';
              results.push({ id: t.id, ok: false, error: new Error('cancelled') });
              snapshot(t);
            }
          }
          return;
        }
        const limit = Math.min(cap, aimd.limit());
        if (active >= limit) return;
        const clock = now();
        if (aimd.pauseUntil() > clock) {
          const wait = aimd.pauseUntil() - clock;
          launching = false;
          await sleep(wait);
          return launch();
        }
        const ready = readyTasks();
        if (!ready.length) return;
        const task = ready[0];
        task.state = 'running';
        active += 1;
        snapshot(task);
        worker(task.item).then(
          (value) => {
            task.state = 'done';
            task.value = value;
            results.push({ id: task.id, ok: true, value });
            aimd.onSuccess();
          },
          (error) => {
            if (isRate(error) && task.rateTries < 2 && !(signal && signal.aborted)) {
              task.rateTries += 1;
              task.state = 'queued';
              aimd.onRateLimit(now());
              return;
            }
            task.state = 'failed';
            task.error = error;
            results.push({ id: task.id, ok: false, error });
            failDependents(task.id, error);
          },
        ).finally(() => {
          active -= 1;
          snapshot(task);
          launch();
        });
      }
    } finally {
      launching = false;
    }
  }

  if (!list.length) return { results: [], limit: cap };
  await launch();
  await new Promise((resolve) => {
    const tick = () => {
      const pending = list.some((t) => t.state === 'queued' || t.state === 'running');
      if (!pending) resolve();
      else setTimeout(tick, 5);
    };
    tick();
  });
  return { results, limit: aimd.limit() };
}

/**
 * 把后写入的文档并进磁盘上的最新文档。
 * 只在两边都有的节点上合并字段；一边才有的节点保留。
 * 后来的空 assetId 不会抹掉已经写上的成图。墓碑里的节点删掉。
 */
export function mergeDocWrite(fresh, incoming) {
  const base = fresh && typeof fresh === 'object' ? fresh : {};
  const inc = incoming && typeof incoming === 'object' ? incoming : {};
  const tomb = new Set([...(base.tombstones || []), ...(inc.tombstones || [])].filter(Boolean));
  const nodes = { ...(base.nodes || {}) };
  for (const [id, node] of Object.entries(inc.nodes || {})) {
    if (!node || tomb.has(id)) continue;
    const prev = nodes[id];
    if (!prev) { nodes[id] = node; continue; }
    const prevData = (prev.data && typeof prev.data === 'object') ? prev.data : {};
    const nextData = (node.data && typeof node.data === 'object') ? node.data : {};
    const data = { ...prevData, ...nextData };
    if (prevData.assetId && (nextData.assetId == null || nextData.assetId === '')) data.assetId = prevData.assetId;
    if (prevData.refLock && nextData.refLock == null) data.refLock = prevData.refLock;
    nodes[id] = { ...prev, ...node, data };
  }
  for (const id of tomb) delete nodes[id];
  const incomingNodes = new Set(Object.keys(inc.nodes || {}));
  const edges = [];
  const seen = new Set();
  const pushEdge = (e) => {
    if (!e || !e.id || seen.has(e.id)) return;
    if (tomb.has(e.fromNode) || tomb.has(e.toNode)) return;
    if (!nodes[e.fromNode] || !nodes[e.toNode]) return;
    seen.add(e.id);
    edges.push(e);
  };
  for (const e of inc.edges || []) pushEdge(e);
  for (const e of base.edges || []) {
    if (incomingNodes.has(e.fromNode) && incomingNodes.has(e.toNode)) continue;
    pushEdge(e);
  }
  return {
    ...base,
    ...inc,
    nodes,
    edges,
    tombstones: [...tomb].slice(-200),
  };
}

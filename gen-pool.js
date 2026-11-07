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

export const LEGACY_NODE_TYPES = { 'image-gen': 'image', 'image-asset': 'image', 'video-gen': 'video', 'video-asset': 'video' };

export function normalizeNodeType(type) { return LEGACY_NODE_TYPES[type] || type; }

/** 端口表。宿主连线和浏览器画布用这一份。 */
export const PORTS = {
  text: { inputs: [], outputs: [{ id: 'out', kind: 'text' }] },
  shot: {
    inputs: [{ id: 'char', kind: 'image' }, { id: 'scene', kind: 'image' }, { id: 'prop', kind: 'image' }],
    outputs: [{ id: 'visual', kind: 'text' }, { id: 'motion', kind: 'text' }],
  },
  script: { inputs: [], outputs: [{ id: 'out', kind: 'text' }] },
  storyboard: {
    inputs: [{ id: 'prev', kind: 'text' }, { id: 'script', kind: 'text' }, { id: 'music', kind: 'text' }],
    outputs: [{ id: 'out', kind: 'text' }, { id: 'tail', kind: 'text' }],
  },
  audio: { inputs: [], outputs: [{ id: 'out', kind: 'audio' }, { id: 'analysis', kind: 'text' }] },
  image: { inputs: [{ id: 'prompt', kind: 'text' }, { id: 'ref', kind: 'image' }], outputs: [{ id: 'out', kind: 'image' }] },
  video: {
    inputs: [{ id: 'prompt', kind: 'text' }, { id: 'frame', kind: 'image' }, { id: 'ref', kind: 'image' }],
    outputs: [{ id: 'out', kind: 'video' }, { id: 'tailpick', kind: 'image' }, { id: 'last', kind: 'image' }],
  },
  finalcut: { inputs: [{ id: 'in', kind: 'video' }, { id: 'music', kind: 'audio' }], outputs: [] },
  group: { inputs: [], outputs: [] },
};

/** 分镜要等角色和场景都有图并且定稿。MV 的锁定规则，不是另一套出图。 */
export function missingRefsForShot(shot, states) {
  const s = shot || {};
  const characters = Array.isArray(s.characters) ? s.characters.map((n) => String(n || '').trim()).filter(Boolean) : [];
  const scene = String(s.scene || '').trim();
  const missing = [];
  for (const name of characters) {
    const row = (states || []).find((row) => row && row.role === 'char' && row.name === name);
    if (!row || !row.assetId) missing.push({ role: 'char', name, why: 'missing' });
    else if (!row.locked) missing.push({ role: 'char', name, why: 'unlocked' });
  }
  if (scene) {
    const row = (states || []).find((row) => row && row.role === 'loc' && row.name === scene);
    if (!row || !row.assetId) missing.push({ role: 'loc', name: scene, why: 'missing' });
    else if (!row.locked) missing.push({ role: 'loc', name: scene, why: 'unlocked' });
  }
  return missing;
}

/** 一个节点同一种任务只保留一条。第二次进来是加入，不是再开一条。 */
export function createJobBook() {
  const jobs = new Map();
  const key = (nodeId, kind) => String(nodeId || '') + '\n' + String(kind || '');
  return {
    get(nodeId, kind) {
      return jobs.get(key(nodeId, kind)) || null;
    },
    list() { return [...jobs.values()]; },
    open(spec) {
      const o = spec || {};
      const k = key(o.nodeId, o.kind);
      const cur = jobs.get(k);
      const live = cur && (cur.status === 'running' || cur.status === 'queued');
      if (live && !o.force) {
        if (!cur.owner && o.owner) {
          cur.owner = o.owner;
          cur.status = 'running';
          cur.updatedAt = Date.now();
          if (o.line) cur.line = o.line;
          return { job: cur, joined: false, claimed: true };
        }
        return { job: cur, joined: true, claimed: false };
      }
      const gate = confirmPaidJob(o);
      if (!gate.allow) return { job: null, joined: false, claimed: false, needsConfirm: true, preview: gate.preview };
      const job = {
        id: 'job-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        nodeId: String(o.nodeId || ''),
        kind: String(o.kind || ''),
        status: o.status || 'running',
        owner: o.owner || '',
        phase: o.phase || 'connecting',
        line: o.line || '',
        windowIndex: Number(o.windowIndex) || 0,
        windowCount: Number(o.windowCount) || 1,
        elapsedMs: 0,
        text: '',
        error: '',
        followUp: o.followUp || null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      jobs.set(k, job);
      return { job, joined: false, claimed: true };
    },
    patch(nodeId, kind, patch) {
      const job = jobs.get(key(nodeId, kind));
      if (!job || !patch) return job;
      for (const f of ['status', 'phase', 'line', 'text', 'error', 'owner']) {
        if (patch[f] != null) job[f] = patch[f];
      }
      if (patch.windowIndex != null) job.windowIndex = Number(patch.windowIndex);
      if (patch.windowCount != null) job.windowCount = Number(patch.windowCount);
      if (patch.elapsedMs != null) job.elapsedMs = Number(patch.elapsedMs);
      if (patch.followUp) job.followUp = patch.followUp;
      job.updatedAt = Date.now();
      return job;
    },
    finish(nodeId, kind, result) {
      const job = jobs.get(key(nodeId, kind));
      if (!job) return null;
      job.status = 'done';
      job.phase = 'done';
      job.result = result || null;
      job.updatedAt = Date.now();
      return job;
    },
    fail(nodeId, kind, error) {
      const job = jobs.get(key(nodeId, kind));
      if (!job) return null;
      job.status = 'error';
      job.phase = 'error';
      job.error = String(error || '');
      job.line = job.error;
      job.updatedAt = Date.now();
      return job;
    },
    cancel(nodeId, kind) {
      const job = jobs.get(key(nodeId, kind));
      if (!job || job.status === 'done') return job;
      job.status = 'cancelled';
      job.phase = 'cancelled';
      job.line = '已停止';
      job.updatedAt = Date.now();
      return job;
    },
  };
}

/** 节点类型对应的任务种类。音乐时间轴和听歌是音频节点上的两种任务，不是两种节点。 */
export function mediaKind(nodeType, intent) {
  if (intent) return String(intent);
  if (nodeType === 'audio') return 'analyze';
  if (nodeType === 'finalcut') return 'compose';
  if (nodeType === 'storyboard') return 'storyboard';
  if (nodeType === 'script' || nodeType === 'text') return 'text';
  return nodeType || 'run';
}

/**
 * 听歌该谁做。已经有一条进行中的任务就加入。
 * 调用方自己带了能量曲线或音频字节时，在宿主里算完（测试和离线路径）。
 * 节点里已经有歌、但字节在画布上时，只排队，不在宿主再听一遍。
 */
export function decideAnalyze(input) {
  const o = input || {};
  const job = o.job;
  if (job && (job.status === 'running' || job.status === 'queued') && !o.force) return { action: 'join', job };
  if (o.hasAnalysis && !o.force) return { action: 'cached' };
  if (o.hasEnergy || o.hasAudioBase64) return { action: 'local' };
  if (o.hasAsset) return { action: 'queue-client' };
  if (o.hasDuration) return { action: 'local' };
  return { action: 'missing-file' };
}

/** 铺时间轴之前必须已经有分析。分析还在听就记下风格，不要报“请上传歌曲”。 */
export function decideTimeline(input) {
  const o = input || {};
  const job = o.job;
  if (job && (job.status === 'running' || job.status === 'queued')) return { action: 'wait', job };
  if (!o.hasAnalysis) return { action: 'need-analysis', hasAsset: !!o.hasAsset };
  return { action: 'build' };
}

/** 连进来的口必须真有上游产物。没连上的口不要求。 */
export function edgeBlock(node, edges, nodes) {
  const id = node && node.id;
  const missing = [];
  for (const e of edges || []) {
    if (!e || e.toNode !== id) continue;
    const src = nodes && nodes[e.fromNode];
    const port = e.toPort || '';
    if (!src) { missing.push({ port, why: 'missing-node' }); continue; }
    const data = src.data || {};
    if (port === 'ref' || port === 'frame' || port === 'in' || port === 'char' || port === 'scene' || port === 'prop') {
      if (!data.assetId) missing.push({ port, from: src.id, label: data.label || src.id, why: 'no-asset' });
    } else if (port === 'prompt' || port === 'script' || port === 'prev') {
      const text = data.prompt || data.text || data.output || data.script;
      const shots = Array.isArray(data.shots) && data.shots.length;
      if (!text && !shots) missing.push({ port, from: src.id, label: data.label || src.id, why: 'no-text' });
    }
  }
  return missing;
}

export function edgeBlockSay(missing) {
  const row = (missing || [])[0];
  if (!row) return '';
  if (row.why === 'no-asset') return '上游「' + (row.label || '') + '」还没有生成结果，这条线不能当成参考。';
  if (row.why === 'no-text') return '上游「' + (row.label || '') + '」还没有正文，不能接着生成。';
  return '有一条线的上游节点不在了。';
}

/** 会花钱的任务。听歌、写时间轴、改字不算。 */
const PAID_JOB_KINDS = new Set(['image', 'video', 'compose', 'tts', 'music']);

/**
 * 唯一的付费确认。助手发起的要等用户点确认；节点上的生成按钮算确认（source=user）。
 * 文本、分析和铺时间轴直接过。
 */
export function confirmPaidJob(input) {
  const o = input || {};
  const kind = String(o.kind || '');
  const paid = PAID_JOB_KINDS.has(kind);
  const preview = {
    kind: paid ? kind : '',
    count: Math.max(1, Number(o.count) || 1),
    nodeId: String(o.nodeId || ''),
    label: String(o.label || ''),
    provider: String(o.provider || ''),
    model: String(o.model || ''),
    seconds: o.seconds != null && o.seconds !== '' ? o.seconds : '',
    cost: o.cost ? String(o.cost) : '',
  };
  if (!paid) return { allow: true, paid: false, needsConfirm: false, preview };
  if (o.source === 'assistant' && o.confirmed !== true) return { allow: false, paid: true, needsConfirm: true, preview };
  return { allow: true, paid: true, needsConfirm: false, preview };
}

export function paidConfirmLine(preview) {
  const p = preview || {};
  const names = { image: '图片', video: '视频', compose: '成片', tts: '语音', music: '音乐' };
  const unit = p.kind === 'video' ? ' 段' : p.kind === 'image' ? ' 张' : ' 项';
  const bits = ['将生成' + (names[p.kind] || '内容') + ' ' + (p.count || 1) + unit];
  if (p.kind === 'video' && p.seconds) bits[0] += ' · ' + p.seconds + 's';
  if (p.label) bits.push(p.label);
  else if (p.nodeId) bits.push(p.nodeId);
  const model = [p.provider, p.model].filter(Boolean).join(' / ');
  if (model) bits.push(model);
  if (p.cost) bits.push('约 ' + p.cost);
  return bits.join(' · ') + '。确认后才会执行。';
}

/** 一首歌往下走到哪一步。付费步骤只返回确认，不执行。 */
export function nextMvPlanStep(input) {
  const o = input || {};
  if (!o.hasAudio) return { step: 'need-audio' };
  if (!o.hasAnalysis) return { step: 'analyze' };
  if (!o.hasPackage) return { step: 'timeline' };
  if (!o.onCanvas) return { step: 'push' };
  const missing = Number(o.missingRefs) || 0;
  const unlocked = Number(o.unlockedRefs) || 0;
  if (missing > 0) return { step: 'confirm-refs', kind: 'image', count: missing };
  if (unlocked > 0) return { step: 'need-lock', count: unlocked };
  const shots = Number(o.missingShots) || 0;
  if (shots > 0) return { step: 'confirm-shots', kind: 'image', count: shots };
  const videos = Number(o.missingVideos) || 0;
  if (videos > 0) return { step: 'confirm-videos', kind: 'video', count: videos };
  return { step: 'done' };
}

const CLAIM_DONE = /分析完|已经分析|听完了|时间轴也铺好|时间轴已铺|时间轴也已经|已生成|生成好了|生成完成/;

/** 助手嘴上的完成，必须和任务、文档对得上。对不上就改成任务自己的那句。 */
export function honestSay(say, facts) {
  const text = String(say || '');
  const f = facts || {};
  const steps = f.steps || [];
  const failed = steps.find((s) => s && s.ok === false);
  const job = f.job || null;
  const live = job && (job.status === 'running' || job.status === 'queued');
  const claimsTimeline = /时间轴也铺好|时间轴已铺|时间轴也已经/.test(text);
  const claimsAnalysis = /分析完|已经分析|听完了/.test(text);
  const claimsMedia = /已生成|生成好了|生成完成/.test(text);
  if (!CLAIM_DONE.test(text)) return text;
  if (failed && (claimsAnalysis || claimsTimeline || claimsMedia)) {
    return '执行失败：' + String(failed.error || failed.label || '没有完成');
  }
  if (claimsTimeline && !f.hasPackage) {
    return live ? ((job.line || '正在听') + '。时间轴还没铺。') : '时间轴还没铺好。';
  }
  if (claimsAnalysis && !f.hasAnalysis) {
    return live ? (job.line || '正在听，还没有分析完。') : '还没有分析完。';
  }
  if (claimsMedia && !f.hasAsset && !(job && job.status === 'done')) {
    return live ? (job.line || '还在生成。') : text;
  }
  return text;
}

/**
 * 音频驱动（音乐 MV）：分析 schema、Qwen Omni 请求、本地节拍兜底、按拍分镜。
 *
 * 纯函数，宿主 index.js 直接 import。浏览器侧只负责把歌曲压成可上传的 WAV / 能量曲线，
 * 分析与分镜规划都走宿主，避免两份算法。
 *
 * 模型 id：用户口头的「Qwen3.8-Omni-Flash」对应百炼 / DashScope 官方 id `qwen3.8-omni-flash`
 * （2026-10 文档）。旧的 `qwen3-omni-flash` 仍可在设置里手填。
 */

export const AUDIO_ANALYSIS_SCHEMA = 'dshic.audio-analysis.v1';
/** 设置里预填的官方模型 id。 */
export const SUGGESTED_MODEL_ID = 'qwen3.8-omni-flash';
/** 用户请求里的叫法，文档与界面用它对照官方 id。 */
export const USER_MODEL_NAME = 'Qwen3.8-Omni-Flash';
/** 北京地域百炼 OpenAI 兼容模式。国际站 / 工作空间端点由用户粘贴覆盖。 */
export const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
/** 音频理解端点预设。新加坡用 Qwen Cloud 的 compatible-mode，模型 id 是 qwen3-omni-flash。 */
export const AUDIO_ENDPOINT_PRESETS = [
  { id: 'beijing', label: '北京 · DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-omni-flash' },
  { id: 'singapore', label: '新加坡 · Qwen Cloud', baseUrl: 'https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1', model: 'qwen3-omni-flash' },
  { id: 'intl', label: '国际 · DashScope Intl', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-omni-flash' },
];
/**
 * DashScope：Base64 字符串必须 < 10MB。留出 JSON 信封，并低于宿主代理 16MB 上限。
 * 与 client.js 里的同名预算函数保持一致（scripts/test-audio-drive.mjs 会比对函数体）。
 */
export const AUDIO_BASE64_LIMIT = 9500000;
/** MV 单次视频生成允许的时长（秒）。更长的节拍槽会拆段；对不上的槽位取最近允许值再裁切。 */
export const MV_GEN_DURATIONS = [4, 5, 6, 8, 10, 12, 15];

function normalizeDurations(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const n of list) {
    const v = Number(n);
    if (v >= 1 && v <= 120 && !out.includes(v)) out.push(v);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** allowed 是当前视频模型声明的时长档。不传就用内置档。槽位对不上就取最近档，长过上限就封顶。 */
export function snapGenerationDuration(sec, allowed) {
  const list = normalizeDurations(allowed);
  const use = list.length ? list : MV_GEN_DURATIONS;
  const slot = round3(Math.max(0.4, num(sec, 0)));
  const max = use[use.length - 1];
  if (slot > max) return { requestSec: max, slotSec: slot, split: true, warn: '超过模型单次上限 ' + max + ' 秒，已封顶，请拆段' };
  let best = use[0];
  for (const d of use) if (Math.abs(d - slot) < Math.abs(best - slot)) best = d;
  const warn = Math.abs(best - slot) > 0.35
    ? ('生成时长 ' + best + 's，成片裁到节拍槽 ' + slot + 's')
    : '';
  return { requestSec: best, slotSec: slot, split: false, warn };
}

/** 同一项自动改参数再试的上限。未知原因只允许原样再试一次。 */
export const ADAPT_RETRY_CAP = 2;

const ADAPT_SAY = {
  moderation: '内容审核未通过，已改写提示词并保留原意。',
  long: '提示词过长，已缩短。',
  duration: '时长不在模型允许范围内，已改到最近的允许值。',
  resolution: '分辨率或比例不受支持，已改到允许值。',
  ref: '参考文件过大或格式不对，已压缩后再试。',
  transient: '服务暂时没有响应，将用原参数稍后重试。',
  balance: '模型余额不足，已停止重试。请充值或更换模型。',
  auth: '密钥无效，已停止重试。请到设置里检查。',
  empty: '模型没有返回可用结果，已要求它严格按格式再答一次。',
  unknown: '没能判断失败原因。',
};

export function classifyGenFailure(message, status) {
  const raw = String(message || '');
  const code = Number(status) || Number((/HTTP\s+(\d+)/.exec(raw) || [])[1]) || 0;
  if (/insufficient balance|余额不足|arrearage|overdue-payment|quota exceeded|欠费/i.test(raw)) return 'balance';
  if (code === 401 || /invalid api[- ]?key|unauthorized|invalid_api_key|密钥无效/i.test(raw)) return 'auth';
  if (/moderat|safety|content policy|data_inspection|datainspection|nsfw|违规|敏感|审核|不合规|色情/i.test(raw)) return 'moderation';
  if (/prompt.{0,12}too long|max(?:imum)? context|context length|token limit|提示词过长|超出长度|too many characters/i.test(raw)) return 'long';
  if (/duration|时长/.test(raw) && /unsupported|invalid|not support|不支持|不允许|超出/i.test(raw)) return 'duration';
  if (/resolution|aspect|ratio|分辨率|比例/.test(raw) && /unsupported|invalid|not support|不支持|不允许/i.test(raw)) return 'resolution';
  if (/too large|file size|payload|unsupported (image|audio|format)|格式|过大|参考图/i.test(raw)) return 'ref';
  if (code === 429 || (code >= 500 && code <= 599) || /timeout|timed out|超时|aborted|ECONNRESET|ETIMEDOUT|rate limit|too many requests/i.test(raw)) return 'transient';
  if (/empty|garbled|无法解析|没有返回|返回为空|invalid json|unexpected token/i.test(raw)) return 'empty';
  return 'unknown';
}

export function sanitizePrompt(prompt) {
  let s = String(prompt || '');
  const swaps = [
    [/血腥|gore|blood/gi, '紧张'],
    [/裸体|裸露|nude|naked/gi, '服装完整'],
    [/色情|sexual|nsfw/gi, ''],
    [/杀死|杀人|murder|\bkill\b/gi, '对峙'],
    [/枪支|手枪|步枪|\bgun\b|\brifle\b/gi, '道具'],
    [/毒品|drug/gi, ''],
  ];
  for (const [re, to] of swaps) s = s.replace(re, to);
  return s.replace(/\s{2,}/g, ' ').trim();
}

export function shortenPrompt(prompt, limit) {
  const s = String(prompt || '').trim();
  const max = Math.max(80, Number(limit) || 600);
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.65);
  const tail = max - head - 1;
  return s.slice(0, head) + '…' + s.slice(-tail);
}

function nearestAllowed(value, allowed, fallback) {
  const list = (allowed || []).map((x) => String(x)).filter(Boolean);
  const cur = String(value || '');
  if (!list.length) return cur || fallback;
  if (list.includes(cur)) return cur;
  return list[0] || fallback;
}

/**
 * 根据这一次失败决定下一次怎么改。history 里 auto:true 的次数达到上限就停。
 * rewrittenPrompt 是模型改写的结果；没有就用规则。
 */
export function adaptGenAttempt(input) {
  const src = input || {};
  const params = Object.assign({}, src.params || {});
  const history = Array.isArray(src.history) ? src.history : [];
  const kind = classifyGenFailure(src.message, src.status);
  const next = Object.assign({}, params);
  let change = '';
  if (kind === 'moderation') {
    const rewritten = String(src.rewrittenPrompt || '').trim();
    next.prompt = rewritten || sanitizePrompt(params.prompt);
    change = '已改写提示词以通过审核';
  } else if (kind === 'long') {
    const before = String(params.prompt || '').length;
    next.prompt = shortenPrompt(params.prompt, src.maxPrompt);
    change = '提示词 ' + before + '→' + String(next.prompt || '').length + ' 字';
  } else if (kind === 'duration') {
    const snap = snapGenerationDuration(params.duration, params.allowedDurations);
    next.duration = snap.requestSec;
    change = '时长 ' + (params.duration || '?') + 's→' + snap.requestSec + 's';
  } else if (kind === 'resolution') {
    const ratio = nearestAllowed(params.ratio, params.allowedRatios || ['16:9', '9:16', '1:1'], '16:9');
    const resolution = nearestAllowed(params.resolution, params.allowedResolutions || ['480P', '720P', '1080P'], '720P');
    next.ratio = ratio;
    next.resolution = resolution;
    const bits = [];
    if (String(params.resolution || '') !== resolution) bits.push('分辨率 ' + (params.resolution || '?') + '→' + resolution);
    if (String(params.ratio || '') !== ratio) bits.push('比例 ' + (params.ratio || '?') + '→' + ratio);
    change = bits.join('，') || '已对齐到允许的分辨率';
  } else if (kind === 'ref') {
    next.compressRefs = true;
    change = '参考已压缩';
  } else if (kind === 'empty') {
    const extra = '只返回可用结果，不要解释，不要空内容。';
    next.prompt = String(params.prompt || '').includes(extra) ? params.prompt : (String(params.prompt || '') + '\n' + extra);
    next.instruction = extra;
    change = '已加上更严的输出要求';
  } else if (kind === 'transient') {
    change = '原参数稍后重试';
  } else if (kind === 'unknown') {
    change = '原参数再试一次';
  }
  const autoCount = history.filter((h) => h && h.auto).length;
  const unknownCount = history.filter((h) => h && h.kind === 'unknown').length;
  let auto = false;
  let say = ADAPT_SAY[kind] || ADAPT_SAY.unknown;
  if (kind === 'balance' || kind === 'auth') auto = false;
  else if (kind === 'unknown') auto = unknownCount < 1;
  else auto = autoCount < ADAPT_RETRY_CAP;
  if (!auto && kind === 'unknown') say = '没能判断失败原因，已停止自动重试。';
  if (!auto && autoCount >= ADAPT_RETRY_CAP && kind !== 'balance' && kind !== 'auth' && kind !== 'unknown') {
    say = say.replace(/。$/, '') + '。已自动改过 ' + ADAPT_RETRY_CAP + ' 次，停下来等你确认。';
  }
  const backoffMs = kind === 'transient' ? ([2000, 6000][Math.min(autoCount, 1)] || 6000) : 0;
  return { kind, say, change, params: next, auto, backoffMs };
}

export function pushAttempt(history, entry) {
  const list = Array.isArray(history) ? history.slice() : [];
  list.push(entry || {});
  return list.slice(-20);
}

/** 一个镜头要用到的角色和场景。场景来自 shot.scene。 */
export function shotRefNames(shot) {
  const s = shot || {};
  const characters = Array.isArray(s.characters) ? s.characters.map((n) => String(n || '').trim()).filter(Boolean) : [];
  const scene = String(s.scene || '').trim();
  return { characters, locations: scene ? [scene] : [] };
}

function refRow(states, role, name) {
  return (states || []).find((s) => s && s.role === role && s.name === name) || null;
}

/** 这个镜头的分镜图能不能画：每个角色和场景都要有图，并且已定稿。 */
export function missingRefsForShot(shot, states) {
  const need = shotRefNames(shot);
  const missing = [];
  for (const name of need.characters) {
    const row = refRow(states, 'char', name);
    if (!row || !row.assetId) missing.push({ role: 'char', name, why: 'missing' });
    else if (!row.locked) missing.push({ role: 'char', name, why: 'unlocked' });
  }
  for (const name of need.locations) {
    const row = refRow(states, 'loc', name);
    if (!row || !row.assetId) missing.push({ role: 'loc', name, why: 'missing' });
    else if (!row.locked) missing.push({ role: 'loc', name, why: 'unlocked' });
  }
  return missing;
}

export function refProgress(states) {
  const list = states || [];
  const tally = (role) => {
    const rows = list.filter((s) => s && s.role === role);
    return {
      total: rows.length,
      have: rows.filter((s) => s.assetId).length,
      locked: rows.filter((s) => s.assetId && s.locked).length,
    };
  };
  const characters = tally('char');
  const locations = tally('loc');
  const shots = tally('shot');
  const videos = tally('video');
  let stage = 'refs';
  if (characters.locked >= characters.total && locations.locked >= locations.total) stage = shots.have >= shots.total ? 'videos' : 'shots';
  return { characters, locations, shots, videos, stage };
}

/** 沿连线找出下游节点。锁定的设定重新生成后，这些分镜和视频要标成需重生成。 */
export function downstreamOf(edges, id) {
  const out = [];
  const seen = new Set();
  const walk = (from) => {
    for (const e of edges || []) {
      if (!e || e.fromNode !== from || seen.has(e.toNode)) continue;
      seen.add(e.toNode);
      out.push(e.toNode);
      walk(e.toNode);
    }
  };
  walk(id);
  return out;
}

/**
 * 铺到画布时的真实连线：角色/场景图 → 每个用到它们的分镜图；
 * 第一张分镜图 → 该段视频的首帧；角色图同时进视频参考。
 */
export function mvWirePlan(pkg) {
  const edges = [];
  const scenes = (pkg && pkg.scenes) || [];
  scenes.forEach((sc, si) => {
    (sc.shots || []).forEach((shot, shi) => {
      const shotKey = 'kf:' + si + ':' + shi;
      const names = shotRefNames(shot);
      for (const name of names.characters) edges.push({ fromRole: 'char', fromName: name, toRole: 'shot', toKey: shotKey, toPort: 'ref' });
      for (const name of names.locations) edges.push({ fromRole: 'loc', fromName: name, toRole: 'shot', toKey: shotKey, toPort: 'ref' });
      edges.push({ fromRole: 'shot', fromKey: shotKey, toRole: 'video', toKey: 'vid:' + si, toPort: shi === 0 ? 'frame' : 'ref' });
      for (const name of names.characters) edges.push({ fromRole: 'char', fromName: name, toRole: 'video', toKey: 'vid:' + si, toPort: 'ref' });
    });
  });
  return edges;
}

/** 上传后的时长：解码结果优先，其次 metadata，其次节点上已存的值。都没有就是 0，不能假装有时长。 */
export function readAudioDuration(src) {
  const o = src || {};
  for (const v of [o.decodedSec, o.metadataSec, o.storedSec]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0.05) return Math.round(n * 1000) / 1000;
  }
  return 0;
}

/** 时间轴宽度至少铺满可见区域。时长未知时也不许缩成几十像素的短条。 */
export function timelineLanePx(durationSec, viewWidth, zoom) {
  const view = Math.max(280, Number(viewWidth) || 280);
  const z = Number(zoom) > 0 ? Number(zoom) : 1;
  const dur = Number(durationSec) || 0;
  if (!(dur > 0)) return view;
  return Math.max(view, Math.round(dur * 8 * z));
}

/** 把整首切成能放进 Base64 上限的窗口，窗口之间重叠，避免段落刚好被切断。 */
export function planAudioWindows(durationSec, opts) {
  const dur = Math.max(0, Number(durationSec) || 0);
  const sampleRate = Math.max(8000, Number(opts && opts.sampleRate) || 16000);
  const limit = Number(opts && opts.base64Limit) || AUDIO_BASE64_LIMIT;
  const overlap = Math.max(0, Number(opts && opts.overlapSec) || 2);
  const rawBudget = Math.floor((limit * 3) / 4) - 4096;
  let windowSec = Math.floor(rawBudget / (sampleRate * 2));
  if (!(windowSec > 8)) windowSec = 30;
  if (!(dur > 0)) return [];
  if (dur <= windowSec + 0.5) return [{ index: 0, startSec: 0, endSec: round3(dur), offsetSec: 0 }];
  const step = Math.max(5, windowSec - overlap);
  const out = [];
  for (let t = 0; t < dur - 0.2 && out.length < 48; t += step) {
    const end = Math.min(dur, t + windowSec);
    out.push({ index: out.length, startSec: round3(t), endSec: round3(end), offsetSec: round3(t) });
    if (end >= dur - 0.05) break;
  }
  return out;
}

/** 多段听歌结果按偏移拼回整首。重叠处同一标签的段落只留一次。 */
export function mergeAudioAnalyses(parts, durationSec) {
  const list = (parts || []).filter((p) => p && p.analysis).slice().sort((a, b) => (Number(a.offsetSec) || 0) - (Number(b.offsetSec) || 0));
  if (!list.length) throw new Error('没有分析片段');
  const dur = Number(durationSec) || 0;
  if (list.length === 1 && !(Number(list[0].offsetSec) > 0)) {
    const only = list[0].analysis;
    return normalizeAnalysis(only, {
      durationSec: dur || only.durationSec,
      source: only.source,
      method: only.method,
      model: only.model,
      warnings: only.warnings,
    });
  }
  const beats = [];
  const downbeats = [];
  const sections = [];
  const lyrics = [];
  const warnings = ['整首按窗口听完后合并，重叠处已去掉重复段落。'];
  const bpms = [];
  let source = 'qwen-omni';
  let method = 'model';
  let model = null;
  for (const part of list) {
    const off = Number(part.offsetSec) || 0;
    const a = part.analysis || {};
    if (a.source !== 'qwen-omni') { source = 'local-fallback'; method = a.method || 'webaudio'; }
    if (!model && a.model) model = a.model;
    if (a.bpm) bpms.push(Number(a.bpm));
    for (const t of a.beats || []) beats.push(round3(Number(t) + off));
    for (const t of a.downbeats || []) downbeats.push(round3(Number(t) + off));
    for (const s of a.sections || []) {
      const start = round3(Number(s.startSec) + off);
      const end = round3(Number(s.endSec) + off);
      if (!(end > start)) continue;
      if (sections.some((ex) => Math.abs(ex.startSec - start) < 1 && ex.label === s.label)) continue;
      sections.push({ ...s, startSec: start, endSec: end });
    }
    for (const l of a.lyrics || []) {
      lyrics.push({ ...l, startSec: round3(Number(l.startSec) + off), endSec: round3(Number(l.endSec) + off) });
    }
    if (Array.isArray(a.warnings)) warnings.push(...a.warnings);
  }
  bpms.sort((a, b) => a - b);
  const bpm = bpms.length ? bpms[Math.floor(bpms.length / 2)] : null;
  const first = list[0].analysis || {};
  return normalizeAnalysis({
    bpm, beats, downbeats, sections, lyrics, warnings,
    mood: first.mood, genre: first.genre, instrumentation: first.instrumentation,
    summary: first.summary, imagery: first.imagery, motif: first.motif,
    characters: first.characters, locations: first.locations, props: first.props,
  }, { durationSec: dur || undefined, source, method, model, warnings });
}

/** 边界吸到最近的拍。离拍太远就保持原时间，避免把段落拖飞。 */
export function snapSectionBoundary(timeSec, beats, toleranceSec) {
  const t = Number(timeSec) || 0;
  const tol = toleranceSec == null ? 0.35 : Number(toleranceSec);
  const list = (beats || []).map(Number).filter((n) => Number.isFinite(n));
  const raw = Math.round(t * 1000) / 1000;
  if (!list.length) return raw;
  let best = list[0];
  for (const b of list) if (Math.abs(b - t) < Math.abs(best - t)) best = b;
  return Math.abs(best - t) <= tol ? Math.round(best * 1000) / 1000 : raw;
}

export function moveSectionBoundary(sections, index, edge, timeSec, beats) {
  const next = JSON.parse(JSON.stringify(sections || []));
  const sec = next[index];
  if (!sec) throw new Error('段落不存在');
  const t = snapSectionBoundary(timeSec, beats);
  if (edge === 'end') {
    const cap = next[index + 1] ? next[index + 1].endSec - 0.4 : t;
    sec.endSec = round3(Math.max(sec.startSec + 0.4, Math.min(t, cap)));
    if (next[index + 1]) next[index + 1].startSec = sec.endSec;
  } else {
    const prev = next[index - 1];
    const floor = prev ? prev.startSec + 0.4 : 0;
    sec.startSec = round3(Math.max(floor, Math.min(t, sec.endSec - 0.4)));
    if (prev) prev.endSec = sec.startSec;
  }
  return next;
}

export function splitSectionAt(sections, index, timeSec, beats) {
  const next = JSON.parse(JSON.stringify(sections || []));
  const sec = next[index];
  if (!sec) throw new Error('段落不存在');
  let t = snapSectionBoundary(timeSec, beats);
  if (t <= sec.startSec + 0.4) t = round3(sec.startSec + (sec.endSec - sec.startSec) / 2);
  if (t >= sec.endSec - 0.4) t = round3(sec.endSec - 0.4);
  if (!(t > sec.startSec + 0.3 && t < sec.endSec - 0.3)) throw new Error('这段太短，拆不开');
  const right = { ...sec, id: sec.id + 'b', startSec: t };
  sec.endSec = t;
  next.splice(index + 1, 0, right);
  return next;
}

export function mergeSectionWithNext(sections, index) {
  const next = JSON.parse(JSON.stringify(sections || []));
  const sec = next[index];
  const nxt = next[index + 1];
  if (!sec || !nxt) throw new Error('没有下一段可合并');
  sec.endSec = nxt.endSec;
  next.splice(index + 1, 1);
  return next;
}

/** 每一段为什么从这里切开：段落变了、落在重拍、歌词换行，或能量跳了。 */
export function sectionCutReasons(sections, analysis) {
  const a = analysis || {};
  const downs = a.downbeats || [];
  const lyrics = a.lyrics || [];
  return (sections || []).map((sec, i) => {
    const prev = sections[i - 1];
    const reasons = [];
    if (!prev) reasons.push('歌曲起点');
    else if (prev.label !== sec.label) reasons.push('段落变化');
    if (downs.some((d) => Math.abs(Number(d) - Number(sec.startSec)) <= 0.35)) reasons.push('落在重拍');
    if (lyrics.some((l) => Math.abs(Number(l.startSec) - Number(sec.startSec)) <= 0.5)) reasons.push('歌词换行');
    if (prev && sec.energy != null && prev.energy != null && Math.abs(Number(sec.energy) - Number(prev.energy)) >= 0.25) reasons.push('能量变化');
    if (!reasons.length) reasons.push('按结构切开');
    return { ...sec, cutReason: reasons.join(' · ') };
  });
}

export function sectionsToSlices(sections) {
  return (sections || []).map((sec, i) => ({
    index: i,
    id: sec.id || ('s' + (i + 1)),
    label: sec.label || '',
    startSec: Number(sec.startSec) || 0,
    endSec: Number(sec.endSec) || 0,
    duration: Math.max(0, (Number(sec.endSec) || 0) - (Number(sec.startSec) || 0)),
    cutReason: sec.cutReason || '',
  })).filter((s) => s.duration > 0);
}

export function sliceDurationSum(slices) {
  return (slices || []).reduce((s, x) => s + (Number(x.duration) || ((Number(x.endSec) || 0) - (Number(x.startSec) || 0))), 0);
}

/** 创作流程。没有歌曲停在上传；听完停在确认；确认后才能写风格；有了时间轴才推到画布。 */
export function mvCreateFlow(input) {
  const o = input || {};
  const steps = [
    { id: 'upload', label: '上传音乐' },
    { id: 'analyze', label: 'AI 听歌分析' },
    { id: 'confirm', label: '分段确认' },
    { id: 'style', label: '输入风格并生成时间轴' },
    { id: 'push', label: '推到画布 / 分段生成' },
  ];
  let current = 'upload';
  if (o.hasAudio) current = 'analyze';
  if (o.hasAnalysis) current = 'confirm';
  if (o.confirmed) current = 'style';
  if (o.hasPackage) current = 'push';
  return { current, index: steps.findIndex((s) => s.id === current), steps };
}

const ASSISTANT_TOOLS = ['analyze', 'confirm_sections', 'set_style', 'build_timeline', 'edit_shot', 'adjust_sections', 'push', 'generate', 'compose', 'remix'];
const ASSISTANT_CLIENT_JOBS = ['analyze', 'push', 'generate', 'compose', 'remix'];
const ASSISTANT_SPEND = ['generate', 'compose'];

export function assistantSystemPrompt() {
  return [
    '你是音乐 MV 节点上的助手。只根据用户这句话和当前节点状态决定下一步。',
    '不要假设具体的歌名、故事或模型。生成图片或视频要花钱，你不能直接生成，只能提出 generate 或 compose，由系统请用户确认。',
    '分析、改分段、确认分段、写风格、铺时间轴、改某一镜的提示词、推到画布，都不生成视频。',
    '只返回一个 JSON：{"say":"给用户的简短说明","tool":"工具名或空字符串","args":{}}。',
    '工具名只能是：' + ASSISTANT_TOOLS.join('、') + '。',
    'edit_shot 的 args 用 sceneIndex（从 0 起）、shotIndex、complaint（用户原话）。',
    'generate 的 args.scope 是 one 或 all，one 时带 sceneIndex。',
    'set_style 的 args.style 是用户的风格原话。',
  ].join('\n');
}

export function assistantStateDigest(state) {
  const st = state || {};
  const sections = (st.analysis && st.analysis.sections) || [];
  return {
    mode: st.mode || 'create',
    hasAudio: !!st.hasAudio,
    hasAnalysis: !!st.hasAnalysis,
    confirmed: !!st.confirmed,
    hasPackage: !!st.hasPackage,
    styleText: st.styleText || '',
    durationSec: st.durationSec || (st.analysis && st.analysis.durationSec) || 0,
    sections: sections.map((s) => ({ label: s.label, startSec: s.startSec, endSec: s.endSec, cutReason: s.cutReason || '' })),
    scenes: ((st.mvPackage && st.mvPackage.scenes) || []).map((sc, i) => ({
      index: i,
      title: sc.title,
      startSec: sc.startSec,
      endSec: sc.endSec,
      status: sc.gen && sc.gen.status,
      awaitingConfirm: !!sc.awaitingConfirm,
    })),
  };
}

function shotIndexFromMessage(text) {
  const m = String(text || '').match(/第\s*(\d+)\s*[段镜场]/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n >= 1)) return null;
  return n - 1;
}

export function parseAssistantAction(modelText) {
  if (!modelText) return null;
  const json = extractJsonObject(String(modelText));
  if (!json || !json.tool) return null;
  const tool = String(json.tool);
  if (!ASSISTANT_TOOLS.includes(tool)) return null;
  return {
    tool,
    say: str(json.say, 400),
    args: json.args && typeof json.args === 'object' ? json.args : {},
    spends: ASSISTANT_SPEND.includes(tool),
    clientJob: ASSISTANT_CLIENT_JOBS.includes(tool) ? tool : null,
  };
}

export function nextAutoStep(state) {
  const st = state || {};
  if (!st.hasAudio) return { tool: null, spends: false, clientJob: null, say: '先上传一首歌，我再继续。' };
  if (!st.hasAnalysis) return { tool: 'analyze', spends: false, clientJob: 'analyze', say: '我先听完整首。这一步不生成画面。' };
  if (!st.confirmed) return { tool: 'confirm_sections', spends: false, clientJob: null, say: '分段按现在的边界确认。切开的理由写在每一段上。' };
  if (!st.hasPackage) return { tool: 'build_timeline', spends: false, clientJob: null, args: { style: st.styleText || '' }, say: '按分析和你的风格铺时间轴，先不生成视频。' };
  return { tool: 'generate', spends: true, clientJob: 'generate', args: { scope: 'all' }, say: '时间轴已经铺好。生成视频要花钱，请确认后再跑。' };
}

export function decideAssistantAction({ message, state, modelText }) {
  const parsed = parseAssistantAction(modelText);
  if (parsed && parsed.tool) return parsed;
  const text = String(message || '').trim();
  const st = state || {};
  const idx = shotIndexFromMessage(text);
  if (/自动|帮我做完|一路做|继续/.test(text)) return nextAutoStep(st);
  if (/听歌|开始分析|分析这首|分析歌曲|分析一下/.test(text)) return { tool: 'analyze', spends: false, clientJob: 'analyze', say: '我来听整首。分析不生成画面。' };
  if (/确认分段|分段可以|就按这个分/.test(text)) return { tool: 'confirm_sections', spends: false, clientJob: null, say: '分段按现在的边界确认。' };
  if (/导入原片|翻拍|复刻/.test(text)) return { tool: 'remix', spends: false, clientJob: 'remix', say: '复刻需要你选原片。选好后我按切点铺，生成前会再问你。' };
  if (idx != null && /太长|太短|不好|重做|换成|改一下|有问题|穿帮/.test(text)) {
    return { tool: 'edit_shot', spends: false, clientJob: null, args: { sceneIndex: idx, shotIndex: 0, complaint: text }, say: '我只改第 ' + (idx + 1) + ' 段的提示词，先不生成。你确认后才重跑这一段。' };
  }
  if (/生成全部|全部生成|都生成/.test(text)) return { tool: 'generate', spends: true, clientJob: 'generate', args: { scope: 'all' }, say: '生成视频要花钱。' };
  if (/合成|成片/.test(text)) return { tool: 'compose', spends: true, clientJob: 'compose', args: {}, say: '合成成片会跑视频。' };
  if (idx != null && /生成/.test(text)) return { tool: 'generate', spends: true, clientJob: 'generate', args: { scope: 'one', sceneIndex: idx }, say: '只生成这一段，请确认。' };
  if (/推到画布|落到画布/.test(text)) return { tool: 'push', spends: false, clientJob: 'push', say: '我把时间轴铺到画布，先不跑生成。' };
  if (/时间轴|分镜/.test(text)) return { tool: 'build_timeline', spends: false, clientJob: null, args: { style: st.styleText || text }, say: '按当前分析和风格铺时间轴，这一步不生成视频。' };
  if (/风格|搞笑|做成|我想要|换成/.test(text)) return { tool: 'set_style', spends: false, clientJob: null, args: { style: text }, say: '风格记下了。生成视频之前会先请你确认。' };
  return { tool: null, spends: false, clientJob: null, say: '可以说：开始分析、确认分段、生成时间轴，或指出第几段要改。生成视频前我会先请你确认。' };
}

export function gateAssistantAction(action, opts) {
  const confirmed = !!(opts && opts.confirmed);
  if (!action || !action.tool) return { allow: true, needsConfirm: false, say: action && action.say };
  if (action.spends && !confirmed) return { allow: false, needsConfirm: true, say: action.say || '这一步会生成视频，请确认。' };
  return { allow: true, needsConfirm: false, say: action.say };
}

export function spendPreview(state, action) {
  const scenes = (state && state.mvPackage && state.mvPackage.scenes) || [];
  const scope = action && action.args && action.args.scope;
  let list = scenes;
  if (scope === 'one') {
    const i = Number(action.args && action.args.sceneIndex) || 0;
    list = scenes[i] ? [scenes[i]] : [];
  }
  const seconds = Math.round(list.reduce((s, sc) => s + (Number(sc.duration) || 0), 0) * 10) / 10;
  return { count: list.length, seconds, scope: scope || 'all' };
}

export function applyAssistantAction(state, action) {
  const next = JSON.parse(JSON.stringify(state || {}));
  const a = action || {};
  const args = a.args || {};
  if (a.tool === 'set_style') {
    next.styleText = str(args.style || '', 400);
  } else if (a.tool === 'confirm_sections') {
    if (next.analysis && next.analysis.sections) next.analysis.sections = sectionCutReasons(next.analysis.sections, next.analysis);
    next.confirmed = true;
    next.hasAnalysis = !!next.analysis;
  } else if (a.tool === 'build_timeline') {
    if (!next.analysis) throw new Error('还没有分析');
    const style = str(args.style || next.styleText || '', 400);
    if (style) next.styleText = style;
    next.mvPackage = planMusicVideoPackage(next.analysis, { style: next.styleText, brief: next.styleText });
    next.hasPackage = true;
  } else if (a.tool === 'edit_shot') {
    if (!next.mvPackage) throw new Error('还没有时间轴');
    next.mvPackage = reviseShotPrompt(next.mvPackage, Number(args.sceneIndex) || 0, Number(args.shotIndex) || 0, args.complaint || '');
  } else if (a.tool === 'adjust_sections') {
    if (!next.analysis) throw new Error('还没有分析');
    if (args.op === 'move') next.analysis.sections = moveSectionBoundary(next.analysis.sections, Number(args.index) || 0, args.edge === 'start' ? 'start' : 'end', args.timeSec, next.analysis.beats);
    next.confirmed = false;
  }
  return next;
}

export function runMvAssistantTurn({ message, state, modelText, confirmed }) {
  const action = decideAssistantAction({ message, state, modelText });
  const gate = gateAssistantAction(action, { confirmed });
  if (!gate.allow) {
    return {
      ok: true,
      say: gate.say,
      needsConfirm: true,
      pending: action,
      preview: action && action.spends ? spendPreview(state, action) : null,
      executed: null,
      state,
    };
  }
  if (!action.tool) return { ok: true, say: action.say, executed: null, needsConfirm: false, state };
  if (action.clientJob) {
    return { ok: true, say: action.say, clientJob: action.clientJob, args: action.args || {}, executed: action.tool, needsConfirm: false, state };
  }
  const next = applyAssistantAction(state, action);
  return { ok: true, say: action.say, executed: action.tool, needsConfirm: false, state: next };
}

/** 画布助手一轮里最多连续执行这么多步免费工具，避免模型死循环。 */
export const CANVAS_ASSISTANT_MAX_STEPS = 4;

/** 与 Host 已注册的 canvas_* 工具同名。画布助手只调度这些，不另起一套。 */
export const CANVAS_TOOL_NAMES = [
  'canvas_create_node',
  'canvas_update_node',
  'canvas_write_node',
  'canvas_connect',
  'canvas_delete_node',
  'canvas_run_node',
  'canvas_analyze_audio',
  'canvas_music_timeline',
  'canvas_music_timeline_edit',
  'canvas_music_video',
  'canvas_music_remix',
  'canvas_relayout',
];

const CANVAS_TYPE_LABEL = {
  image: '图片节点',
  video: '视频节点',
  audio: '音频节点',
  text: '文本节点',
  script: '剧本节点',
  storyboard: '分镜节点',
  finalcut: '成片节点',
};

export function nodeTypeLabel(type) {
  return CANVAS_TYPE_LABEL[type] || (type ? String(type) + '节点' : '节点');
}

/** 给模型看的整张画布摘要：节点类型、关键状态、连线、当前选择。 */
export function canvasDigest(graph, selection) {
  const sel = new Set(selection || []);
  const all = Object.values((graph && graph.nodes) || {}).filter(Boolean);
  const nodes = all.slice(0, 60).map((n) => {
    const d = n.data || {};
    return {
      id: n.id,
      type: n.type,
      label: String(d.label || '').slice(0, 40),
      status: d.status || '',
      hasAsset: !!(d.assetId || d.url),
      assetId: d.assetId || '',
      mvRole: d.mvRole || '',
      mvFrom: d.mvFrom || '',
      refName: d.refName || '',
      refLock: !!d.refLock,
      needRegen: !!d.needRegen,
      duration: d.duration || d.durationSec || null,
      count: d.count || null,
      model: d.imageModel || d.videoModel || d.model || '',
      prompt: String(d.prompt || d.idea || d.text || d.script || '').slice(0, 100),
      failure: d.adapt && d.adapt.kind ? { kind: d.adapt.kind, say: String(d.adapt.say || '').slice(0, 160), change: String(d.adapt.change || '').slice(0, 80) } : null,
      job: d.job && d.job.status ? { kind: d.job.kind || '', status: d.job.status, line: String(d.job.line || '').slice(0, 160) } : null,
      selected: sel.has(n.id),
    };
  });
  const edges = ((graph && graph.edges) || []).slice(0, 80).map((e) => ({
    id: e.id, from: e.fromNode, to: e.toNode, fromPort: e.fromPort || '', toPort: e.toPort || '',
  }));
  return {
    nodeCount: all.length,
    nodes,
    edges,
    selection: nodes.filter((n) => n.selected),
  };
}

export function canvasContextChip(digest, scopeId) {
  const sel = (digest && digest.selection) || [];
  const node = sel[0] || ((digest && digest.nodes) || []).find((n) => n.id === scopeId);
  if (!node) return '';
  return '当前：' + (node.label || node.id) + ' ' + nodeTypeLabel(node.type);
}

export function canvasToolSpecs() {
  const fn = (name, description, properties, required) => ({
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required: required || [], additionalProperties: false },
    },
  });
  return [
    fn('canvas_create_node', '新建节点', { type: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' } }, ['type']),
    fn('canvas_update_node', '修改已有节点的提示词或正文', { nodeId: { type: 'string' }, patch: { type: 'object' } }, ['nodeId', 'patch']),
    fn('canvas_write_node', '把正文写进文本、剧本或分镜节点', { nodeId: { type: 'string' }, text: { type: 'string' } }, ['nodeId', 'text']),
    fn('canvas_connect', '连接两个节点', { fromNode: { type: 'string' }, toNode: { type: 'string' } }, ['fromNode', 'toNode']),
    fn('canvas_delete_node', '删除节点。调用前必须先让用户确认。', { nodeId: { type: 'string' } }, ['nodeId']),
    fn('canvas_run_node', '运行节点。图片、视频、成片会花钱，调用前必须先让用户确认。', { nodeId: { type: 'string' } }, ['nodeId']),
    fn('canvas_analyze_audio', '用音频理解分析歌曲', { nodeId: { type: 'string' } }, ['nodeId']),
    fn('canvas_music_timeline', '按分析结果铺 MV 时间轴', { nodeId: { type: 'string' }, style: { type: 'string' } }, ['nodeId']),
    fn('canvas_music_timeline_edit', '修改时间轴上的一场', { nodeId: { type: 'string' }, sceneIndex: { type: 'number' }, complaint: { type: 'string' } }, ['nodeId']),
    fn('canvas_music_video', '把音乐时间轴推到画布', { nodeId: { type: 'string' } }, ['nodeId']),
    fn('canvas_music_remix', '按复刻/角色替换铺时间轴，不直接生成视频', { nodeId: { type: 'string' }, style: { type: 'string' } }, ['nodeId']),
    fn('canvas_relayout', '重新排列画布节点', {}),
  ];
}

export function canvasAssistantSystem() {
  return [
    '你是这张无限画布的助手，负责整张画布，而不是某一个节点里的面板。',
    '你可以操作文本、剧本、分镜、图片、视频、音频和成片节点。',
    '用户说「这个」或 this 时，指的是摘要里 selected 为 true 的节点。',
    '新建、改字、连线、分析歌曲、铺时间轴、推到画布可以直接做。',
    '生成图片、生成视频、成片合成、删除节点必须先停下来等用户确认，不要连续调用。',
    '节点失败时先看 failure：说明原因，并按其中的改动再生成。余额不足或密钥无效不要重试。',
    '一次只调用一个工具。没有工具要调用时，用一句中文回答。',
    '摘要里的 job 是这个节点正在做的事。status 不是 done 时，不要说分析完、时间轴铺好或已经生成。工具回执写了还在进行，就原样告诉用户。',
  ].join('\n');
}

function digestNode(digest, id) {
  return ((digest && digest.nodes) || []).find((n) => n.id === id) || null;
}

export function canvasActionCost(name, args, digest) {
  if (name === 'canvas_delete_node') return { spends: false, destructive: true };
  if (name === 'canvas_run_node') {
    const id = args && (args.nodeId || args.id);
    const node = digestNode(digest, id) || ((digest && digest.selection) || [])[0] || null;
    const type = node && node.type;
    if (type === 'audio' || type === 'text' || type === 'script' || type === 'storyboard') {
      return { spends: false, destructive: false, type };
    }
    return { spends: true, destructive: false, type: type || '' };
  }
  return { spends: false, destructive: false };
}

export function canvasSpendPreview(digest, action, modelLabel) {
  const id = action && action.args && action.args.nodeId;
  const node = digestNode(digest, id) || ((digest && digest.selection) || [])[0] || null;
  const type = (action && action.type) || (node && node.type) || '';
  const model = (node && node.model) || modelLabel || '';
  if (action && action.destructive) return { kind: 'delete', count: 1, nodeId: id || (node && node.id) || '' };
  if (type === 'image') return { kind: 'image', count: Number(node && node.count) || 1, model };
  if (type === 'video') return { kind: 'video', count: 1, seconds: node && node.duration, model };
  if (type === 'finalcut' || type === '') return { kind: type === 'finalcut' ? 'compose' : 'run', count: 1, seconds: node && node.duration, model };
  return { kind: 'run', count: 1, model };
}

export function canvasPreviewLine(preview) {
  const p = preview || {};
  if (p.kind === 'delete') return '将删除 ' + (p.count || 1) + ' 个节点';
  if (p.kind === 'compose') return '将合成成片' + (p.model ? ' · ' + p.model : '');
  if (p.kind === 'image') return '将生成图片 ' + (p.count || 1) + ' 张' + (p.model ? ' · ' + p.model : '');
  if (p.kind === 'video') return '将生成视频 ' + (p.count || 1) + ' 条 · ' + (p.seconds || '?') + 's' + (p.model ? ' · ' + p.model : '');
  return '需要确认后才会执行';
}

export function gateCanvasAction(action, opts) {
  if (action && (action.clientJob === 'regen-failed' || action.clientJob === 'gen-refs' || action.clientJob === 'gen-shots' || action.clientJob === 'gen-videos')) {
    if (action.spends && !(opts && opts.confirmed)) {
      const count = (action.args && action.args.count) || 1;
      return { allow: false, say: '将按失败原因重生成 ' + count + ' 项。', preview: { kind: 'run', count, model: (opts && opts.modelLabel) || '' } };
    }
    return { allow: true, say: action.say || '' };
  }
  if (!action || !action.tool) return { allow: true, say: (action && action.say) || '' };
  const digest = opts && opts.digest;
  const cost = canvasActionCost(action.tool, action.args, digest);
  action.spends = cost.spends;
  action.destructive = cost.destructive;
  if ((cost.spends || cost.destructive) && !(opts && opts.confirmed)) {
    const preview = canvasSpendPreview(digest, { ...action, ...cost }, opts && opts.modelLabel);
    return { allow: false, say: canvasPreviewLine(preview), preview };
  }
  return { allow: true, say: action.say || '' };
}

/** 从非流式 JSON 或 SSE 增量里收集 OpenAI tool_calls。 */
export function extractToolCalls(raw) {
  const text = String(raw || '');
  const calls = [];
  const push = (name, argsText, id) => {
    if (!name) return;
    let args = {};
    if (argsText && typeof argsText === 'object') args = argsText;
    else {
      try { args = JSON.parse(argsText || '{}'); } catch { args = {}; }
    }
    calls.push({ name: String(name), args, id: id || '' });
  };
  try {
    const j = JSON.parse(text);
    const tc = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.tool_calls;
    if (Array.isArray(tc) && tc.length) {
      for (const t of tc) push(t.function && t.function.name, t.function && t.function.arguments, t.id);
      return calls;
    }
  } catch { /* 流式文本 */ }
  const acc = {};
  for (const line of text.split('\n')) {
    const s = line.trim().replace(/^data:\s*/, '');
    if (!s || s === '[DONE]' || s[0] !== '{') continue;
    let j = null;
    try { j = JSON.parse(s); } catch { continue; }
    const delta = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
    const tcs = delta && delta.tool_calls;
    if (!Array.isArray(tcs)) continue;
    for (const t of tcs) {
      const i = t.index == null ? 0 : t.index;
      acc[i] = acc[i] || { name: '', args: '', id: '' };
      if (t.id) acc[i].id = t.id;
      if (t.function && t.function.name) acc[i].name += t.function.name;
      if (t.function && t.function.arguments) acc[i].args += t.function.arguments;
    }
  }
  for (const t of Object.values(acc)) push(t.name, t.args, t.id);
  return calls;
}

export function parseCanvasAction(text) {
  const calls = extractToolCalls(text).filter((c) => CANVAS_TOOL_NAMES.includes(c.name));
  if (calls.length) return { tool: calls[0].name, args: calls[0].args || {}, say: '', native: true };
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const tool = String(o.tool || o.name || '');
    if (!CANVAS_TOOL_NAMES.includes(tool)) return null;
    const args = (o.args && typeof o.args === 'object') ? o.args : {};
    return { tool, args, say: String(o.say || ''), native: false };
  } catch { return null; }
}

function selectedOrScope(digest, scopeId) {
  const sel = (digest && digest.selection) || [];
  if (sel.length) return sel[0];
  return ((digest && digest.nodes) || []).find((n) => n.id === scopeId) || null;
}

function audioNode(digest, scopeId) {
  const target = selectedOrScope(digest, scopeId);
  if (target && target.type === 'audio') return target;
  return ((digest && digest.nodes) || []).find((n) => n.type === 'audio') || null;
}

/** 模型没有给出工具时的直白指令。选中节点就是「这个」。 */
export function keywordCanvasAction(message, digest, scopeId) {
  const text = String(message || '');
  const target = selectedOrScope(digest, scopeId);
  if (/生成全部|生成当前|到结尾|分镜图|出分镜/.test(text)) {
    const audio = audioNode(digest, scopeId);
    const kids = ((digest && digest.nodes) || []).filter((n) => audio && n.mvFrom === audio.id);
    if (!kids.length) return { tool: '', say: '先把时间轴推到画布，再生成角色和场景设定。' };
    const progress = refProgress(kids.map((n) => ({ role: n.mvRole, name: n.refName, assetId: n.assetId, locked: n.refLock })));
    const missingRefs = (progress.characters.total - progress.characters.have) + (progress.locations.total - progress.locations.have);
    if (missingRefs > 0) {
      return { tool: '', clientJob: 'gen-refs', spends: true, args: { count: missingRefs, audioId: audio && audio.id }, say: '先生成角色和场景设定，共 ' + missingRefs + ' 张。定稿之后才能出分镜。' };
    }
    if (progress.characters.locked < progress.characters.total || progress.locations.locked < progress.locations.total) {
      return { tool: '', say: '角色和场景图还没定稿。定稿后才能生成分镜。角色 ' + progress.characters.locked + '/' + progress.characters.total + '，场景 ' + progress.locations.locked + '/' + progress.locations.total + '。' };
    }
    if (progress.shots.have < progress.shots.total) {
      const n = progress.shots.total - progress.shots.have;
      return { tool: '', clientJob: 'gen-shots', spends: true, args: { count: n, audioId: audio && audio.id }, say: '角色和场景已定稿，将生成分镜图 ' + n + ' 张。' };
    }
    if (/视频|全部|到结尾/.test(text) && progress.videos.have < progress.videos.total) {
      const n = progress.videos.total - progress.videos.have;
      return { tool: '', clientJob: 'gen-videos', spends: true, args: { count: n, audioId: audio && audio.id }, say: '分镜图已齐，将生成视频 ' + n + ' 段。' };
    }
  }
  if (/为什么失败|失败原因/.test(text)) {
    const f = target && target.failure;
    if (!f) return { tool: '', say: '当前没有失败记录。' };
    return { tool: '', say: [f.say, f.change].filter(Boolean).join(' ') };
  }
  const failed = ((digest && digest.nodes) || []).filter((n) => n && (n.status === 'error' || n.failure));
  if (/重生成失败|失败项/.test(text) || (/继续自动/.test(text) && failed.length)) {
    if (!failed.length) return { tool: '', say: '没有失败项。' };
    const costly = failed.filter((n) => n.type === 'image' || n.type === 'video' || n.type === 'finalcut');
    const first = failed[0].failure;
    return {
      tool: '',
      clientJob: 'regen-failed',
      spends: costly.length > 0,
      args: { count: failed.length },
      say: '按上次的失败原因重跑 ' + failed.length + ' 项。' + (first && first.change ? (' ' + first.change) : ''),
    };
  }
  if (/删除|删掉|delete/i.test(text)) {
    if (!target) return { tool: '', say: '先选中要删除的节点。' };
    return { tool: 'canvas_delete_node', args: { nodeId: target.id }, say: '准备删除这个节点。' };
  }
  if (/复刻|替换角色|remix/i.test(text)) {
    const audio = audioNode(digest, scopeId);
    if (!audio) return { tool: '', say: '先放上或选中一个音频节点。' };
    return { tool: 'canvas_music_remix', args: { nodeId: audio.id, style: text.slice(0, 200) }, say: '按复刻铺时间轴，先不生成视频。' };
  }
  if (/分析|听歌|analyze/i.test(text)) {
    const audio = audioNode(digest, scopeId);
    if (!audio) return { tool: '', say: '画布上还没有音频节点。' };
    return { tool: 'canvas_analyze_audio', args: { nodeId: audio.id }, say: '开始分析这首歌。' };
  }
  if (/时间轴|timeline/i.test(text)) {
    const audio = audioNode(digest, scopeId);
    if (!audio) return { tool: '', say: '先选中或放上音频节点。' };
    return { tool: 'canvas_music_timeline', args: { nodeId: audio.id, style: text.slice(0, 200) }, say: '按这首歌铺时间轴。' };
  }
  if (/推到画布|铺到画布/.test(text)) {
    const audio = audioNode(digest, scopeId);
    if (!audio) return { tool: '', say: '先选中音频节点。' };
    return { tool: 'canvas_music_video', args: { nodeId: audio.id }, say: '把时间轴推到画布。' };
  }
  if (/生成|出图|出视频|合成|compose|generate/i.test(text)) {
    if (!target) return { tool: '', say: '先选中要运行的节点。' };
    return { tool: 'canvas_run_node', args: { nodeId: target.id }, say: '准备运行这个节点。' };
  }
  if (/改提示词|改成|写成|改为/.test(text)) {
    if (!target) return { tool: '', say: '先选中要改的节点。' };
    const prompt = text.replace(/^[\s\S]*?(改成|写成|改为)/, '').trim() || text;
    const field = target.type === 'text' ? 'text' : target.type === 'script' ? 'script' : 'prompt';
    const patch = {};
    patch[field] = prompt;
    return { tool: 'canvas_update_node', args: { nodeId: target.id, patch }, say: '已改这个节点。' };
  }
  if (/新建|创建|加一个|加个/.test(text)) {
    const type = /视频/.test(text) ? 'video'
      : /图片/.test(text) ? 'image'
        : /剧本/.test(text) ? 'script'
          : /分镜/.test(text) ? 'storyboard'
            : /文本/.test(text) ? 'text'
              : /成片/.test(text) ? 'finalcut'
                : /音频|音乐/.test(text) ? 'audio'
                  : '';
    if (!type) return { tool: '', say: '说一下要新建哪种节点。' };
    return { tool: 'canvas_create_node', args: { type }, say: '新建一个' + nodeTypeLabel(type) + '。' };
  }
  if (/连接|连线/.test(text)) {
    const sel = (digest && digest.selection) || [];
    if (sel.length < 2) return { tool: '', say: '选中两个节点再让我连线。' };
    return { tool: 'canvas_connect', args: { fromNode: sel[0].id, toNode: sel[1].id }, say: '把选中的节点连起来。' };
  }
  return null;
}

/** 帧差序列 → 切点（秒）。阈值用相邻帧平均绝对差，间隔至少 0.8 秒。 */
export function cutsFromDiffs(diffs, hopSec, threshold) {
  const hop = Math.max(0.05, num(hopSec, 0.5));
  const th = num(threshold, 0.18);
  const cuts = [0];
  for (let i = 1; i < (diffs || []).length; i++) {
    const t = round3(i * hop);
    if (Number(diffs[i]) >= th && t - cuts[cuts.length - 1] >= 0.8) cuts.push(t);
  }
  return cuts;
}

/**
 * 长片连贯：同一场景的连续场共享地点参考与光线，场与场之间标明硬切或续帧。
 * 风格锁写进每一镜提示词。已有 join / refs 不被覆盖。
 */
export function applyContinuity(pkg, opts) {
  const next = JSON.parse(JSON.stringify(pkg || {}));
  const lock = str((opts && opts.styleLock) || (next.continuity && next.continuity.styleLock) || (next.treatment && next.treatment.styleAnchor), 200);
  next.continuity = { styleLock: lock, seed: (next.continuity && next.continuity.seed) || null };
  const marker = '【风格锁】';
  let prevLoc = '';
  (next.scenes || []).forEach((sc, si) => {
    const loc = (sc.shots && sc.shots[0] && sc.shots[0].scene) || ((next.locations || [])[0] && next.locations[0].name) || '';
    if (sc.join !== 'cut' && sc.join !== 'continuous') sc.join = sc.continued ? 'continuous' : 'cut';
    if (loc) prevLoc = loc;
    if (!sc.refs) {
      sc.refs = {
        characters: (next.characters || []).map((c) => c.name),
        locations: loc ? [loc] : (next.locations || []).map((c) => c.name).slice(0, 1),
        props: (next.props || []).map((c) => c.name),
      };
    }
    sc.group = (sc.refs.locations && sc.refs.locations[0]) || sc.sectionLabel || 'scene';
    for (const sh of sc.shots || []) {
      sh.transition = sc.join;
      if (lock && !String(sh.videoPrompt || '').includes(marker)) sh.videoPrompt = (sh.videoPrompt || sh.visual || '') + ' ' + marker + lock;
      if (lock && sh.imagePrompt && !String(sh.imagePrompt).includes(marker)) sh.imagePrompt += ' ' + marker + lock;
    }
  });
  return next;
}

/**
 * 看供应商描述决定翻拍走哪条路。没有视频到视频的通用请求体时，即使扩展参数提到视频编辑，
 * 也只记录这条能力，实际仍用关键帧 + 参考图（见返回的 note）。
 */
export function detectRemixCapabilities(hint) {
  const h = hint || {};
  const blob = [h.imageMode, h.videoExtra, h.videoProtocol, h.note].map((x) => String(x || '')).join(' ').toLowerCase();
  const videoToVideo = /v2v|video[-_ ]?to[-_ ]?video|video[-_ ]?edit|参考视频|视频编辑/.test(blob);
  const imageEdit = String(h.imageMode || '') === 'edits' || /images\/edits|image[-_ ]?edit/.test(blob);
  if (videoToVideo) {
    return {
      path: 'video-to-video',
      videoToVideo: true,
      imageEdit,
      referenceToVideo: true,
      note: '扩展参数提到视频编辑，但本插件没有通用的视频到视频请求。这一场改用原镜关键帧作首帧、替换角色作参考图，提示词按翻拍来写。',
    };
  }
  if (imageEdit) {
    return {
      path: 'first-frame-edit',
      videoToVideo: false,
      imageEdit: true,
      referenceToVideo: true,
      note: '图片供应商是编辑模式：先在原镜关键帧上换成新角色，再拿这张图做首帧生成视频。',
    };
  }
  return {
    path: 'reference-to-video',
    videoToVideo: false,
    imageEdit: false,
    referenceToVideo: true,
    note: '按参考图重拍：替换角色的设定图和原镜关键帧一起进视频节点，时长仍卡在原切点上。',
  };
}

/** 原片切点铺成翻拍时间轴。keep 里的场不生成，只留在参考轨。 */
export function buildRemixPackage(analysis, opts) {
  const o = opts || {};
  const dur = Math.max(4, num(o.durationSec, analysis && analysis.durationSec) || 60);
  const a = normalizeAnalysis(analysis || { durationSec: dur, summary: o.style || '' }, { durationSec: dur, source: 'local-fallback', method: 'mock' });
  const allowed = normalizeDurations(o.allowedDurations);
  const clipMax = allowed.length ? allowed[allowed.length - 1] : 15;
  let cuts = (o.cuts || []).map((t) => num(t, NaN)).filter((t) => t > 0.3 && t < dur - 0.3).sort((x, y) => x - y);
  if (!cuts.length) {
    for (let t = 8; t < dur - 2; t += 8) cuts.push(round3(t));
  }
  const bounds = [0].concat(cuts, [dur]);
  const ranges = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    let t = bounds[i];
    while (t < bounds[i + 1] - 0.05) {
      const e = Math.min(bounds[i + 1], t + clipMax);
      ranges.push([round3(t), round3(e)]);
      t = e;
    }
  }
  const caps = detectRemixCapabilities(o.provider);
  const style = str(o.style, 240) || '恶搞翻拍，人物替换';
  const who = str((o.replacements && o.replacements[0] && (o.replacements[0].name || o.replacements[0].to)) || '替换角色', 40);
  const descriptions = o.descriptions || [];
  const keep = new Set((o.keep || []).map((n) => Number(n)));
  const scenes = ranges.map(([s0, s1], i) => {
    const desc = str(descriptions[i] || '沿用原镜构图、机位和动作', 300);
    const shot = {
      title: '原镜 ' + (i + 1),
      duration: round3(s1 - s0),
      startSec: s0,
      endSec: s1,
      sectionLabel: 'verse',
      seg: i === 0 ? 'opening' : 'scene_change',
      visual: desc,
      motion: '起点：沿原镜构图 → 保持机位与运动方向 → 终点：停在原镜切点之前',
      camera: '景别跟随原镜；机位跟随原镜；运镜跟随原镜',
      light: '沿用原镜光线',
      imagePrompt: '把关键帧中的人物换成 @' + who + '@，保留构图、背景和机位。' + desc + '。' + style,
      videoPrompt: round1(s1 - s0) + '秒。按原镜重拍，人物换成 @' + who + '@。' + desc + '。' + style + '。切点在 ' + round1(s0) + 's。',
      characters: [who],
      scene: '原片场景',
      props: [],
      dialogue: [],
      tail: '动作进行到一半',
      cam: '跟随原镜',
      start: i === 0 ? '原片第 0 秒' : '',
      timeBeats: ['0s 起势'],
      sfx: '原曲声轨',
      negative: 'wrong identity, extra people, extra limbs, watermark',
      cutAt: s0,
    };
    return {
      index: i + 1,
      title: '原镜 ' + (i + 1),
      sectionLabel: 'verse',
      startSec: s0,
      endSec: s1,
      duration: shot.duration,
      continued: false,
      keep: keep.has(i),
      genMode: keep.has(i) ? 'keep' : caps.path,
      capabilityPath: caps.path,
      capabilityNote: caps.note,
      sourceNote: desc,
      sourceKeyframeAssetId: ((o.keyframes || []).find((f) => Number(f.index) === i) || {}).assetId || null,
      shots: [shot],
    };
  });
  return stampGeneration(applyContinuity(decorateMusicPackage({
    schema: 'dshic.mv-package.v1',
    remix: true,
    durationSec: dur,
    bpm: a.bpm,
    source: a.source,
    maxClipSeconds: 15,
    treatment: { title: '翻拍', logline: style, style, styleAnchor: style.slice(0, 80) },
    continuity: { styleLock: style.slice(0, 80), seed: null },
    characters: [personFromRaw({ name: who, desc: style, role: '替换进原片的人' }, null)],
    locations: [{ name: '原片场景', desc: '来自原 MV', imagePrompt: presentImagePrompt('场景，原片场景。保留原镜的空间和光线。不要出现人物。') }],
    props: [],
    downbeats: a.downbeats || [],
    scenes,
    ...(allowed.length ? { genDefaults: { allowedDurations: allowed, model: null, resolution: null } } : {}),
    warnings: [caps.note],
  }, a), { styleLock: style.slice(0, 80) }));
}

export function stampGeneration(pkg) {
  const next = JSON.parse(JSON.stringify(pkg || {}));
  const allowed = next.genDefaults && next.genDefaults.allowedDurations;
  for (const sc of next.scenes || []) {
    const fit = snapGenerationDuration(sc.duration, allowed);
    const prev = sc.gen && typeof sc.gen === 'object' ? sc.gen : {};
    sc.gen = {
      status: prev.stale ? 'stale' : (prev.status || 'idle'),
      assetId: prev.assetId || null,
      actualSec: prev.actualSec == null ? null : num(prev.actualSec, 0),
      history: Array.isArray(prev.history) ? prev.history.slice(-8) : [],
      stale: !!prev.stale,
      requestSec: fit.requestSec,
      slotSec: fit.slotSec,
      warn: fit.warn || '',
    };
  }
  return next;
}

function sectionLine(sec) {
  const visual = str(sec && sec.visual, 120);
  if (visual) return visual;
  const role = sectionLabelZh((sec && sec.label) || 'unknown');
  const bits = [];
  if (sec && sec.mood) bits.push(str(sec.mood, 40));
  if (sec && sec.instruments && sec.instruments.length) bits.push(sec.instruments.slice(0, 3).join('、'));
  return bits.length ? (role + '：' + bits.join('，')) : role;
}

function buildMusicScript(pkg, analysis) {
  const a = analysis || {};
  const lines = [];
  if (pkg.bpm) lines.push('[Tempo Lock - ' + pkg.bpm + ' BPM]');
  const sections = pkg.sections || [];
  const lyrics = a.lyrics || [];
  if (!sections.length) {
    lines.push('[Structure]');
    if (pkg.treatment && pkg.treatment.logline) lines.push(pkg.treatment.logline);
    return lines.join('\n');
  }
  for (const sec of sections) {
    lines.push('[' + sectionLabelZh(sec.label) + ' ' + round1(sec.startSec) + '-' + round1(sec.endSec) + 's]');
    if (sec.line) lines.push(sec.line);
    for (const ly of lyrics) {
      const mid = (num(ly.startSec, 0) + num(ly.endSec, 0)) / 2;
      if (mid >= sec.startSec && mid < sec.endSec && ly.text) lines.push(String(ly.text));
    }
  }
  return lines.join('\n');
}

/**
 * 把听歌结果补成可排片的包：段落一句说明、剧本标签、角色面孔与选角、场景主图/多视角、
 * 镜头内时间码、字幕轨。没有角色就不写人数锁，表演或抽象 MV 照样能铺。
 * 模型名和分辨率留空，生成时用用户当前配置的供应商。
 */
export function decorateMusicPackage(pkg, analysis) {
  const next = JSON.parse(JSON.stringify(pkg || {}));
  const a = analysis || {};
  const stylePrefix = str((next.treatment && (next.treatment.styleAnchor || next.treatment.style)) || '', 200);
  next.stylePrefix = stylePrefix;
  next.genDefaults = {
    model: null,
    resolution: null,
    allowedDurations: (next.genDefaults && next.genDefaults.allowedDurations) || null,
  };
  next.characters = (next.characters || []).map((c, i) => ({
    ...c,
    appearance: c.appearance || c.desc || '',
    faceId: c.faceId || ('face:' + (i + 1) + ':' + (c.name || i)),
    castingCount: Number(c.castingCount) > 0 ? Number(c.castingCount) : 1,
  }));
  next.locations = (next.locations || []).map((loc) => ({
    ...loc,
    mainPrompt: loc.mainPrompt || ('场景图，' + (loc.name || '') + '。' + (loc.desc || '') + (stylePrefix ? ('。风格：' + stylePrefix) : '') + '。不要出现角色。'),
    multiViewPrompt: loc.multiViewPrompt || ((loc.name || '场景') + '，同一空间的多视角，不要出现角色。' + (stylePrefix ? ('风格：' + stylePrefix) : '')),
    hasMain: !!loc.hasMain,
    hasMultiView: !!loc.hasMultiView,
  }));
  const fromAnalysis = (a.sections || []).filter((s) => s && s.endSec > s.startSec && s.label && s.label !== 'unknown');
  if (fromAnalysis.length) {
    next.sections = fromAnalysis.map((s, i) => ({
      id: s.id || ('sec' + (i + 1)),
      label: s.label || 'unknown',
      startSec: round3(num(s.startSec, 0)),
      endSec: round3(num(s.endSec, 0)),
      line: sectionLine(s),
    }));
  } else {
    const groups = [];
    for (const sc of next.scenes || []) {
      const last = groups[groups.length - 1];
      if (last && last.label === sc.sectionLabel) last.endSec = sc.endSec;
      else groups.push({ id: 'sec' + (groups.length + 1), label: sc.sectionLabel || 'unknown', startSec: sc.startSec, endSec: sc.endSec, line: sectionLine({ label: sc.sectionLabel }) });
    }
    next.sections = groups;
  }
  const names = next.characters.map((c) => c.name).filter(Boolean);
  const lock = names.length
    ? ('已绑定角色各只出现一人：' + names.map((n) => n + '×1').join('、') + '。不要多出同名的人。')
    : '';
  for (const sc of next.scenes || []) {
    const parts = [];
    let t = 0;
    for (const sh of sc.shots || []) {
      const dur = num(sh.duration, 0);
      parts.push(round1(t) + '-' + round1(t + dur) + 's: ' + str(sh.visual || sh.motion || sh.camera, 180));
      t += dur;
      sh.genSettings = { model: null, resolution: null, duration: sh.duration };
      if (lock && !String(sh.videoPrompt || '').includes('各只出现一人')) sh.videoPrompt = (sh.videoPrompt || '') + ' ' + lock;
      const head = stylePrefix.slice(0, 16);
      if (stylePrefix && sh.imagePrompt && head && !sh.imagePrompt.includes(head)) sh.imagePrompt = stylePrefix + '。' + sh.imagePrompt;
    }
    sc.narrative = (sc.shots || []).map((sh) => sh.visual).filter(Boolean).join('');
    sc.timecode = parts.join(' [cut] ');
    if (sc.shots && sc.shots[0] && parts[0] && !String(sc.shots[0].videoPrompt || '').includes(parts[0].slice(0, 6))) {
      sc.shots[0].videoPrompt = sc.timecode + '。' + (sc.shots[0].videoPrompt || '');
    }
  }
  next.script = buildMusicScript(next, a);
  next.subtitleTrack = (a.lyrics || []).map((l, i) => ({
    id: 'sub' + (i + 1),
    startSec: num(l.startSec, 0),
    endSec: num(l.endSec, 0),
    text: str(l.text, 200),
  })).filter((l) => l.text && l.endSec > l.startSec);
  next.burnSubtitles = false;
  next.stages = [
    { id: 'writer', name: '编剧', status: 'done' },
    { id: 'cast', name: '角色设计师', status: names.length ? 'ready' : 'skip' },
    { id: 'scene', name: '场景设计师', status: (next.locations || []).length ? 'ready' : 'skip' },
    { id: 'board', name: '分镜师', status: 'ready' },
    { id: 'finish', name: '艺术总监', status: 'waiting' },
  ];
  next.confirmBeforeSpend = true;
  return next;
}

/** 引用了场景、但该场景还没有主图的场。生成这些场之前要先出主图。 */
export function missingSceneRefs(pkg) {
  const locs = new Map((pkg && pkg.locations || []).map((l) => [l.name, l]));
  const blocked = [];
  (pkg && pkg.scenes || []).forEach((sc, si) => {
    const names = (sc.refs && sc.refs.locations) || [];
    for (const name of names) {
      const loc = locs.get(name);
      if (loc && !loc.hasMain) blocked.push({ sceneIndex: si, location: name, reason: '场景「' + name + '」还没有主图' });
    }
  });
  return blocked;
}

/** 只改一镜的提示词，并停在待确认。complaint 是用户原话，不生成。 */
export function reviseShotPrompt(pkg, sceneIndex, shotIndex, complaint) {
  const next = JSON.parse(JSON.stringify(pkg || {}));
  const sc = (next.scenes || [])[sceneIndex];
  if (!sc) throw new Error('场不存在');
  const shot = (sc.shots || [])[shotIndex];
  if (!shot) throw new Error('镜不存在');
  const names = ((sc.refs && sc.refs.characters) || shot.characters || []).filter(Boolean);
  const lock = names.length
    ? ('已绑定角色各只出现一人：' + names.map((n) => n + '×1').join('、') + '。')
    : '';
  const note = str(complaint, 240);
  shot.videoPrompt = [shot.videoPrompt, lock, note ? ('按这次意见改：' + note) : ''].filter(Boolean).join(' ');
  if (note && !String(shot.visual || '').includes(note)) shot.visual = (shot.visual || '') + '。' + note;
  sc.awaitingConfirm = true;
  sc.revision = note;
  if (sc.gen) sc.gen.status = 'awaiting-confirm';
  return next;
}

export function confirmShot(pkg, sceneIndex) {
  const next = JSON.parse(JSON.stringify(pkg || {}));
  const sc = (next.scenes || [])[sceneIndex];
  if (!sc) throw new Error('场不存在');
  sc.awaitingConfirm = false;
  sc.confirmed = true;
  if (sc.gen && sc.gen.status === 'awaiting-confirm') sc.gen.status = sc.gen.assetId ? 'stale' : 'idle';
  return next;
}

const SECTION_LABELS = ['intro', 'verse', 'pre-chorus', 'chorus', 'bridge', 'breakdown', 'outro', 'instrumental', 'unknown'];
const LABEL_ALIAS = {
  intro: 'intro', '前奏': 'intro', opening: 'intro',
  verse: 'verse', '主歌': 'verse', 'verse-a': 'verse', 'verse-b': 'verse', 'verse a': 'verse', 'verse b': 'verse',
  'pre-chorus': 'pre-chorus', prechorus: 'pre-chorus', '预副歌': 'pre-chorus', '导歌': 'pre-chorus',
  chorus: 'chorus', '副歌': 'chorus', hook: 'chorus', refrain: 'chorus',
  bridge: 'bridge', '桥': 'bridge', '桥段': 'bridge',
  breakdown: 'breakdown', drop: 'breakdown',
  outro: 'outro', '尾奏': 'outro', ending: 'outro', '尾声': 'outro',
  instrumental: 'instrumental', '间奏': 'instrumental', break: 'instrumental',
};

const SECTION_STRATEGY = {
  intro: { beats: 8, cut: 'scene_change', scale: '远景', move: '固定', note: '长镜、空镜，建立色调与母题' },
  verse: { beats: 4, cut: 'scene_change', scale: '中景', move: '缓推', note: '稳定运镜，给一个可识别的位置' },
  'pre-chorus': { beats: 2, cut: 'scene_change', scale: '近景', move: '缓推', note: '收紧，能量往副歌送' },
  chorus: { beats: 2, cut: 'closeup', scale: '近景', move: '横移', note: '碎切，副歌必须有一次记得住的视觉事件' },
  bridge: { beats: 8, cut: 'scene_change', scale: '大特写', move: '固定', note: '全片的「停」：音乐继续，画面停住' },
  breakdown: { beats: 2, cut: 'closeup', scale: '特写', move: '升', note: '抽空或反转' },
  outro: { beats: 8, cut: 'scene_change', scale: '远景', move: '固定', note: '把母题留在最后一个画面' },
  instrumental: { beats: 4, cut: 'scene_change', scale: '全景', move: '横移', note: '母题单独出现，不解释歌词' },
  unknown: { beats: 4, cut: 'scene_change', scale: '中景', move: '缓推', note: '跟随能量' },
};

const MOVES = ['固定', '缓推', '横移', '升起'];

/** 把时长压进 Base64 预算：优先 16kHz 单声道 16-bit，不够再降到 8kHz，仍不够就截断前段。 */
export function pcmBudget(durationSec) {
  const dur = Math.max(0, Number(durationSec) || 0);
  const rawBudget = Math.floor((9500000 * 3) / 4) - 4096;
  let sampleRate = 16000;
  if (dur * sampleRate * 2 > rawBudget) sampleRate = 8000;
  let sendSec = dur;
  let truncated = false;
  if (dur * sampleRate * 2 > rawBudget) {
    sendSec = Math.floor(rawBudget / (sampleRate * 2));
    truncated = sendSec + 0.05 < dur;
  }
  return { sampleRate, sendSec: Math.max(0, sendSec), truncated, rawBudget };
}

export function chatCompletionsUrl(baseUrl) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) base = DEFAULT_BASE_URL;
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/^https?:\/\/[^/]+$/i.test(base)) base += '/compatible-mode/v1';
  return base + '/chat/completions';
}

export function normalizeAudioFormat(format) {
  const f = String(format || 'wav').trim().toLowerCase().replace(/^\./, '');
  if (f === 'mpeg' || f === 'mpga') return 'mp3';
  if (f === 'm4a' || f === 'mp4') return 'aac';
  if (f === 'wave' || f === 'x-wav') return 'wav';
  if (['wav', 'mp3', 'aac', 'amr', '3gp', '3gpp', 'ogg'].includes(f)) return f;
  return 'wav';
}

/** input_audio.data：公网 URL 原样；否则包成 data:audio/...;base64,（DashScope 本地文件示例）。 */
export function audioDataField(audioBase64OrUrl, format) {
  const fmt = normalizeAudioFormat(format);
  const raw = String(audioBase64OrUrl || '').trim();
  if (/^https?:\/\//i.test(raw)) return { data: raw, format: fmt };
  const b64 = raw.replace(/^data:[^,]*,/i, '').replace(/\s+/g, '');
  const mime = fmt === 'mp3' ? 'audio/mpeg' : fmt === 'aac' ? 'audio/aac' : fmt === 'wav' ? 'audio/wav' : 'audio/' + fmt;
  return { data: 'data:' + mime + ';base64,' + b64, format: fmt };
}

export function analysisPrompt() {
  return [
    '你在听一首完整的歌，要为它做一支音乐 MV。只返回一个 JSON 对象，不要 markdown，不要写散文。',
    '必须覆盖全曲：每一段都写清配器、能量、情绪、这一段的歌词（没有就空字符串）、以及这一段能拍的画面。不要只给全曲一句摘要。',
    'JSON 字段：',
    '- bpm: 数字',
    '- timeSignature: 如 "4/4"',
    '- key: 调性，不确定就 null',
    '- beats: 拍点时间（秒，从 0 起）',
    '- downbeats: 重拍/小节第一拍（秒）',
    '- sections: [{label,startSec,endSec,energy,mood,instruments,visual,color,lyric}]。label 只能是 intro|verse|pre-chorus|chorus|bridge|breakdown|outro|instrumental。energy 为 0到1。instruments 是字符串数组。visual 是这一段的具体画面（物件、空间、光、运动），color 是光色。段落首尾相接、覆盖到歌曲最后一秒。',
    '- mood: 全曲情绪',
    '- genre: 字符串数组',
    '- instrumentation: 全曲主要配器',
    '- vocals: {present, language, style}',
    '- lyrics: [{startSec,endSec,text}]，听到的原文，没有人声就 []',
    '- characters: [{name, desc}] 画面里的人，1到3 个',
    '- locations: [{name, desc}] 空间',
    '- props: [{name, desc}] 物件',
    '- imagery: 3到6 条可拍摄的画面',
    '- motif: 1 个母题物',
    '- summary: 80 字以内，只是摘要，不能代替 sections',
    '时间单位一律是秒。听不到的歌词不要编。',
  ].join('\n');
}

/**
 * OpenAI 兼容 Chat Completions 体。
 * Qwen-Omni（含 qwen3-omni-flash / qwen3.8-omni-flash）要求 stream=true，否则接口报错。
 * 这里在合并扩展参数之后仍强制 stream 与 modalities:["text"]（分析不要语音回传）。
 */
/** 端点所在地域，用来在界面上写明实际调用的是哪一个。 */
export function omniPlaceLabel(baseUrl) {
  const u = String(baseUrl || '');
  if (/ap-southeast-1|singapore/i.test(u)) return '新加坡';
  if (/dashscope-intl/i.test(u)) return '国际';
  if (/dashscope\.aliyuncs\.com/i.test(u)) return '北京';
  return '';
}

/** 配齐了音频理解就用它做助手规划；缺 Key / 地址 / 模型名才改走文本模型。 */
export function assistantPlannerRoute(provider) {
  const p = provider || {};
  const model = String(p.model || '').trim();
  const baseUrl = String(p.baseUrl || '').trim();
  const apiKey = String(p.apiKey || '').trim();
  if (model && baseUrl && apiKey) {
    const place = omniPlaceLabel(baseUrl);
    return { route: 'omni', model, baseUrl, place, label: model + (place ? '（' + place + '）' : '') };
  }
  return { route: 'harness', model: '', baseUrl: '', place: '', label: '文本模型' };
}

/**
 * 纯文本的全模态请求。不带 input_audio。
 * 合并扩展参数之后仍强制 stream=true、modalities 只有 text。
 */
export function buildOmniTextBody({ model, system, user, extra }) {
  const body = {
    model: String(model || SUGGESTED_MODEL_ID).trim() || SUGGESTED_MODEL_ID,
    messages: [
      ...(system ? [{ role: 'system', content: String(system) }] : []),
      { role: 'user', content: [{ type: 'text', text: String(user || '') }] },
    ],
    modalities: ['text'],
    stream: true,
    stream_options: { include_usage: true },
    response_format: { type: 'json_object' },
    reasoning_effort: 'none',
  };
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(body, extra);
  body.stream = true;
  body.modalities = ['text'];
  if (!body.stream_options || typeof body.stream_options !== 'object') body.stream_options = { include_usage: true };
  return body;
}

/** 把余额、鉴权、限流、超时收成一句中文，并点名实际使用的模型。原文留给详情。 */
export function explainModelError(err, route) {
  if (err && err.brief) {
    return {
      brief: String(err.brief),
      detail: String((err.detail || err.message) || '').slice(0, 800),
      model: (route && route.model) || '',
      place: (route && route.place) || '',
    };
  }
  const raw = String((err && err.message) || err || '');
  const status = Number(err && err.status) || Number((/HTTP\s+(\d+)/.exec(raw) || [])[1]) || 0;
  const who = (route && route.label) || (route && route.model) || '模型';
  let brief = who + '调用失败，请到设置里检查音频理解';
  if (/insufficient balance|余额不足|arrearage|overdue-payment|quota exceeded|欠费/i.test(raw)) {
    brief = who + '余额不足，请充值或在设置里换模型';
  } else if (status === 401 || /401|invalid api[- ]?key|unauthorized|invalid_api_key/i.test(raw)) {
    brief = who + '的 Key 无效，请到设置里检查音频理解';
  } else if (status === 429 || /429|rate limit|too many requests/i.test(raw)) {
    brief = who + '请求过于频繁，请稍后再试';
  } else if (status === 408 || /timeout|timed out|超时|etimedout|aborterror/i.test(raw)) {
    brief = who + '超时，请再试一次';
  } else if (!route || route.route === 'harness') {
    brief = '没有走音频理解，文本模型也失败了：' + raw.slice(0, 80);
  }
  return { brief, detail: raw.slice(0, 800), model: (route && route.model) || '', place: (route && route.place) || '' };
}

export function buildOmniChatBody({ model, audioBase64, audioUrl, format, extra, prompt }) {
  const field = audioDataField(audioUrl || audioBase64, format);
  const body = {
    model: String(model || SUGGESTED_MODEL_ID).trim() || SUGGESTED_MODEL_ID,
    messages: [{
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: field },
        { type: 'text', text: prompt || analysisPrompt() },
      ],
    }],
    modalities: ['text'],
    stream: true,
    stream_options: { include_usage: true },
    response_format: { type: 'json_object' },
    reasoning_effort: 'none',
  };
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    Object.assign(body, extra);
  }
  body.stream = true;
  body.modalities = ['text'];
  if (!body.stream_options || typeof body.stream_options !== 'object') body.stream_options = { include_usage: true };
  return body;
}

/** 解析 SSE 或一次性 JSON，拼出助手文本。 */
export function parseOmniResponse(text) {
  const raw = String(text || '');
  if (raw.includes('data:')) {
    let content = '';
    for (const line of raw.split(/\n/)) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const choice = j.choices && j.choices[0];
        const delta = choice && choice.delta;
        if (delta && typeof delta.content === 'string') content += delta.content;
        const msg = choice && choice.message;
        if (msg && typeof msg.content === 'string') content += msg.content;
      } catch { /* 跳过坏块 */ }
    }
    if (content.trim()) return content;
  }
  try {
    const j = JSON.parse(raw);
    const choice = j.choices && j.choices[0];
    if (choice && choice.message && typeof choice.message.content === 'string') return choice.message.content;
    if (choice && choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
  } catch { /* 不是 JSON */ }
  return raw;
}

export function extractJsonObject(text) {
  const src = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '');
  const start = src.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(src.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function round3(n) { return Math.round(n * 1000) / 1000; }
function round1(n) { return Math.round(n * 10) / 10; }
function clamp01(v) { return Math.max(0, Math.min(1, num(v, 0))); }
function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function strList(v, maxItems, maxLen) {
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  const out = [];
  for (const item of arr) {
    const s = str(item, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function canonSectionLabel(label) {
  const raw = str(label, 40).toLowerCase();
  if (LABEL_ALIAS[raw]) return LABEL_ALIAS[raw];
  if (SECTION_LABELS.includes(raw)) return raw;
  if (/副歌|chorus/.test(raw)) return 'chorus';
  if (/主歌|verse/.test(raw)) return 'verse';
  if (/前奏|intro/.test(raw)) return 'intro';
  if (/桥|bridge/.test(raw)) return 'bridge';
  if (/尾|outro/.test(raw)) return 'outro';
  if (/间奏|instrument/.test(raw)) return 'instrumental';
  return 'unknown';
}

function timeList(v, duration, cap) {
  const arr = Array.isArray(v) ? v : [];
  const out = [];
  for (const item of arr) {
    const t = num(item, NaN);
    if (!Number.isFinite(t) || t < 0) continue;
    const c = duration > 0 ? Math.min(t, duration) : t;
    if (out.length && Math.abs(out[out.length - 1] - c) < 0.02) continue;
    out.push(round3(c));
    if (out.length >= cap) break;
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * 把模型或本地算法的结果收成稳定 schema。缺字段补空，不抛错。
 * meta.durationSec 是文件真实时长，优先于模型自报（差超过 3 秒会写进 warnings）。
 */
export function normalizeAnalysis(raw, meta) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const m = meta || {};
  const warnings = strList(m.warnings, 12, 240).concat(strList(src.warnings, 8, 240));
  let durationSec = num(m.durationSec, 0);
  const modelDur = num(src.durationSec, 0);
  if (!(durationSec > 0) && modelDur > 0) durationSec = modelDur;
  if (durationSec > 0 && modelDur > 0 && Math.abs(modelDur - durationSec) > 3) {
    warnings.push('模型报告的时长 ' + round1(modelDur) + 's 与文件 ' + round1(durationSec) + 's 不一致，时间轴以文件为准。');
  }
  if (!(durationSec > 0)) durationSec = 30;
  durationSec = round3(Math.min(durationSec, 3 * 3600));

  const vocalsIn = (src.vocals && typeof src.vocals === 'object') ? src.vocals : {};
  const sectionsIn = Array.isArray(src.sections) ? src.sections : [];
  const sections = [];
  for (const s of sectionsIn) {
    if (!s || typeof s !== 'object') continue;
    const startSec = Math.max(0, num(s.startSec, num(s.start, 0)));
    const endSec = num(s.endSec, num(s.end, 0));
    if (!(endSec > startSec)) continue;
    sections.push({
      id: 's' + (sections.length + 1),
      label: canonSectionLabel(s.label || s.name || s.type),
      startSec: round3(Math.min(startSec, durationSec)),
      endSec: round3(Math.min(endSec, durationSec)),
      energy: round3(clamp01(s.energy == null ? 0.5 : s.energy)),
      mood: str(s.mood, 80),
      instruments: strList(s.instruments, 6, 40),
      visual: str(s.visual || s.visualIdea, 240),
      color: str(s.color, 80),
      lyric: str(s.lyric || s.lyricHint, 200),
    });
    if (sections.length >= 32) break;
  }
  sections.sort((a, b) => a.startSec - b.startSec);
  if (!sections.length) {
    sections.push({ id: 's1', label: 'unknown', startSec: 0, endSec: durationSec, energy: 0.5, mood: '' });
  } else {
    if (sections[0].startSec > 0.05) sections[0].startSec = 0;
    sections[sections.length - 1].endSec = durationSec;
  }

  const lyrics = [];
  const lyricSrc = Array.isArray(src.lyrics) ? src.lyrics : [];
  for (const line of lyricSrc) {
    if (!line) continue;
    const text = str(typeof line === 'string' ? line : line.text, 200);
    if (!text) continue;
    const startSec = Math.max(0, num(line.startSec, num(line.start, 0)));
    const endSec = num(line.endSec, num(line.end, startSec + 2));
    lyrics.push({
      startSec: round3(Math.min(startSec, durationSec)),
      endSec: round3(Math.min(Math.max(endSec, startSec + 0.2), durationSec)),
      text,
    });
    if (lyrics.length >= 400) break;
  }

  const energySrc = Array.isArray(src.energyCurve) ? src.energyCurve : [];
  const energyCurve = [];
  for (const p of energySrc) {
    if (!p || typeof p !== 'object') continue;
    energyCurve.push({ t: round3(Math.max(0, num(p.t, 0))), energy: round3(clamp01(p.energy)) });
    if (energyCurve.length >= 64) break;
  }

  const source = m.source === 'qwen-omni' ? 'qwen-omni' : 'local-fallback';
  const method = ['model', 'webaudio', 'mock'].includes(m.method) ? m.method : (source === 'qwen-omni' ? 'model' : 'mock');

  return {
    schema: AUDIO_ANALYSIS_SCHEMA,
    source,
    method,
    model: m.model ? str(m.model, 80) : null,
    durationSec,
    bpm: (() => {
      const b = num(src.bpm, 0);
      return b >= 40 && b <= 240 ? Math.round(b) : null;
    })(),
    timeSignature: str(src.timeSignature, 12) || null,
    key: str(src.key, 24) || null,
    beats: timeList(src.beats, durationSec, 8000),
    downbeats: timeList(src.downbeats, durationSec, 2000),
    sections,
    energyCurve,
    mood: str(src.mood, 120),
    genre: strList(src.genre, 6, 40),
    instrumentation: strList(src.instrumentation, 8, 40),
    vocals: {
      present: !!(vocalsIn.present || lyrics.length),
      language: str(vocalsIn.language, 24) || null,
      style: str(vocalsIn.style, 80) || null,
    },
    lyrics,
    imagery: strList(src.imagery, 6, 120),
    motif: str(src.motif, 80),
    summary: str(src.summary, 400),
    characters: namedEntries(src.characters),
    locations: namedEntries(src.locations),
    props: namedEntries(src.props),
    warnings,
  };
}

function namedEntries(v) {
  const arr = Array.isArray(v) ? v : [];
  const out = [];
  for (const item of arr) {
    const name = str(typeof item === 'string' ? item : (item && (item.name || item.title)), 40);
    if (!name) continue;
    out.push({
      name,
      desc: str(typeof item === 'string' ? '' : (item && (item.desc || item.description)), 240),
    });
    if (out.length >= 6) break;
  }
  return out;
}

function sectionsFromEnergy(norm, hop, dur) {
  const n = norm.length;
  const chunks = 6;
  const size = Math.max(1, Math.floor(n / chunks));
  const avgs = [];
  for (let c = 0; c < chunks; c++) {
    const a = c * size;
    const b = c === chunks - 1 ? n : Math.min(n, (c + 1) * size);
    let s = 0;
    let k = 0;
    for (let i = a; i < b; i++) { s += norm[i]; k++; }
    avgs.push(k ? s / k : 0);
  }
  const peak = avgs.indexOf(Math.max(...avgs));
  const labels = avgs.map((v, i) => {
    if (i === 0 && v < 0.45) return 'intro';
    if (i === chunks - 1) return 'outro';
    if (i === peak) return 'chorus';
    if (v < 0.32) return 'bridge';
    return 'verse';
  });
  const sections = [];
  for (let i = 0; i < chunks; i++) {
    const startSec = round3(Math.min(dur, (i * size) * hop));
    const endSec = i === chunks - 1 ? dur : round3(Math.min(dur, ((i + 1) * size) * hop));
    if (!(endSec > startSec)) continue;
    const prev = sections[sections.length - 1];
    if (prev && prev.label === labels[i]) {
      prev.endSec = endSec;
      prev.energy = round3((prev.energy + avgs[i]) / 2);
    } else {
      sections.push({
        id: 's' + (sections.length + 1),
        label: labels[i],
        startSec,
        endSec,
        energy: round3(clamp01(avgs[i])),
        mood: '',
      });
    }
  }
  if (sections.length) sections[sections.length - 1].endSec = dur;
  return sections;
}

/** 本地 Web Audio / 能量曲线：BPM、拍点、按能量切段。听不懂歌词，调用方必须标明。 */
export function heuristicAnalysis({ durationSec, energy, hopSec }) {
  const hop = Math.max(0.05, num(hopSec, 0.25));
  const curve = Array.isArray(energy) ? energy.map((v) => num(v, NaN)).filter((v) => Number.isFinite(v)) : [];
  const durGuess = num(durationSec, 0) || (curve.length ? curve.length * hop : 0);
  if (!(durGuess > 0.4) || curve.length < 8) {
    return mockAnalysis(durGuess || 60, ['没有足够的波形，已按时长铺占位结构']);
  }
  const max = Math.max(...curve.map((v) => Math.abs(v)), 1e-6);
  const norm = curve.map((v) => clamp01(Math.abs(v) / max));
  const onsets = [];
  for (let i = 1; i < norm.length; i++) {
    const prev = norm[i - 1];
    if (norm[i] > 0.18 && norm[i] > prev * 1.35 && norm[i] - prev > 0.08) {
      const t = i * hop;
      if (!onsets.length || t - onsets[onsets.length - 1] > 0.22) onsets.push(round3(t));
    }
  }
  let bpm = 120;
  if (onsets.length >= 4) {
    const iois = [];
    for (let i = 1; i < onsets.length; i++) iois.push(onsets[i] - onsets[i - 1]);
    iois.sort((a, b) => a - b);
    const med = iois[Math.floor(iois.length / 2)];
    if (med > 0.28 && med < 1.5) bpm = Math.round(60 / med);
  }
  const step = 60 / bpm;
  const beats = [];
  for (let t = 0; t < durGuess - 0.05; t += step) beats.push(round3(t));
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  const energyCurve = [];
  const stride = Math.max(1, Math.ceil(norm.length / 48));
  for (let i = 0; i < norm.length; i += stride) {
    energyCurve.push({ t: round3(i * hop), energy: round3(norm[i]) });
  }
  const avg = norm.reduce((a, b) => a + b, 0) / norm.length;
  return normalizeAnalysis({
    bpm,
    timeSignature: '4/4',
    beats,
    downbeats,
    sections: sectionsFromEnergy(norm, hop, durGuess),
    energyCurve,
    mood: avg > 0.62 ? '高能量' : avg > 0.38 ? '起伏' : '克制',
    imagery: ['随能量起伏的单一母题'],
    motif: '一个反复出现的物件',
    summary: '本地节拍与能量分析，没有调用全模态模型，听不懂歌词与配器。',
  }, {
    source: 'local-fallback',
    method: 'webaudio',
    model: null,
    durationSec: durGuess,
    warnings: ['未配置音频理解模型：这是本地节拍/能量分析，不含歌词、配器与语义画面。'],
  });
}

/** 明确标注的占位分析，保证没有模型、也解不出波形时流水线仍能跑通。 */
export function mockAnalysis(durationSec, extraWarnings) {
  const dur = Math.max(8, Math.min(num(durationSec, 60) || 60, 600));
  const bpm = 120;
  const step = 60 / bpm;
  const beats = [];
  for (let t = 0; t < dur - 0.05; t += step) beats.push(round3(t));
  const cuts = [0, 0.12, 0.38, 0.62, 0.78, 0.92, 1].map((p) => round3(p * dur));
  const labels = ['intro', 'verse', 'chorus', 'verse', 'chorus', 'outro'];
  const sections = labels.map((label, i) => ({
    label,
    startSec: cuts[i],
    endSec: cuts[i + 1],
    energy: label === 'chorus' ? 0.85 : label === 'intro' || label === 'outro' ? 0.25 : 0.5,
    mood: '',
  }));
  const warnings = ['未配置音频理解模型，且没有可用波形：这是按时长铺开的占位分析，BPM 固定 120，不是这首歌的真实听感。'].concat(strList(extraWarnings, 6, 200));
  return normalizeAnalysis({
    bpm,
    timeSignature: '4/4',
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    sections,
    mood: '占位',
    imagery: ['占位画面：先换上真实分析再生成'],
    motif: '占位母题',
    summary: '占位分析，仅用于离线把 MV 流水线跑通。',
  }, { source: 'local-fallback', method: 'mock', model: null, durationSec: dur, warnings });
}

/** 没收到新数据多久就中断。整段还有单独的总时长上限。 */
export const ANALYSIS_IDLE_MS = 90000;
export const ANALYSIS_MIN_TOTAL_MS = 10 * 60 * 1000;
export const ANALYSIS_MAX_TOTAL_MS = 30 * 60 * 1000;
export const ANALYSIS_RETRY_LIMIT = 2;
export const ANALYSIS_RETRY_BACKOFF_MS = [2000, 6000];

/**
 * 每一段（一个窗口）自己的预算。
 * 总时长默认 max(10 分钟, 4×这段音频)，封顶 30 分钟。
 * idleMs 是静默上限：流还在吐字就不算超时。
 * 显式 totalMs 用于测试或调用方覆盖，不再被 180 秒截断。
 */
export function analysisBudget({ durationSec, idleMs, totalMs } = {}) {
  const idle = Number(idleMs) > 0 ? Math.min(ANALYSIS_MAX_TOTAL_MS, Number(idleMs)) : ANALYSIS_IDLE_MS;
  const scaled = Math.max(ANALYSIS_MIN_TOTAL_MS, Math.round((Number(durationSec) || 0) * 4000));
  const total = Number(totalMs) > 0
    ? Math.min(ANALYSIS_MAX_TOTAL_MS, Number(totalMs))
    : Math.min(ANALYSIS_MAX_TOTAL_MS, scaled);
  return { idleMs: idle, totalMs: Math.max(total, idle) };
}

/** 外层（工具、RPC、浏览器）至少要盖住全部尝试和退避。 */
export function analysisOuterMs(budget, attempts) {
  const b = budget || analysisBudget({});
  const tries = Math.max(1, Number(attempts) || (ANALYSIS_RETRY_LIMIT + 1));
  let backoff = 0;
  for (let i = 0; i < tries - 1; i++) backoff += ANALYSIS_RETRY_BACKOFF_MS[i] || 6000;
  return b.totalMs * tries + backoff + 15000;
}

export function analysisOuterMaxMs() {
  return analysisOuterMs(analysisBudget({ durationSec: 24 * 3600 }));
}

export function formatClock(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m >= 60) return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分 ' + String(sec).padStart(2, '0') + ' 秒';
  if (m > 0) return m + ' 分 ' + String(sec).padStart(2, '0') + ' 秒';
  return sec + ' 秒';
}

/** 一句中文：哪一段、等了多久。界面上另有「重试」。 */
export function explainAnalysisTimeout({ windowIndex, windowCount, elapsedMs, idleMs, reason } = {}) {
  const n = (Number(windowIndex) || 0) + 1;
  const total = Math.max(n, Number(windowCount) || n);
  const why = reason === 'idle'
    ? '（' + Math.round((Number(idleMs) || ANALYSIS_IDLE_MS) / 1000) + ' 秒没有新数据）'
    : '（已到这段的总时长上限）';
  return '第 ' + n + '/' + total + ' 段在 ' + formatClock(elapsedMs) + '后超时' + why + '，可点重试。';
}

export function isTransientOmniError(err) {
  if (!err) return false;
  if (err.timeout) return true;
  const status = Number(err.status) || Number((/HTTP\s+(\d+)/.exec(String(err.message || '')) || [])[1]) || 0;
  if (status >= 500 && status <= 599) return true;
  const msg = String(err.message || err || '');
  return /timeout|timed out|超时|aborted|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
}

function deltaText(v) {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  let out = '';
  for (const part of v) {
    if (typeof part === 'string') out += part;
    else if (part && typeof part.text === 'string') out += part.text;
  }
  return out;
}

/** 增量 SSE。半行留在缓冲里，下一块接上。 */
export function createSseAccumulator() {
  let buf = '';
  let text = '';
  let reasoning = '';
  const take = (payload) => {
    if (!payload || payload === '[DONE]') return;
    let j = null;
    try { j = JSON.parse(payload); } catch { return; }
    const choice = j && j.choices && j.choices[0];
    const delta = (choice && choice.delta) || {};
    const msg = (choice && choice.message) || {};
    text += deltaText(delta.content != null ? delta.content : msg.content);
    const reason = delta.reasoning_content != null ? delta.reasoning_content
      : (delta.reasoning != null ? delta.reasoning
        : (msg.reasoning_content != null ? msg.reasoning_content : msg.reasoning));
    reasoning += deltaText(reason);
  };
  return {
    push(chunk) {
      buf += String(chunk || '');
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        take(s.slice(5).trim());
      }
      return { text, reasoning };
    },
    finish() {
      const rest = buf.trim();
      if (rest.startsWith('data:')) take(rest.slice(5).trim());
      buf = '';
      return { text, reasoning };
    },
  };
}

const omniProgress = new Map();

export function openOmniProgress(id, meta) {
  const key = String(id || '');
  if (!key) return null;
  const prev = omniProgress.get(key) || {};
  const rec = {
    id: key,
    text: prev.text || '',
    reasoning: prev.reasoning || '',
    phase: (meta && meta.phase) || prev.phase || 'analysis',
    windowIndex: meta && meta.windowIndex != null ? Number(meta.windowIndex) : (prev.windowIndex || 0),
    windowCount: meta && meta.windowCount != null ? Number(meta.windowCount) : (prev.windowCount || 1),
    startedAt: prev.startedAt || Date.now(),
    lastChunkAt: prev.lastChunkAt || 0,
    done: false,
    error: '',
    idleMs: (meta && meta.idleMs) || prev.idleMs || ANALYSIS_IDLE_MS,
    totalMs: (meta && meta.totalMs) || prev.totalMs || ANALYSIS_MIN_TOTAL_MS,
  };
  omniProgress.set(key, rec);
  return rec;
}

export function pushOmniProgress(id, patch) {
  const rec = omniProgress.get(String(id || ''));
  if (!rec || !patch) return rec || null;
  if (typeof patch.text === 'string' && patch.text.length >= rec.text.length) rec.text = patch.text;
  if (typeof patch.reasoning === 'string' && patch.reasoning.length >= rec.reasoning.length) rec.reasoning = patch.reasoning;
  if (patch.lastChunkAt) rec.lastChunkAt = patch.lastChunkAt;
  if (patch.phase) rec.phase = patch.phase;
  if (patch.windowIndex != null) rec.windowIndex = Number(patch.windowIndex);
  if (patch.windowCount != null) rec.windowCount = Number(patch.windowCount);
  if (patch.error) rec.error = String(patch.error);
  if (patch.done) rec.done = true;
  return rec;
}

export function readOmniProgress(id) {
  const rec = omniProgress.get(String(id || ''));
  if (!rec) return null;
  const now = Date.now();
  return {
    ...rec,
    elapsedMs: now - rec.startedAt,
    receiving: !rec.done && rec.lastChunkAt > 0 && (now - rec.lastChunkAt) < 4000,
  };
}

export function closeOmniProgress(id) {
  const rec = omniProgress.get(String(id || ''));
  if (rec) rec.done = true;
}

function analysisTimeoutError(info, partial) {
  const brief = explainAnalysisTimeout(info);
  const err = new Error(brief);
  err.timeout = true;
  err.retry = true;
  err.brief = brief;
  err.status = 408;
  err.elapsedMs = info.elapsedMs;
  err.windowIndex = info.windowIndex;
  err.windowCount = info.windowCount;
  err.partial = { text: (partial && partial.text) || '', reasoning: (partial && partial.reasoning) || '' };
  err.detail = brief;
  return err;
}

async function readOmniBody(res, { signal, onChunk }) {
  const body = res && res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let all = '';
    const onAbort = () => { try { reader.cancel(); } catch { /* 已结束 */ } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        const chunk = dec.decode(step.value, { stream: true });
        all += chunk;
        if (onChunk) onChunk(chunk);
      }
      all += dec.decode();
      return all;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  return typeof res.text === 'function' ? res.text() : '';
}

export async function callOmni({ baseUrl, apiKey, body, fetchImpl, timeoutMs, idleMs, durationSec, returnMeta, onDelta, progressId, windowIndex, windowCount, phase }) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('当前环境没有 fetch，无法调用音频理解模型');
  const budget = analysisBudget({
    durationSec,
    idleMs,
    totalMs: Number(timeoutMs) > ANALYSIS_MIN_TOTAL_MS ? Number(timeoutMs) : 0,
  });
  const url = chatCompletionsUrl(baseUrl);
  const win = { windowIndex: Number(windowIndex) || 0, windowCount: Number(windowCount) || 1 };
  if (progressId) openOmniProgress(progressId, { phase: phase || 'analysis', ...win, idleMs: budget.idleMs, totalMs: budget.totalMs });
  const ctrl = new AbortController();
  const started = Date.now();
  let last = started;
  let abortReason = '';
  const timer = setInterval(() => {
    const now = Date.now();
    if (!abortReason && now - last >= budget.idleMs) abortReason = 'idle';
    else if (!abortReason && now - started >= budget.totalMs) abortReason = 'total';
    if (abortReason) ctrl.abort();
  }, 200);
  if (timer.unref) timer.unref();
  let raw = '';
  const sendStream = async (b) => {
    last = Date.now();
    raw = '';
    const local = createSseAccumulator();
    let res;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + String(apiKey || '').trim(),
        },
        body: JSON.stringify(b),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (abortReason || ctrl.signal.aborted) {
        throw analysisTimeoutError({ ...win, elapsedMs: Date.now() - started, idleMs: budget.idleMs, reason: abortReason || 'idle' }, local.finish());
      }
      throw e;
    }
    last = Date.now();
    let text = '';
    try {
      text = await readOmniBody(res, {
        signal: ctrl.signal,
        onChunk: (chunk) => {
          last = Date.now();
          raw += chunk;
          const snap = local.push(chunk);
          if (progressId) pushOmniProgress(progressId, { text: snap.text, reasoning: snap.reasoning, lastChunkAt: last, ...win });
          if (onDelta) onDelta(snap);
        },
      });
    } catch (e) {
      const snap = local.finish();
      if (abortReason || ctrl.signal.aborted) {
        throw analysisTimeoutError({ ...win, elapsedMs: Date.now() - started, idleMs: budget.idleMs, reason: abortReason || 'total' }, snap);
      }
      const err = e instanceof Error ? e : new Error(String(e));
      err.partial = snap;
      throw err;
    }
    if (abortReason || (ctrl.signal && ctrl.signal.aborted)) {
      throw analysisTimeoutError({ ...win, elapsedMs: Date.now() - started, idleMs: budget.idleMs, reason: abortReason || 'idle' }, local.finish());
    }
    if (!raw) raw = text;
    const snap = local.finish();
    if ((snap.text || snap.reasoning) && onDelta) onDelta(snap);
    if (progressId && (snap.text || snap.reasoning)) pushOmniProgress(progressId, { text: snap.text, reasoning: snap.reasoning, lastChunkAt: last, ...win });
    return { res, text: raw || text, snap };
  };
  try {
    let out = await sendStream(body);
    if (!out.res.ok && out.res.status === 400 && body && body.response_format && /response_format|json_object/i.test(out.text)) {
      const retry = { ...body };
      delete retry.response_format;
      out = await sendStream(retry);
    }
    if (!out.res.ok) {
      const err = new Error('音频理解 HTTP ' + out.res.status + '：' + String(out.text || '').slice(0, 300));
      err.status = out.res.status;
      err.partial = out.snap || { text: '', reasoning: '' };
      if (isTransientOmniError(err)) err.retry = true;
      throw err;
    }
    const snap = out.snap || { text: '', reasoning: '' };
    const parsed = snap.text && snap.text.trim() ? snap.text : parseOmniResponse(out.text);
    if (progressId) {
      pushOmniProgress(progressId, { text: parsed, reasoning: snap.reasoning, done: true, ...win });
      closeOmniProgress(progressId);
    }
    if (returnMeta) return { text: parsed, raw: out.text, toolCalls: extractToolCalls(out.text), reasoning: snap.reasoning || '' };
    return parsed;
  } catch (e) {
    if (e && e.timeout) throw e;
    if (abortReason || (ctrl.signal && ctrl.signal.aborted)) {
      throw analysisTimeoutError({ ...win, elapsedMs: Date.now() - started, idleMs: budget.idleMs, reason: abortReason || 'total' }, { text: '', reasoning: '' });
    }
    throw e;
  } finally {
    clearInterval(timer);
  }
}

export async function callOmniWithRetry(opts) {
  const sleep = (opts && opts.sleep) || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let best = { text: '', reasoning: '' };
  let last = null;
  for (let attempt = 0; attempt <= ANALYSIS_RETRY_LIMIT; attempt++) {
    try {
      return await callOmni({
        ...(opts || {}),
        onDelta: (d) => {
          if ((d.text || '').length >= best.text.length) best = { text: d.text || '', reasoning: d.reasoning || best.reasoning || '' };
          else if ((d.reasoning || '').length >= (best.reasoning || '').length) best = { ...best, reasoning: d.reasoning };
          if (opts && opts.progressId) pushOmniProgress(opts.progressId, { text: best.text, reasoning: best.reasoning, lastChunkAt: Date.now() });
          if (opts && opts.onDelta) opts.onDelta(best);
        },
      });
    } catch (e) {
      last = e;
      if (e && e.partial) {
        if ((e.partial.text || '').length >= best.text.length) best = { text: e.partial.text || '', reasoning: e.partial.reasoning || best.reasoning || '' };
      }
      e.partial = best;
      if (!isTransientOmniError(e) || attempt === ANALYSIS_RETRY_LIMIT) throw e;
      await sleep(ANALYSIS_RETRY_BACKOFF_MS[attempt] || 6000);
    }
  }
  throw last;
}

/** 失败的窗口重试，已经听完的窗口留着。 */
export async function runWindows(windows, runOne, opts) {
  const list = windows || [];
  const sleep = (opts && opts.sleep) || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    let caught = null;
    for (let attempt = 0; attempt <= ANALYSIS_RETRY_LIMIT; attempt++) {
      try {
        const analysis = await runOne(list[i], { attempt, index: i, count: list.length });
        parts.push({ offsetSec: Number(list[i].offsetSec != null ? list[i].offsetSec : list[i].startSec) || 0, analysis });
        caught = null;
        break;
      } catch (e) {
        caught = e;
        if (!isTransientOmniError(e) || attempt === ANALYSIS_RETRY_LIMIT) break;
        await sleep(ANALYSIS_RETRY_BACKOFF_MS[attempt] || 6000);
      }
    }
    if (caught) {
      const info = {
        windowIndex: i,
        windowCount: list.length,
        elapsedMs: caught.elapsedMs,
        idleMs: caught.idleMs,
        reason: caught.timeout ? (caught.brief && /没有新数据/.test(caught.brief) ? 'idle' : 'total') : '',
      };
      const err = new Error(caught.brief || explainAnalysisTimeout(info));
      err.timeout = !!caught.timeout;
      err.retry = true;
      err.parts = parts.slice();
      err.partial = caught.partial || null;
      err.windowIndex = i;
      err.windowCount = list.length;
      err.brief = err.message;
      throw err;
    }
  }
  return parts;
}

export function buildFrameDescribeBody({ model, imageDataUrl }) {
  return {
    model: model || SUGGESTED_MODEL_ID,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: String(imageDataUrl || '') } },
        { type: 'text', text: '用一句中文描述这个 MV 镜头的人物动作、构图和机位。只返回 JSON：{"description":"..."}' },
      ],
    }],
    modalities: ['text'],
    stream: true,
    stream_options: { include_usage: true },
    response_format: { type: 'json_object' },
  };
}

/** 有全模态供应商就描述关键帧；没有或失败由调用方改走空描述，不阻断翻拍。 */
export async function describeFrameFromRequest(req, fetchImpl) {
  const r = req || {};
  const provider = (r.provider && typeof r.provider === 'object') ? r.provider : null;
  const model = provider ? str(provider.model, 80) : '';
  const baseUrl = provider ? str(provider.baseUrl, 300) : '';
  const apiKey = provider ? str(provider.apiKey, 400) : '';
  const image = String(r.imageDataUrl || '').trim();
  if (!model || !baseUrl || !apiKey || !image) {
    return { description: '', fallback: true, reason: '未配置音频理解模型，关键帧描述留空，可以手写。' };
  }
  if (image.length > 1500000) return { description: '', fallback: true, reason: '关键帧过大，跳过描述。' };
  const url = image.startsWith('data:') ? image : ('data:image/jpeg;base64,' + image);
  const content = await callOmniWithRetry({
    baseUrl, apiKey, fetchImpl,
    idleMs: r.idleMs || r.timeoutMs,
    body: buildFrameDescribeBody({ model, imageDataUrl: url }),
  });
  const json = extractJsonObject(content);
  return { description: str((json && json.description) || content, 300), fallback: false };
}

function parseExtra(extra) {
  if (!extra) return null;
  if (typeof extra === 'object' && !Array.isArray(extra)) return extra;
  const t = String(extra).trim();
  if (!t) return null;
  const v = JSON.parse(t);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('音频理解扩展参数必须是 JSON 对象');
  return v;
}

/**
 * 有供应商 + 音频 → 调模型；没有供应商 → 能量曲线或占位。
 * 配了供应商但调用失败：抛错（不把失败伪装成本地分析）。
 */
export async function understandFromRequest(req, fetchImpl) {
  const r = req || {};
  const provider = (r.provider && typeof r.provider === 'object') ? r.provider : null;
  const model = provider ? str(provider.model, 80) : '';
  const baseUrl = provider ? str(provider.baseUrl, 300) : '';
  const apiKey = provider ? str(provider.apiKey, 400) : '';
  const configured = !!(model && baseUrl && apiKey);
  const audioBase64 = String(r.audioBase64 || r.audioUrl || '').trim();
  const durationSec = num(r.durationSec, 0);
  const truncatedWarn = r.truncated
    ? ['歌曲长于单次 Base64 上限，只把前段送给模型；尾奏时间请对照原曲核对。']
    : [];
  if (configured && audioBase64) {
    const bare = audioBase64.replace(/^data:[^,]*,/i, '');
    if (!/^https?:\/\//i.test(audioBase64) && bare.length >= 10000000) {
      throw new Error('音频 Base64 达到 10MB 上限（DashScope 限制）。请先压成单声道低采样 WAV。');
    }
    const body = buildOmniChatBody({
      model,
      audioBase64: /^https?:\/\//i.test(audioBase64) ? '' : audioBase64,
      audioUrl: /^https?:\/\//i.test(audioBase64) ? audioBase64 : '',
      format: r.format || 'wav',
      extra: parseExtra(provider.extra),
      prompt: r.instruction || undefined,
    });
    const content = await callOmniWithRetry({
      baseUrl, apiKey, body, fetchImpl,
      idleMs: r.idleMs,
      durationSec,
      progressId: r.progressId,
      windowIndex: r.windowIndex,
      windowCount: r.windowCount,
      phase: r.phase || 'analysis',
      sleep: r.sleep,
    });
    const json = extractJsonObject(content);
    if (!json) throw new Error('音频理解模型没有返回可解析的 JSON');
    return normalizeAnalysis(json, {
      source: 'qwen-omni',
      method: 'model',
      model,
      durationSec: durationSec || undefined,
      warnings: truncatedWarn,
    });
  }
  const fallback = (Array.isArray(r.energy) && r.energy.length)
    ? heuristicAnalysis({ durationSec, energy: r.energy, hopSec: r.hopSec })
    : mockAnalysis(durationSec || 60);
  if (configured && !audioBase64) {
    fallback.warnings = ['已配置音频理解模型，但这条请求没有音频数据，已改用本地分析。'].concat(fallback.warnings || []);
  }
  if (truncatedWarn.length) fallback.warnings = truncatedWarn.concat(fallback.warnings || []);
  return fallback;
}

function beatGrid(analysis) {
  const dur = analysis.durationSec;
  let beats = (analysis.beats || []).filter((t) => t >= 0 && t < dur - 0.02);
  if (beats.length < 4) {
    const bpm = analysis.bpm && analysis.bpm >= 40 ? analysis.bpm : 120;
    const step = 60 / bpm;
    beats = [];
    for (let t = 0; t < dur - 0.02; t += step) beats.push(round3(t));
  }
  if (!beats.length || beats[0] > 0.05) beats.unshift(0);
  return beats;
}

function strategyFor(label) {
  return SECTION_STRATEGY[label] || SECTION_STRATEGY.unknown;
}

function lyricsIn(analysis, start, end) {
  return (analysis.lyrics || []).filter((line) => {
    const mid = (num(line.startSec, 0) + num(line.endSec, 0)) / 2;
    return mid >= start - 0.02 && mid < end - 0.02;
  });
}

/** 只有一句摘要、段落里没有画面/配器/歌词时，视为听歌结果太薄，必须再写一版完整分镜。 */
export function analysisIsThin(analysis) {
  const sections = (analysis && analysis.sections) || [];
  const rich = sections.filter((s) => s && (str(s.visual, 8) || str(s.lyric, 4) || (s.instruments && s.instruments.length)));
  if (rich.length >= 2) return false;
  const imagery = (analysis && analysis.imagery) || [];
  if (imagery.length >= 3 && sections.filter((s) => s && s.label && s.label !== 'unknown').length >= 3) return false;
  return true;
}

function clauseBits(analysis) {
  const blob = [analysis.summary, ...(analysis.imagery || []), analysis.motif].filter(Boolean).join('。');
  const parts = blob.split(/[。！？!?；;]/).map((s) => s.trim()).filter((s) => s.length >= 4);
  return parts.length ? parts : ['跟随歌曲的能量'];
}

function synthesizedSections(analysis) {
  const dur = analysis.durationSec;
  const text = [analysis.summary, ...(analysis.genre || []), ...(analysis.imagery || []), analysis.mood].join(' ');
  const edm = /电子|舞曲|EDM|house|techno|trance|贝斯|重拍|drop/i.test(text);
  const rows = edm
    ? [['intro', 0, 0.1, 0.22], ['pre-chorus', 0.1, 0.24, 0.5], ['chorus', 0.24, 0.48, 0.92], ['bridge', 0.48, 0.6, 0.18], ['chorus', 0.6, 0.86, 0.96], ['outro', 0.86, 1, 0.28]]
    : [['intro', 0, 0.12, 0.28], ['verse', 0.12, 0.36, 0.46], ['chorus', 0.36, 0.56, 0.86], ['verse', 0.56, 0.72, 0.5], ['chorus', 0.72, 0.9, 0.9], ['outro', 0.9, 1, 0.24]];
  return rows.map(([label, a, b, energy], i) => ({
    id: 'syn' + (i + 1),
    label,
    startSec: round3(a * dur),
    endSec: round3(i === rows.length - 1 ? dur : b * dur),
    energy,
    mood: analysis.mood || '',
    instruments: analysis.instrumentation || [],
    visual: '',
    color: '',
    lyric: '',
  }));
}

function productionSections(analysis) {
  const secs = (analysis.sections || []).filter((s) => s && s.endSec > s.startSec + 0.2 && s.label && s.label !== 'unknown');
  if (secs.length >= 2) return secs;
  return synthesizedSections(analysis);
}

function castOf(analysis) {
  const bits = clauseBits(analysis).join('，');
  const wool = /羊毛/.test(bits);
  const sun = /太阳|阳光/.test(bits);
  const ground = /地面|贴地|低机位/.test(bits);
  const fallback = {
    characters: [{ name: sun ? '奔向太阳的人' : '舞者', desc: bits.slice(0, 180) || '全片唯一的表演者' }],
    locations: [{ name: ground ? '贴地的旷野' : '主场景', desc: bits.slice(0, 180) || '全片发生的空间' }],
    props: [{ name: wool ? '被风吹动的羊毛' : (analysis.motif || '母题物'), desc: analysis.motif || bits.slice(0, 120) || '反复出现的物件' }],
  };
  const pick = (list, fb) => (list && list.length ? list : fb);
  return {
    characters: pick(analysis.characters, fallback.characters).slice(0, 3),
    locations: pick(analysis.locations, fallback.locations).slice(0, 2),
    props: pick(analysis.props, fallback.props).slice(0, 3),
  };
}

function downbeatGrid(analysis) {
  const beats = beatGrid(analysis);
  let downs = (analysis.downbeats || []).filter((t) => t >= 0 && t < analysis.durationSec);
  if (downs.length < 4) downs = beats.filter((_, i) => i % 4 === 0);
  if (!downs.length || downs[0] > 0.05) downs = [0].concat(downs);
  return downs;
}

function splitSectionRanges(sec, maxClip, downs) {
  const ranges = [];
  let t = sec.startSec;
  const end = sec.endSec;
  let guard = 0;
  while (t < end - 0.05 && guard++ < 64) {
    if (end - t <= maxClip + 0.05) {
      ranges.push([t, end]);
      break;
    }
    let cut = Math.min(end, t + maxClip);
    const inside = downs.filter((b) => b >= t + 4 && b <= t + maxClip + 0.02);
    if (inside.length) cut = inside[inside.length - 1];
    if (end - cut < 4) {
      const earlier = downs.filter((b) => b >= t + 4 && b <= end - 4);
      if (earlier.length) cut = earlier[earlier.length - 1];
      else if (end - t > 8) cut = end - 4;
    }
    if (!(cut > t + 0.4) || cut - t > maxClip + 0.05) cut = Math.min(end, t + maxClip);
    ranges.push([t, round3(cut)]);
    t = cut;
  }
  return ranges;
}

function shotCuts(start, end, downs) {
  const marks = downs.filter((b) => b > start + 0.45 && b < end - 0.45);
  const pts = [start];
  for (const m of marks) {
    if (m - pts[pts.length - 1] >= 0.45) pts.push(m);
  }
  if (end - pts[pts.length - 1] < 0.45 && pts.length > 1) pts[pts.length - 1] = end;
  else pts.push(end);
  const spans = [];
  for (let i = 0; i < pts.length - 1; i++) spans.push([pts[i], pts[i + 1]]);
  return spans.length ? spans : [[start, end]];
}

/** 出图时才附上的约束，不放进用户能编辑的提示词。 */
export const IMAGE_SEND_SUFFIX = '不要出现文字、字幕、水印或标志';

export function presentImagePrompt(text) {
  return String(text || '')
    .replace(/[，,。.\s]*(无文字|无字幕|无水印|无标志|不要文字|不要出现文字、字幕、水印或标志)+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function promptForImageSend(visible, suffix) {
  const base = presentImagePrompt(visible);
  const extra = suffix == null ? IMAGE_SEND_SUFFIX : String(suffix || '');
  if (!extra || base.includes(extra)) return base;
  return base ? (base + '。' + extra) : extra;
}

const STORY_BEAT = {
  intro: { want: '让人认出是谁、在哪里', conflict: '事情还按旧样子走', turn: '音乐进来，旧规矩松动', ending: '世界被改写了一点' },
  verse: { want: '把想要的东西变成一件具体的事', conflict: '有一个看得见的阻碍', turn: '人决定跨过它', ending: '局面和这一段开头不同' },
  'pre-chorus': { want: '把力量聚到下一拍', conflict: '还差最后一下', turn: '阻碍被推到眼前', ending: '下一拍必须放开' },
  chorus: { want: '把这段的愿望做完', conflict: '对立也同时出现', turn: '两边撞上', ending: '这一轮有一个暂时的结果' },
  bridge: { want: '看清刚才的办法要付的代价', conflict: '老办法失效', turn: '换一条看得见的路', ending: '准备进入最后一段' },
  breakdown: { want: '用动作接住没有词的段落', conflict: '不能只重复上一镜', turn: '动作落在重拍上', ending: '能量重新堆起来' },
  instrumental: { want: '用一个新的动作或空间细节接住人声空档', conflict: '画面不能原地打转', turn: '出现一件刚才没有的东西', ending: '给下一段人声留入口' },
  outro: { want: '把这件事收住', conflict: '不能假装什么都没发生', turn: '留下一个最后的可见结果', ending: '停在最后一个画面' },
  unknown: { want: '把这段音乐变成一件事', conflict: '事情要有阻碍', turn: '发生一个可见的变化', ending: '接到下一段' },
};

/** 没走模型时的故事骨架。标明是模板，不假装已经写成了具体剧本。 */
export function draftStory(analysis, styleText) {
  const a = analysis || {};
  const style = str(styleText, 400);
  const sections = (a.sections || []).filter((s) => s && s.endSec > s.startSec);
  const rows = sections.length ? sections : [{ id: 's1', label: 'verse', startSec: 0, endSec: Number(a.durationSec) || 0, visual: '' }];
  const lyricOf = (sec) => (a.lyrics || []).filter((l) => {
    const mid = (num(l.startSec, 0) + num(l.endSec, 0)) / 2;
    return mid >= num(sec.startSec, 0) && mid < num(sec.endSec, 0);
  }).map((l) => l.text).filter(Boolean).join(' / ');
  const beats = rows.map((sec) => {
    const role = STORY_BEAT[sec.label] || STORY_BEAT.unknown;
    const lyric = lyricOf(sec);
    const plot = [sec.visual, lyric, role.turn].filter(Boolean).join('。') || role.turn;
    return {
      sectionId: sec.id || '',
      label: sec.label || 'unknown',
      startSec: num(sec.startSec, 0),
      endSec: num(sec.endSec, 0),
      want: role.want,
      conflict: role.conflict,
      turn: role.turn,
      ending: role.ending,
      plot,
    };
  });
  const lyricHint = ((a.lyrics || []).slice(0, 2).map((l) => l.text).filter(Boolean).join(' / '));
  const logline = [style, a.summary, lyricHint].filter(Boolean).join('。').slice(0, 280) || '跟着这首歌的起伏做完一件事';
  return {
    source: 'template',
    label: '模板骨架，不是模型写的故事',
    logline,
    synopsis: beats.map((b) => sectionLabelZh(b.label) + '：' + b.plot).join('\n'),
    beats,
  };
}

export function storyBeatAt(story, label, timeSec) {
  const beats = (story && story.beats) || [];
  const t = num(timeSec, 0);
  return beats.find((b) => (!label || b.label === label) && t >= num(b.startSec, 0) - 0.05 && t < num(b.endSec, 0) + 0.05)
    || beats.find((b) => b.label === label)
    || beats[0]
    || null;
}

export function characterSheetPrompt(person) {
  const p = person || {};
  const look = p.appearance || {};
  const outfit = (p.outfits && p.outfits[0] && p.outfits[0].desc) || p.outfit || '';
  return presentImagePrompt([
    p.name,
    p.age,
    p.role,
    look.face ? ('脸：' + look.face) : '',
    look.hair ? ('头发：' + look.hair) : '',
    look.build ? ('体态：' + look.build) : '',
    outfit ? ('衣服：' + outfit) : '',
    p.personality,
    p.arc,
  ].filter(Boolean).join('，'));
}

/** 角色参考图必须是可预览的三视图，外观细节写在前面，不能只剩一句套话。 */
export function characterTurnaroundPrompt(person) {
  const base = characterSheetPrompt(person);
  return presentImagePrompt(base + '。角色设定图，同一张脸：正面、侧面、背面三格全身，中性背景，不要出现场景、其他人或文字。');
}

const REF_LABELS = (role, name) => [
  name,
  (role === 'loc' ? '场景-' : '角色-') + name + ' 设定图',
  name + ' 设定图',
  name + ' 三视图',
];

/** 旧画布上的图片节点可能只有名字、没有 mvRole。按名字认领，不新建第二张。 */
export function matchRefNode(nodes, audioId, role, name) {
  const images = Object.values(nodes || {}).filter((n) => n && n.type === 'image');
  const exact = images.find((n) => n.data && n.data.mvFrom === audioId && n.data.mvRole === role && n.data.refName === name);
  if (exact) return exact;
  const labels = REF_LABELS(role, name);
  return images.find((n) => {
    const d = n.data || {};
    if (d.mvFrom && d.mvFrom !== audioId) return false;
    if (d.mvRole && d.mvRole !== role && d.mvRole !== 'loc-view') return false;
    if (d.refName && d.refName !== name) return false;
    return labels.includes(String(d.label || ''));
  }) || null;
}

/**
 * 给已有 MV 计划补角色/场景图节点。不重跑听歌，不清已有图片，不覆盖手改过的提示词。
 */
export function planRefRepair(pkg, nodes, audioId) {
  const actions = [];
  const want = [];
  (pkg && pkg.characters || []).forEach((c, i) => {
    if (!c || !c.name) return;
    want.push({ role: 'char', index: i, name: c.name, prompt: characterTurnaroundPrompt(c) });
  });
  (pkg && pkg.locations || []).forEach((c, i) => {
    if (!c || !c.name) return;
    want.push({ role: 'loc', index: i, name: c.name, prompt: c.imagePrompt || c.mainPrompt || c.desc || c.name });
  });
  for (const item of want) {
    const hit = matchRefNode(nodes, audioId, item.role, item.name);
    if (hit) {
      const prompt = String((hit.data && hit.data.prompt) || '').trim();
      actions.push({
        op: 'adopt',
        nodeId: hit.id,
        name: item.name,
        role: item.role,
        keepAsset: !!((hit.data && hit.data.assetId)),
        patch: {
          mvFrom: audioId,
          mvRole: item.role,
          refName: item.name,
          ...(prompt ? {} : { prompt: item.prompt }),
        },
      });
    } else {
      actions.push({
        op: 'create',
        role: item.role,
        index: item.index,
        name: item.name,
        prompt: item.prompt,
        mvKey: 'mv:' + audioId + ':' + item.role + ':' + item.index,
      });
    }
  }
  return { actions };
}

/** 图片请求里参考图怎么送。generations 用 image 数组；编辑接口用 multipart。不支持就不能假装送过。 */
export function imageRefPayload(dataUrls, mode) {
  const urls = (dataUrls || []).filter(Boolean);
  if (!urls.length) return { state: 'none', field: '', count: 0, ok: true };
  if (mode === 'edits') return { state: 'sent', field: 'image[]', count: urls.length, ok: true };
  if (mode === 'compshare' || mode === 'sanbao') return { state: 'sent', field: 'reference', count: urls.length, ok: true };
  return { state: 'sent', field: 'image', count: urls.length, ok: true, image: urls };
}

export function strippedRefIsFailure(field, refCount) {
  if (!refCount) return false;
  return field === 'image' || field === 'reference_images' || field === 'image[]' || field === 'reference' || field === 'first_frame_image';
}

export function refStripError(field) {
  return '这个模型不支持参考图字段「' + field + '」。请改用支持参考图的图片模式，或换模型。没有把去掉参考图的结果当成成功。';
}

/**
 * 视频请求实际会送出什么图。不能同时收首帧和参考图时，首帧改作第一张参考图，并写明。
 * 参考图会被丢掉、或一张图都没有时，state 不是 sent，调用方不能当成成功。
 */
export function videoConditionPlan(input) {
  const o = input || {};
  const refCount = Math.max(0, Number(o.refCount) || 0);
  const hasFrame = !!o.hasFrameBlob;
  const mode = o.frameMode || 'auto';
  const cap = o.refCap == null ? 8 : Number(o.refCap);
  if (!hasFrame && !refCount) {
    return { state: 'missing', field: '', sendFrame: false, sendRefs: 0, dropped: 0, say: '这一段视频没有分镜首帧，也没有角色参考图，不能只靠文字生成。' };
  }
  if (mode === 'hard' && hasFrame && refCount) {
    return { state: 'unsupported', field: 'first_frame', sendFrame: true, sendRefs: 0, dropped: refCount, say: '硬首帧会丢掉角色参考图。请改成自动，让首帧和参考图一起送。本次没有生成。' };
  }
  if (refCount && cap <= 0) {
    return { state: 'unsupported', field: hasFrame ? 'first_frame' : '', sendFrame: hasFrame, sendRefs: 0, dropped: refCount, say: hasFrame
      ? '这个视频模型只能收首帧，角色参考图送不进去。请换支持参考图的模型。本次没有生成。'
      : '这个视频模型不支持参考图，这一段又没有分镜首帧。请换模型或先生成分镜。' };
  }
  if (hasFrame && refCount) {
    const room = Math.max(0, cap - 1);
    const n = Math.min(room, refCount);
    const dropped = refCount - n;
    let say = '这个模型不能同时用首帧和参考图。分镜首帧会作为第一张参考图送出，另外 ' + n + ' 张角色或场景图一起送。';
    if (dropped) say += '该模型最多 ' + cap + ' 张，其余 ' + dropped + ' 张这次没有送出。';
    return { state: 'downgraded', field: 'reference_image', sendFrame: false, sendRefs: n + 1, dropped, say };
  }
  if (hasFrame) return { state: 'sent', field: 'first_frame', sendFrame: true, sendRefs: 0, dropped: 0, say: '将送出分镜首帧。' };
  const n = Math.min(Math.max(0, cap), refCount);
  const dropped = refCount - n;
  let say = '将送出 ' + n + ' 张参考图。';
  if (dropped) say += '该模型最多 ' + cap + ' 张，其余 ' + dropped + ' 张这次没有送出。';
  return { state: 'sent', field: 'reference_image', sendFrame: false, sendRefs: n, dropped, say };
}

function personFromRaw(raw, story) {
  const src = raw || {};
  const name = str(src.name, 40) || '表演者';
  const face = str((src.appearance && src.appearance.face) || src.face, 80) || '五官清楚，全片同一张脸';
  const hair = str((src.appearance && src.appearance.hair) || src.hair, 80) || '发型全片保持不变';
  const build = str((src.appearance && src.appearance.build) || src.build, 80) || '体态和年龄感全片保持不变';
  const outfit = str(src.outfit || (src.outfits && src.outfits[0] && src.outfits[0].desc), 120)
    || str(src.desc, 80)
    || '一套从头穿到尾的衣服';
  const person = {
    name,
    role: str(src.role, 80) || ((story && story.beats && story.beats[0] && story.beats[0].want) || '把这件事做完的人'),
    age: str(src.age, 40),
    appearance: { face, hair, build },
    personality: str(src.personality, 80),
    outfits: [{ phase: '全片', desc: outfit }],
    props: Array.isArray(src.props) ? src.props.map((x) => str(x, 40)).filter(Boolean).slice(0, 4) : [],
    arc: str(src.arc, 180) || str(story && story.logline, 180),
    desc: str(src.desc, 240) || [face, hair, outfit].filter(Boolean).join('。'),
  };
  person.imagePrompt = characterTurnaroundPrompt(person);
  return person;
}

const SCALES = ['远景', '全景', '中景', '近景', '特写'];
const ANGLES = ['平视', '低机位', '俯拍', '侧向'];

function writeShotCopy(ctx) {
  const who = '@' + ctx.who + '@';
  const where = '@' + ctx.where + '@';
  const prop = '@' + ctx.prop + '@';
  const secName = sectionLabelZh(ctx.section.label);
  const bit = ctx.bit;
  const light = ctx.light;
  const cut = round1(ctx.cutAt);
  const visual = [
    ctx.scale + '，' + ctx.angle + '机位，运镜' + ctx.move,
    who + ' 在 ' + where + '，' + prop + ' 在画面里',
    bit,
    '段落「' + secName + '」',
    ctx.hold ? '音乐继续，画面停住' : '',
  ].filter(Boolean).join('。') + '。';
  const camera = '景别' + ctx.scale + '；机位' + ctx.angle + '；运镜' + ctx.move + '。切点卡在 ' + cut + 's 的重拍上';
  const motion = ctx.hold
    ? '起点：' + who + '已经停在画面里 → 镜头完全固定，只有风和光在动 → 终点：仍停着，这是全片的「停」'
    : '起点：' + ctx.scale + '里' + who + '刚要动 → ' + ctx.move + '，动作踩上拍点 → 终点：动作进行到一半，不站定';
  const imagePrompt = [
    '电影关键帧，' + ctx.scale + '，' + ctx.angle + '机位',
    who + '，' + where + '，' + prop,
    light,
    bit,
    ctx.plot ? ('这一拍：' + ctx.plot) : '',
  ].filter(Boolean).join('，');
  const videoPrompt = [
    round1(ctx.dur) + ' 秒',
    camera,
    motion,
    '光与色彩：' + light,
    '切点必须落在 ' + cut + ' 秒的重拍，不能晚一帧',
    bit,
    ctx.hold ? '这一镜是全片的停：音乐不停，画面停住' : '',
  ].filter(Boolean).join('。') + '。';
  return { visual, camera, motion, imagePrompt, videoPrompt, light };
}

/**
 * 把听歌结果铺成整支 MV：场（≤15s）→ 镜（卡在重拍），每镜都有关键帧提示词和视频提示词。
 * 模型只给了一段摘要时，按曲式把全曲拆开，而不是停在那一段话上。
 */
export function planMusicVideoPackage(analysis, opts) {
  const a = normalizeAnalysis(analysis, {
    source: analysis && analysis.source,
    method: analysis && analysis.method,
    model: analysis && analysis.model,
    durationSec: analysis && analysis.durationSec,
    warnings: analysis && analysis.warnings,
  });
  const allowed = normalizeDurations(opts && opts.allowedDurations);
  const maxClip = allowed.length
    ? allowed[allowed.length - 1]
    : Math.max(4, Math.min(15, num(opts && opts.maxClipSeconds, 15) || 15));
  const sections = productionSections(a);
  const styleText = str(opts && (opts.brief || opts.style), 400);
  const providedStory = opts && opts.story && typeof opts.story === 'object' ? opts.story : null;
  const story = providedStory && Array.isArray(providedStory.beats) && providedStory.beats.length
    ? {
      source: providedStory.source || 'edited',
      label: providedStory.label || (providedStory.source === 'template' ? '模板骨架，不是模型写的故事' : ''),
      logline: str(providedStory.logline, 280),
      synopsis: str(providedStory.synopsis, 2000),
      beats: providedStory.beats,
    }
    : draftStory(Object.assign({}, a, { sections }), styleText);
  const cast = castOf(a);
  const downs = downbeatGrid(a);
  const bits = clauseBits(a);
  if (styleText) bits.unshift(styleText);
  const who = cast.characters[0].name;
  const where = cast.locations[0].name;
  const prop = cast.props[0].name;
  const warnings = (a.warnings || []).slice();
  if (analysisIsThin(a)) warnings.push('听歌结果缺少逐段画面，已按全曲时长铺成完整分镜；有文本模型时会再写一版提示词。');
  const scenes = [];
  let shotSerial = 0;
  sections.forEach((section) => {
    const ranges = splitSectionRanges(section, maxClip, downs);
    ranges.forEach(([start, end], part) => {
      const cuts = shotCuts(start, end, downs);
      const shots = cuts.map(([s0, s1], si) => {
        const sameSectionCont = part > 0 && si === 0;
        const scale = (section.label === 'bridge' && si === 0) || si === 1 ? '大特写' : SCALES[(shotSerial + si) % SCALES.length];
        const move = MOVES[(shotSerial + si) % MOVES.length];
        const angle = section.label === 'chorus' && /地面|贴地/.test(bits.join('')) ? '低机位' : ANGLES[(shotSerial + si) % ANGLES.length];
        const light = section.color || ( /阳光|刺眼/.test(bits.join('')) ? '阳光刺眼，高反差' : (section.energy > 0.7 ? '硬光，高反差' : '柔光，低反差'));
        const beat = storyBeatAt(story, section.label, s0);
        const bit = [beat && beat.plot, section.visual, bits[shotSerial % bits.length]].filter(Boolean).join('，');
        const copy = writeShotCopy({
          scale, move, angle, section, who, where, prop, light, bit,
          plot: beat && beat.plot,
          cutAt: s0, dur: s1 - s0, hold: section.label === 'bridge' && si === 0,
        });
        const lines = lyricsIn(a, s0, s1);
        const span = s1 - s0;
        const timeBeats = (span >= 2 ? [0, span * 0.45, span * 0.9] : [0]).map((off, k, arr) => {
          const label = k === 0 ? '起势' : k === arr.length - 1 ? '落在切点之前' : '踩上拍点';
          return round1(off) + 's ' + label;
        });
        const shot = {
          title: (sectionLabelZh(section.label) + ' ' + (si + 1)).slice(0, 40),
          duration: round3(s1 - s0),
          startSec: round3(s0),
          endSec: round3(s1),
          sectionLabel: section.label,
          seg: 'continuation',
          sameSectionCont,
          visual: copy.visual,
          motion: copy.motion,
          camera: copy.camera,
          light: copy.light,
          cutAt: round3(s0),
          imagePrompt: presentImagePrompt(copy.imagePrompt),
          videoPrompt: copy.videoPrompt,
          plotBeat: (beat && beat.plot) || '',
          timeBeats,
          vfx: section.label === 'chorus' ? '光随重拍抬起，不滥用光斑' : '',
          negative: 'off-beat cut, cut one frame after the beat, lip-sync drift, watermark, subtitle burned in, extra limbs',
          tail: '动作进行到一半，' + prop + ' 仍在画面里，运镜没停死',
          cam: move + '，可被下一镜延续',
          start: '',
          characters: cast.characters.map((c) => c.name),
          scene: where,
          props: cast.props.map((p) => p.name),
          dialogue: lines.slice(0, 3).map((line) => ({ role: '人声', line: line.text })),
          sfx: '原曲声轨，切在重拍' + ((section.instruments && section.instruments.length) ? '；' + section.instruments.slice(0, 3).join('、') : ''),
        };
        return shot;
      });
      shotSerial += shots.length;
      const sceneDur = round3(shots.reduce((s, sh) => s + sh.duration, 0));
      scenes.push({
        index: scenes.length + 1,
        title: sectionLabelZh(section.label) + (ranges.length > 1 ? ' ' + (part + 1) : ''),
        sectionLabel: section.label,
        startSec: round3(start),
        endSec: round3(end),
        duration: sceneDur,
        continued: part > 0,
        shots,
      });
    });
  });
  if (scenes.length && scenes[0].shots.length) {
    scenes[0].shots[0].seg = 'opening';
    scenes[0].shots[0].start = '歌曲第 0 秒，从这一镜建立世界';
  }
  scenes.forEach((sc, si) => {
    sc.shots.forEach((shot, i) => {
      if (si === 0 && i === 0) return;
      if (i === 0) {
        // 每一场的第一镜都是切点，这样整表摊平后也不会把两场 continuation 粘成超过 15 秒。
        // 同一段落被 15 秒上限切开时，continued 仍为 true，成片用尾帧接这一场的首帧。
        shot.seg = 'scene_change';
        shot.start = sc.continued
          ? '同一段落因单次生成上限切开，成片用上一段尾帧接这一镜'
          : '新段落「' + sectionLabelZh(sc.sectionLabel) + '」从这一镜切开';
      } else {
        shot.seg = 'continuation';
        shot.start = '';
      }
    });
  });
  if (scenes.length) {
    const lastScene = scenes[scenes.length - 1];
    const last = lastScene.shots[lastScene.shots.length - 1];
    if (last) {
      last.endSec = round3(a.durationSec);
      const sumBefore = scenes.reduce((s, sc) => s + sc.shots.reduce((x, sh) => x + sh.duration, 0), 0) - last.duration;
      last.duration = round3(Math.max(0.4, a.durationSec - sumBefore));
      lastScene.endSec = last.endSec;
      lastScene.duration = round3(lastScene.shots.reduce((s, sh) => s + sh.duration, 0));
    }
  }
  const style = [a.mood, (a.genre || []).join(' / '), clauseBits(a)[0]].filter(Boolean).join('。');
  return stampGeneration(applyContinuity(decorateMusicPackage({
    schema: 'dshic.mv-package.v1',
    thin: analysisIsThin(a),
    durationSec: a.durationSec,
    bpm: a.bpm,
    source: a.source,
    maxClipSeconds: maxClip,
    story,
    imageSuffix: IMAGE_SEND_SUFFIX,
    treatment: {
      title: str(opts && opts.title, 40) || '音乐视频',
      logline: story.logline || a.summary || bits[0],
      style: (styleText ? styleText + '。' : '') + style.slice(0, 320),
      styleAnchor: (styleText || bits[0] || '').slice(0, 80),
    },
    downbeats: downs,
    characters: cast.characters.map((c) => personFromRaw(c, story)),
    locations: cast.locations.map((c) => ({
      name: c.name,
      desc: c.desc || c.name,
      imagePrompt: presentImagePrompt('场景，' + c.name + '。' + (c.desc || '') + '。不要出现人物。'),
    })),
    props: cast.props.map((c) => ({
      name: c.name,
      desc: c.desc || c.name,
      imagePrompt: presentImagePrompt('道具，' + c.name + '。' + (c.desc || '') + '。单独放在画面里。'),
    })),
    scenes,
    warnings,
    ...(allowed.length ? { genDefaults: { allowedDurations: allowed, model: null, resolution: null } } : {}),
  }, a)));
}

export function planMusicVideoShots(analysis, opts) {
  const pkg = planMusicVideoPackage(analysis, opts);
  const shots = [];
  for (const sc of pkg.scenes) {
    for (const sh of sc.shots) {
      const out = { ...sh };
      delete out.sameSectionCont;
      shots.push(out);
    }
  }
  return {
    shots,
    total: round3(shots.reduce((s, sh) => s + sh.duration, 0)),
    maxClipSeconds: pkg.maxClipSeconds,
    bpm: pkg.bpm,
    durationSec: pkg.durationSec,
    source: pkg.source,
    warnings: pkg.warnings,
    package: pkg,
  };
}

export function mergeCreative(pkg, creative) {
  const c = creative && typeof creative === 'object' ? creative : {};
  const next = JSON.parse(JSON.stringify(pkg));
  if (c.story && typeof c.story === 'object') {
    const prev = next.story || {};
    next.story = {
      source: 'model',
      label: '',
      logline: str(c.story.logline || prev.logline, 280),
      synopsis: str(c.story.synopsis || prev.synopsis, 2000),
      beats: Array.isArray(c.story.beats) && c.story.beats.length ? c.story.beats : (prev.beats || []),
    };
    if (next.treatment) next.treatment.logline = next.story.logline || next.treatment.logline;
  }
  if (c.treatment && typeof c.treatment === 'object') {
    if (c.treatment.logline) next.treatment.logline = str(c.treatment.logline, 400);
    if (c.treatment.style) next.treatment.style = str(c.treatment.style, 400);
    if (c.treatment.styleAnchor) next.treatment.styleAnchor = str(c.treatment.styleAnchor, 80);
  }
  const overlayList = (base, incoming) => {
    if (!Array.isArray(incoming)) return base;
    return base.map((item, i) => {
      const src = incoming[i];
      if (!src || typeof src !== 'object') return item;
      const merged = {
        ...item,
        ...src,
        name: item.name,
        desc: src.desc ? str(src.desc, 240) : item.desc,
        imagePrompt: presentImagePrompt(src.imagePrompt ? str(src.imagePrompt, 800) : item.imagePrompt),
      };
      if (merged.appearance || merged.outfit || merged.role) {
        const sheet = personFromRaw(merged, next.story);
        merged.appearance = sheet.appearance;
        merged.outfits = sheet.outfits;
        merged.imagePrompt = sheet.imagePrompt || merged.imagePrompt;
        merged.role = sheet.role;
        merged.age = sheet.age;
        merged.arc = sheet.arc;
      }
      return merged;
    });
  };
  next.characters = overlayList(next.characters, c.characters);
  next.locations = overlayList(next.locations, c.locations);
  next.props = overlayList(next.props, c.props);
  if (Array.isArray(c.scenes)) {
    next.scenes.forEach((sc, si) => {
      const src = c.scenes[si];
      if (!src || !Array.isArray(src.shots)) return;
      sc.shots.forEach((shot, i) => {
        const s = src.shots[i];
        if (!s || typeof s !== 'object') return;
        if (s.visual) shot.visual = str(s.visual, 500);
        if (s.camera) shot.camera = str(s.camera, 240);
        if (s.motion) shot.motion = str(s.motion, 400);
        if (s.light) shot.light = str(s.light, 120);
        if (s.imagePrompt) shot.imagePrompt = str(s.imagePrompt, 600);
        if (s.videoPrompt) shot.videoPrompt = str(s.videoPrompt, 800);
      });
    });
  }
  next.thin = false;
  return next;
}

export function llmCreativeUserPrompt(pkg) {
  const lines = [
    '下面是一支音乐 MV 的时间网格。时间码已经按歌曲卡死，禁止改 startSec、endSec、duration。',
    '先写故事再写角色。返回 JSON：{story:{logline,synopsis,beats:[{label,startSec,endSec,want,conflict,turn,ending,plot}]}, treatment:{logline,style,styleAnchor}, characters:[{name,role,age,appearance:{face,hair,build},personality,outfit,arc,desc}], locations:[{name,desc}], props:[{name,desc}], scenes:[{shots:[{visual,camera,motion,light,imagePrompt,videoPrompt,plotBeat}]}]}。',
    'beats 与歌曲段落一一对应，不要改时间。角色名用故事里的人，不要写 Male Lead 这类占位名，除非用户风格原文里就有。imagePrompt 只写脸、头发、体态、衣服这些具体特征，不要写「无文字」「三视图」「中性背景」。',
    'scenes 与 shots 的数量和顺序必须与网格一致。imagePrompt 是可直接文生图的关键帧；videoPrompt 是可直接生成视频的提示词，含景别、机位、运镜、动作、光、以及切在重拍上。',
    '歌曲摘要：' + (pkg.treatment && pkg.treatment.logline || ''),
    '风格：' + (pkg.treatment && pkg.treatment.style || ''),
  ];
  pkg.scenes.forEach((sc, si) => {
    lines.push('场' + si + ' ' + sc.title + ' ' + sc.startSec + '-' + sc.endSec + 's');
    sc.shots.forEach((sh, i) => {
      lines.push('  镜' + si + '.' + i + ' ' + sh.startSec + '-' + sh.endSec + 's ' + sh.sectionLabel + ' 现有画面：' + String(sh.visual || '').slice(0, 80));
    });
  });
  return lines.join('\n');
}

/** 在节拍网格内改一镜：时长会吸到最近的重拍，后一镜让出或吃进同样的时间，整曲时长不变。 */
export function patchPackageShot(pkg, sceneIndex, shotIndex, patch) {
  const next = JSON.parse(JSON.stringify(pkg));
  const sc = (next.scenes || [])[sceneIndex];
  if (!sc) throw new Error('场不存在');
  const shot = (sc.shots || [])[shotIndex];
  if (!shot) throw new Error('镜不存在');
  const p = patch || {};
  for (const k of ['visual', 'camera', 'motion', 'light', 'imagePrompt', 'videoPrompt', 'title']) {
    if (p[k] != null) shot[k] = str(p[k], k === 'videoPrompt' || k === 'imagePrompt' ? 1600 : 500);
  }
  if (p.join === 'cut' || p.join === 'continuous') {
    sc.join = p.join;
    sc.continued = p.join === 'continuous';
    for (const sh of sc.shots || []) sh.transition = p.join;
  }
  if (p.keep === true || p.keep === false) {
    sc.keep = p.keep;
    sc.genMode = p.keep ? 'keep' : (sc.capabilityPath || 'reference-to-video');
  }
  if (p.refs && typeof p.refs === 'object') {
    sc.refs = {
      characters: (p.refs.characters || []).map((n) => str(n, 40)).filter(Boolean),
      locations: (p.refs.locations || []).map((n) => str(n, 40)).filter(Boolean),
      props: (p.refs.props || []).map((n) => str(n, 40)).filter(Boolean),
    };
  }
  if (p.duration != null) {
    const want = num(p.duration, shot.duration);
    const downs = (next.downbeats || []).filter((t) => t > shot.startSec + 0.35 && t < sc.endSec - 0.05);
    let end = shot.startSec + Math.max(0.4, want);
    if (downs.length) {
      end = downs.reduce((best, t) => (Math.abs(t - end) < Math.abs(best - end) ? t : best), downs[0]);
    }
    end = Math.min(sc.endSec, Math.max(shot.startSec + 0.4, end));
    const nextShot = sc.shots[shotIndex + 1];
    if (nextShot && sc.endSec - end < 0.4) end = Math.max(shot.startSec + 0.4, sc.endSec - 0.4);
    shot.endSec = round3(end);
    shot.duration = round3(shot.endSec - shot.startSec);
    shot.cutAt = shot.startSec;
    if (nextShot) {
      nextShot.startSec = shot.endSec;
      nextShot.duration = round3(Math.max(0.4, nextShot.endSec - nextShot.startSec));
      nextShot.cutAt = nextShot.startSec;
    }
    sc.duration = round3(sc.shots.reduce((s, sh) => s + sh.duration, 0));
  }
  const fit = snapGenerationDuration(sc.duration, next.genDefaults && next.genDefaults.allowedDurations);
  const prev = sc.gen || {};
  const hadClip = !!(prev.assetId);
  sc.gen = {
    status: hadClip ? 'stale' : (prev.status || 'idle'),
    assetId: prev.assetId || null,
    actualSec: prev.actualSec == null ? null : prev.actualSec,
    history: Array.isArray(prev.history) ? prev.history : [],
    stale: hadClip || !!prev.stale,
    requestSec: fit.requestSec,
    slotSec: fit.slotSec,
    warn: fit.warn || '',
  };
  return next;
}

export function sectionLabelZh(label) {
  return {
    intro: '前奏', verse: '主歌', 'pre-chorus': '预副歌', chorus: '副歌',
    bridge: '桥段', breakdown: '拆段', outro: '尾奏', instrumental: '间奏', unknown: '段落',
  }[label] || '段落';
}

/** 给工具回执用的切段预览（与画布 planShotSegments 同一条铁律：continuation 不跨段）。 */
export function groupShotsForClips(shots, maxSeconds) {
  const max = Math.max(1, num(maxSeconds, 15));
  const cuts = new Set(['opening', 'scene_change', 'closeup', 'new_character', 'state_jump']);
  const groups = [];
  let cur = [];
  let acc = 0;
  (shots || []).forEach((shot, i) => {
    const d = num(shot && shot.duration, 0);
    const seg = String((shot && shot.seg) || 'continuation');
    if (i > 0 && cuts.has(seg) && cur.length) {
      groups.push(cur);
      cur = [];
      acc = 0;
    } else if (cur.length && acc + d > max + 1e-6) {
      groups.push(cur);
      cur = [];
      acc = 0;
    }
    cur.push(i);
    acc += d;
  });
  if (cur.length) groups.push(cur);
  return groups.map((idxs) => ({
    shotIndexes: idxs.map((i) => i + 1),
    duration: round1(idxs.reduce((s, i) => s + num(shots[i] && shots[i].duration, 0), 0)),
  }));
}

export function analysisDigest(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;
  const a = analysis;
  return {
    schema: a.schema || AUDIO_ANALYSIS_SCHEMA,
    source: a.source || 'local-fallback',
    method: a.method || 'mock',
    model: a.model || null,
    durationSec: num(a.durationSec, 0),
    bpm: a.bpm == null ? null : num(a.bpm, 0),
    timeSignature: a.timeSignature || null,
    mood: a.mood || '',
    genre: Array.isArray(a.genre) ? a.genre : [],
    instrumentation: Array.isArray(a.instrumentation) ? a.instrumentation : [],
    vocals: a.vocals || { present: false, language: null, style: null },
    sections: Array.isArray(a.sections) ? a.sections : [],
    lyrics: Array.isArray(a.lyrics) ? a.lyrics.slice(0, 80) : [],
    imagery: Array.isArray(a.imagery) ? a.imagery : [],
    motif: a.motif || '',
    summary: a.summary || '',
    warnings: Array.isArray(a.warnings) ? a.warnings : [],
    beatCount: Array.isArray(a.beats) ? a.beats.length : 0,
  };
}

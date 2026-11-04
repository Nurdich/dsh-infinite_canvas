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
/**
 * DashScope：Base64 字符串必须 < 10MB。留出 JSON 信封，并低于宿主代理 16MB 上限。
 * 与 client.js 里的同名预算函数保持一致（scripts/test-audio-drive.mjs 会比对函数体）。
 */
export const AUDIO_BASE64_LIMIT = 9500000;

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
    '你在听一首完整的歌。请真正理解它（节奏、结构、情绪、配器、歌词、适合的画面），只返回一个 JSON 对象，不要 markdown，不要解释。',
    'JSON 字段：',
    '- bpm: 数字',
    '- timeSignature: 如 "4/4"',
    '- key: 调性，不确定就 null',
    '- beats: 拍点时间（秒，从 0 起，升序）',
    '- downbeats: 小节第一拍的时间（秒）',
    '- sections: [{label,startSec,endSec,energy,mood}]。label 只能是 intro|verse|pre-chorus|chorus|bridge|breakdown|outro|instrumental。energy 为 0到1。段落首尾相接、覆盖全曲。',
    '- mood: 全曲情绪一句话',
    '- genre: 字符串数组',
    '- instrumentation: 字符串数组',
    '- vocals: {present:boolean, language:字符串或null, style:字符串或null}',
    '- lyrics: [{startSec,endSec,text}]，没有人声就空数组。text 用听到的原文。',
    '- imagery: 3到6 条可拍摄的画面建议（具体物件/空间/光，不要抽象形容词堆砌）',
    '- motif: 全片 1 个母题物',
    '- summary: 80 字以内，这首歌怎么听、画面该怎么跟',
    '时间单位一律是秒。不要编造听不到的歌词。',
  ].join('\n');
}

/**
 * OpenAI 兼容 Chat Completions 体。
 * Qwen-Omni（含 qwen3-omni-flash / qwen3.8-omni-flash）要求 stream=true，否则接口报错。
 * 这里在合并扩展参数之后仍强制 stream 与 modalities:["text"]（分析不要语音回传）。
 */
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
    summary: str(src.summary, 240),
    warnings,
  };
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

export async function callOmni({ baseUrl, apiKey, body, fetchImpl, timeoutMs }) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('当前环境没有 fetch，无法调用音频理解模型');
  const url = chatCompletionsUrl(baseUrl);
  const send = (b) => fetchFn(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + String(apiKey || '').trim(),
    },
    body: JSON.stringify(b),
    signal: AbortSignal.timeout(Math.max(5000, num(timeoutMs, 180000))),
  });
  let res = await send(body);
  let text = await res.text();
  if (!res.ok && res.status === 400 && body && body.response_format && /response_format|json_object/i.test(text)) {
    const retry = { ...body };
    delete retry.response_format;
    res = await send(retry);
    text = await res.text();
  }
  if (!res.ok) {
    const err = new Error('音频理解 HTTP ' + res.status + '：' + String(text || '').slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return parseOmniResponse(text);
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
    });
    const content = await callOmni({ baseUrl, apiKey, body, fetchImpl, timeoutMs: r.timeoutMs });
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

/**
 * 按段落和拍点铺镜头。
 * 切点（scene_change / closeup / opening）保证现有 planShotSegments 能在 ≤ maxClipSeconds 处切开，
 * 且不会把一段 continuation 拆进两次生成。单镜不超过 12s，短于 0.4s 的拍会合并（MV 规格 ASL 下限）。
 */
export function planMusicVideoShots(analysis, opts) {
  const a = normalizeAnalysis(analysis, {
    source: analysis && analysis.source,
    method: analysis && analysis.method,
    model: analysis && analysis.model,
    durationSec: analysis && analysis.durationSec,
    warnings: analysis && analysis.warnings,
  });
  const maxClip = Math.max(2, Math.min(15, num(opts && opts.maxClipSeconds, 15) || 15));
  const brief = str(opts && opts.brief, 400);
  const beats = beatGrid(a);
  const motif = a.motif || '一个反复出现的物件';
  const imagery = a.imagery.length ? a.imagery : ['与歌曲情绪一致的具体空间'];
  const shots = [];
  const dur = a.durationSec;

  const shotCap = Math.min(12, maxClip);
  const pushSpan = (start, end, section, indexInSection, hold) => {
    let t = start;
    const strat = strategyFor(section.label);
    const stepBeats = Math.max(1, strat.beats);
    const inSection = beats.filter((b) => b >= start - 0.001 && b < end - 0.001);
    const grid = inSection.length ? inSection : [start];
    let guard = 0;
    while (t < end - 0.05 && shots.length < 100) {
      let shotEnd = end;
      const beatIdx = grid.findIndex((b) => b >= t - 0.001);
      if (beatIdx >= 0) {
        const nxt = grid[beatIdx + stepBeats];
        shotEnd = nxt != null ? Math.min(end, nxt) : end;
      }
      if (shotEnd - t < 0.4) {
        shotEnd = Math.min(end, t + 0.4);
      }
      if (shotEnd - t > shotCap) shotEnd = t + shotCap;
      if (end - shotEnd < 0.4 && end - t <= shotCap) shotEnd = end;
      shotEnd = Math.min(end, shotEnd);
      if (!(shotEnd > t)) break;
      const localIndex = indexInSection + shots.filter((s) => s.sectionId === section.id).length;
      const isHold = !!(hold && localIndex === 0);
      const scale = isHold ? '大特写' : (localIndex === 1 ? '大特写' : (localIndex % 5 === 0 ? strat.scale : ['全景', '中景', '近景', '特写'][localIndex % 4]));
      const move = isHold ? '固定' : MOVES[(shots.length + localIndex) % MOVES.length];
      const img = imagery[shots.length % imagery.length];
      const lines = lyricsIn(a, t, shotEnd);
      const relBeats = beats.filter((b) => b >= t - 0.001 && b < shotEnd - 0.001).slice(0, 3);
      const span = shotEnd - t;
      const timeBeats = (span >= 2 ? [0, span * 0.45, span * 0.9] : relBeats.length ? relBeats.map((b) => b - t) : [0]).slice(0, span >= 2 ? 3 : 1).map((off, k, arr) => {
        const label = isHold
          ? (k === 0 ? '画面已经停住，主体不动' : k === arr.length - 1 ? '仍停在同一姿态，音乐自己走' : '只有光或灰尘在动')
          : (k === 0 ? '动作起势，身体或母题刚要动' : k === arr.length - 1 ? '落在下一拍之前，动作没做完' : '顺着拍点把动作推到中段');
        return round1(off) + 's ' + label;
      });
      const title = (isHold ? '停 · ' : '') + sectionLabelZh(section.label) + ' ' + (localIndex + 1);
      shots.push({
        title: title.slice(0, 40),
        duration: round1(shotEnd - t),
        startSec: round3(t),
        endSec: round3(shotEnd),
        sectionId: section.id,
        sectionLabel: section.label,
        visual: [
          scale + '，平视，主体落在三分法交点',
          '母题「' + motif + '」',
          img,
          strat.note,
          section.mood ? ('情绪：' + section.mood) : '',
          brief ? ('方向：' + brief) : '',
          isHold ? '音乐继续，画面停住——这是全片唯一的坠落感' : '',
        ].filter(Boolean).join('；') + '。',
        motion: isHold
          ? '起点：主体已经在画面里静止 → 镜头完全不动、只有环境微动 → 终点：停在同一姿态，不收成"已完成"'
          : '起点：' + scale + '里母题刚入画 → ' + move + '，动作卡在拍点上 → 终点：动作进行到一半，不站定',
        timeBeats,
        camera: '平视，35mm，运镜' + move + '，从本镜开始的构图走到下一拍之前',
        vfx: section.label === 'chorus' ? '光随副歌能量抬起，但不滥用光斑' : '',
        negative: 'off-beat cut, cut one frame after the beat, lip-sync drift, random slow motion, stock footage look, watermark, subtitle burned in, extra limbs',
        tail: isHold ? '主体仍停在同一姿态，目光不散，动作没有收完' : '动作进行到一半，母题还在手上或画面里，运镜没停死',
        cam: move + '，可被下一镜延续，不突然反向',
        start: '',
        seg: 'continuation',
        characters: [],
        scene: sectionLabelZh(section.label),
        props: motif ? [motif] : [],
        dialogue: lines.slice(0, 4).map((line) => ({ role: '人声', line: line.text })),
        sfx: '原曲声轨，切点落在拍上' + (a.instrumentation.length ? ('；' + a.instrumentation.slice(0, 3).join('、')) : ''),
        hold: isHold,
      });
      t = shotEnd;
      guard++;
      if (guard > 400) break;
    }
  };

  a.sections.forEach((section) => {
    const hold = section.label === 'bridge';
    pushSpan(section.startSec, section.endSec, section, 0, hold);
  });

  if (shots.length) {
    const last = shots[shots.length - 1];
    if (dur - last.endSec > 0.05 && dur - last.endSec <= shotCap) {
      const grown = round1(Math.max(0.4, dur - last.startSec));
      if (grown <= shotCap) {
        last.endSec = round3(dur);
        last.duration = grown;
      }
    }
  }

  let acc = 0;
  shots.forEach((shot, i) => {
    const prev = shots[i - 1];
    const sectionChanged = !prev || prev.sectionId !== shot.sectionId;
    if (i === 0) {
      shot.seg = 'opening';
      shot.start = '歌曲第 0 秒，画面从这一镜建立';
      acc = shot.duration;
      return;
    }
    if (sectionChanged || shot.hold) {
      shot.seg = shot.hold ? 'scene_change' : strategyFor(shot.sectionLabel).cut;
      if (shot.seg !== 'scene_change' && shot.seg !== 'closeup') shot.seg = 'scene_change';
      shot.start = '新段落「' + sectionLabelZh(shot.sectionLabel) + '」从这一镜切开，不接上一段的动作相位';
      acc = shot.duration;
      return;
    }
    if (acc + shot.duration > maxClip + 1e-6) {
      shot.seg = 'closeup';
      shot.visual = shot.visual.replace(/^(远景|全景|中景|近景|特写|大特写)/, '大特写');
      shot.start = '为了单次生成不超过 ' + maxClip + ' 秒，这一镜从切点开始（大特写），不接上一段尾帧';
      acc = shot.duration;
      return;
    }
    shot.seg = 'continuation';
    shot.start = '';
    acc += shot.duration;
  });

  const cleaned = shots.map((shot) => {
    const out = { ...shot };
    delete out.sectionId;
    delete out.hold;
    return out;
  });
  return {
    shots: cleaned,
    total: round1(cleaned.reduce((s, sh) => s + sh.duration, 0)),
    maxClipSeconds: maxClip,
    bpm: a.bpm,
    durationSec: a.durationSec,
    source: a.source,
    warnings: a.warnings || [],
  };
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

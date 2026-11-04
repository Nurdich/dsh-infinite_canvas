#!/usr/bin/env node
/**
 * 音频驱动 MV：请求形状、本地兜底、按拍分镜、对话工具。
 * 运行：node scripts/test-audio-drive.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

const AD = await import(pathToFileURL(path.join(ROOT, 'audio-drive.js')).href);

// ---------- 预算：client 与模块同一实现 ----------
{
  const mod = fs.readFileSync(path.join(ROOT, 'audio-drive.js'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  const grab = (src) => {
    const i = src.indexOf('function pcmBudget');
    return src.slice(i, i + 700).split('\n').slice(0, 13).map((l) => l.trim()).join('\n');
  };
  ok(grab(mod) === grab(client), 'client.js 的 pcmBudget 与 audio-drive.js 不一致');
  const short = AD.pcmBudget(30);
  ok(short.sampleRate === 16000 && short.truncated === false, '30s 应保持 16kHz 且不截断');
  const long = AD.pcmBudget(60 * 60);
  ok(long.truncated === true && long.sendSec > 0 && long.sendSec < 3600, '超长音频必须截断到 Base64 预算内');
  ok(long.sendSec * long.sampleRate * 2 <= long.rawBudget, '截断后的 PCM 仍超过预算');
}

// ---------- Omni 请求 ----------
{
  const body = AD.buildOmniChatBody({
    model: 'qwen3.8-omni-flash',
    audioBase64: 'AAAA',
    format: 'wav',
    extra: { stream: false, modalities: ['text', 'audio'], temperature: 0.2 },
  });
  ok(body.stream === true, '扩展参数不能关掉 stream（Qwen Omni 要求 stream=true）');
  ok(JSON.stringify(body.modalities) === JSON.stringify(['text']), '分析必须只要文本，不能回传语音');
  ok(body.temperature === 0.2, '其它扩展参数应保留');
  ok(body.model === 'qwen3.8-omni-flash', '模型 id 未写入请求');
  const audio = body.messages[0].content.find((c) => c.type === 'input_audio');
  ok(audio && audio.input_audio.format === 'wav', '缺少 input_audio.format');
  ok(audio && audio.input_audio.data === 'data:audio/wav;base64,AAAA', 'Base64 音频未包成 data URL');
  ok(AD.chatCompletionsUrl('https://dashscope.aliyuncs.com/compatible-mode/v1')
    === 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', '兼容模式 URL 拼接错误');
  ok(AD.chatCompletionsUrl('https://dashscope.aliyuncs.com')
    === 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', '裸域名应补 compatible-mode/v1');
  ok(AD.SUGGESTED_MODEL_ID === 'qwen3.8-omni-flash', '预填模型 id 不是官方 qwen3.8-omni-flash');
  ok(/Qwen3\.8-Omni-Flash/.test(AD.USER_MODEL_NAME), '文档用名应保留用户说的 Qwen3.8-Omni-Flash');
}

// ---------- SSE / JSON ----------
{
  const sse = [
    'data: {"choices":[{"delta":{"content":"{\\"bpm\\":128,"}}]}',
    'data: {"choices":[{"delta":{"content":"\\"summary\\":\\"ok\\"}"}}]}',
    'data: [DONE]',
  ].join('\n');
  const text = AD.parseOmniResponse(sse);
  const json = AD.extractJsonObject(text);
  ok(json && json.bpm === 128 && json.summary === 'ok', 'SSE 分片没有拼回 JSON：' + text);
  const once = AD.parseOmniResponse(JSON.stringify({ choices: [{ message: { content: '{"bpm":90}' } }] }));
  ok(AD.extractJsonObject(once).bpm === 90, '非流式 JSON 没有解析');
}

// ---------- 归一与本地兜底 ----------
{
  const norm = AD.normalizeAnalysis({
    bpm: 128, sections: [{ label: '副歌', startSec: 0, endSec: 8, energy: 2 }],
    lyrics: [{ startSec: 1, endSec: 3, text: '你好' }],
  }, { source: 'qwen-omni', method: 'model', model: 'qwen3.8-omni-flash', durationSec: 8 });
  ok(norm.schema === AD.AUDIO_ANALYSIS_SCHEMA, 'schema 名不对');
  ok(norm.source === 'qwen-omni' && norm.model === 'qwen3.8-omni-flash', '来源/模型丢失');
  ok(norm.sections[0].label === 'chorus', '中文段落名没有收成 chorus');
  ok(norm.sections[0].energy === 1, '能量没有夹到 0..1');
  ok(norm.vocals.present === true, '有歌词时 vocals.present 应为 true');
  ok(norm.durationSec === 8, '文件时长应优先');

  const energy = [];
  for (let i = 0; i < 80; i++) energy.push(i % 8 === 0 ? 1 : 0.05);
  const local = AD.heuristicAnalysis({ durationSec: 20, energy, hopSec: 0.25 });
  ok(local.source === 'local-fallback' && local.method === 'webaudio', '本地分析没有标明 local-fallback');
  ok(local.bpm && local.bpm >= 40 && local.bpm <= 240, '本地 BPM 不合理：' + local.bpm);
  ok(local.beats.length > 4 && local.sections.length >= 1, '本地分析没有拍点或段落');
  ok((local.warnings || []).some((w) => /本地|未配置/.test(w)), '本地分析缺少警告');

  const mock = AD.mockAnalysis(90);
  ok(mock.method === 'mock' && /占位/.test(mock.summary + mock.warnings.join('')), '占位分析没有标明');
  ok(Math.abs(mock.durationSec - 90) < 0.2, '占位时长不对');
}

// ---------- 有供应商才打网络；失败不伪装 ----------
{
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      return { ok: false, status: 400, text: async () => 'response_format is not supported' };
    }
    const chunk = 'data: {"choices":[{"delta":{"content":"{\\"bpm\\":100,\\"sections\\":[{\\"label\\":\\"verse\\",\\"startSec\\":0,\\"endSec\\":10}],\\"summary\\":\\"heard\\"}"}}]}\n\n';
    return { ok: true, status: 200, text: async () => chunk };
  };
  const heard = await AD.understandFromRequest({
    provider: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-test', model: 'qwen3.8-omni-flash' },
    audioBase64: 'AAAA',
    format: 'wav',
    durationSec: 10,
  }, fetchImpl);
  ok(calls === 2, 'response_format 被拒后应重试一次，实际 ' + calls);
  ok(heard.source === 'qwen-omni' && heard.bpm === 100 && heard.summary === 'heard', '模型结果没有归一');

  let boom = 0;
  const off = await AD.understandFromRequest({
    durationSec: 12,
    energy: [0.1, 0.9, 0.1, 0.9, 0.1, 0.8, 0.1, 0.9, 0.2, 0.7],
    hopSec: 0.5,
  }, () => { boom++; throw new Error('不应调用'); });
  ok(boom === 0 && off.method === 'webaudio', '没配供应商时不应打网络');
}

// ---------- 分镜对齐拍点，且能被现有切段器切开 ----------
{
  const analysis = AD.normalizeAnalysis({
    bpm: 120,
    timeSignature: '4/4',
    beats: Array.from({ length: 180 }, (_, i) => i * 0.5),
    sections: [
      { label: 'intro', startSec: 0, endSec: 8, energy: 0.2 },
      { label: 'verse', startSec: 8, endSec: 32, energy: 0.45 },
      { label: 'chorus', startSec: 32, endSec: 56, energy: 0.9 },
      { label: 'bridge', startSec: 56, endSec: 72, energy: 0.2, mood: '停' },
      { label: 'chorus', startSec: 72, endSec: 88, energy: 0.95 },
      { label: 'outro', startSec: 88, endSec: 90, energy: 0.2 },
    ],
    lyrics: [
      { startSec: 10, endSec: 12, text: '第一句' },
      { startSec: 40, endSec: 42, text: '副歌句' },
    ],
    imagery: ['雨里的红伞', '空的月台'],
    motif: '红伞',
    mood: '先收后放',
    summary: '测试曲',
  }, { source: 'qwen-omni', method: 'model', model: 'qwen3.8-omni-flash', durationSec: 90 });
  const plan = AD.planMusicVideoShots(analysis, { maxClipSeconds: 15, brief: '红伞不要解释歌词' });
  ok(plan.shots.length >= 8 && plan.shots.length <= 100, '镜头数量异常：' + plan.shots.length);
  ok(plan.shots[0].seg === 'opening', '第一镜应为 opening');
  ok(plan.shots.every((s) => s.duration >= 0.4 && s.duration <= 15), '存在短于 0.4s 或长于单次上限的镜头');
  const bridge = plan.shots.find((s) => s.sectionLabel === 'bridge');
  ok(bridge && /停/.test(bridge.visual + bridge.motion), '桥段没有「停」');
  const lyricShot = plan.shots.find((s) => (s.dialogue || []).some((d) => d.line === '副歌句'));
  ok(lyricShot && lyricShot.startSec <= 42 && lyricShot.endSec >= 40, '歌词没有落到对应时间的镜头');
  ok(plan.shots.some((s) => /大特写/.test(s.visual)), '没有任何大特写');
  const groups = AD.groupShotsForClips(plan.shots, 15);
  ok(groups.every((g) => g.duration <= 15.05), '预览切段超过 15s：' + JSON.stringify(groups.map((g) => g.duration)));
  let run = 0;
  let badRun = false;
  for (const s of plan.shots) {
    if (s.seg === 'continuation') run += s.duration;
    else { if (run > 15.05) badRun = true; run = s.seg === 'opening' ? s.duration : s.duration; }
  }
  if (run > 15.05) badRun = true;
  ok(!badRun, '连续 continuation 加起来超过 15 秒，现有切段器会硬切');

  // 用画布里的 planShotSegments 再验一次（同一套切点铁律）
  const SEG = loadSegmentPlanner();
  const segPlan = SEG.planShotSegments(plan.shots, { maxSeconds: 15 });
  ok(segPlan.segments.length >= 1, 'planShotSegments 没有产出');
  ok(segPlan.segments.every((s) => s.duration <= 15.2), 'planShotSegments 段时长超过 15s：' + segPlan.segments.map((s) => s.duration).join(','));
  ok(!segPlan.segments.some((s) => s.seamRisk === 'forced'), '按拍分镜被切段器标成硬切：' + (segPlan.warnings || []).join(' | '));
}

// ---------- 对话工具：分析 → 分镜 → 成片声轨 ----------
{
  const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-audio-'));
  process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
  process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');
  const tools = [];
  const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href + '?audio-test=1');
  mod.apply({
    effect(fn) { fn(); return () => {}; },
    get() { return undefined; },
    webServer: { register: () => () => {} },
    tools: { register: (def) => { tools.push(def); return () => {}; } },
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const name of ['canvas_analyze_audio', 'canvas_music_video']) {
    ok(byName.has(name), '缺少工具 ' + name);
  }
  const created = await byName.get('canvas_create_project').execute({ name: '音频MV测试' }, {});
  const projectId = created.projectId;
  ok(!!projectId, '没有建出项目');
  const energy = [];
  for (let i = 0; i < 40; i++) energy.push(i % 5 === 0 ? 0.9 : 0.1);
  const analyzed = await byName.get('canvas_analyze_audio').execute({
    projectId, durationSec: 20, energy, hopSec: 0.5, name: '测试曲',
  }, {});
  ok(analyzed.ok === true && analyzed.analysis && analyzed.analysis.source === 'local-fallback', '离线分析没有标明本地兜底');
  ok(analyzed.analysis.method === 'webaudio', '有能量曲线时应走 webaudio 而不是占位');
  const mv = await byName.get('canvas_music_video').execute({ projectId, nodeId: analyzed.nodeId, brief: '雨' }, {});
  ok(mv.ok === true && mv.shotCount > 0 && mv.segmentCount >= 1, 'MV 工具没有铺出分镜：' + (mv && mv.text));
  const sb = await byName.get('canvas_node_status').execute({ projectId, nodeId: mv.storyboardNodeId }, {});
  ok(Array.isArray(sb.shots) && sb.shots.length === mv.shotCount, '分镜表镜头数与工具回执不一致');
  ok(sb.shots.every((s) => ['opening', 'continuation', 'scene_change', 'closeup', 'new_character', 'state_jump'].includes(s.seg)), '分镜 seg 不在切段器认识的取值里');
  const audioStatus = await byName.get('canvas_node_status').execute({ projectId, nodeId: analyzed.nodeId }, {});
  ok(audioStatus.analysis && audioStatus.analysis.schema === 'dshic.audio-analysis.v1', '节点状态没有带回分析摘要');
  ok(/BPM|本地/.test(audioStatus.text), '状态文本没有分析摘要');
  const doc = JSON.parse(fs.readFileSync(path.join(process.env.DSH_IC_PROJECTS_DIR, projectId + '.json'), 'utf8'));
  const edges = doc.edges || [];
  ok(edges.some((e) => e.fromPort === 'analysis' && e.toPort === 'music' && e.toNode === mv.storyboardNodeId), '分析输出口没有连到分镜 music');
  ok(edges.some((e) => e.fromNode === analyzed.nodeId && e.fromPort === 'out' && e.toPort === 'music' && e.toNode === mv.finalcutNodeId), '原曲没有接到成片 music');
  ok(edges.some((e) => e.toNode === mv.finalcutNodeId && e.toPort === 'in'), '成片没有视频入口');
  const profile = doc.skillProfile || {};
  ok(profile.form === 'music-video', '项目规格没有写成 music-video');
  const again = await byName.get('canvas_analyze_audio').execute({ projectId, nodeId: analyzed.nodeId }, {});
  ok(again.cached === true, '已有分析应直接返回，不重复听');
}

function loadSegmentPlanner() {
  const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  const noop = () => {};
  const elStub = () => ({
    style: {}, dataset: {}, children: [], textContent: '', id: '',
    appendChild: noop, removeChild: noop, remove: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }),
    getContext: () => new Proxy({}, { get: (t, p) => (p === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true }),
    toDataURL: () => 'data:,', classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  });
  const documentStub = {
    createElement: () => elStub(),
    createTextNode: (t) => ({ nodeValue: String(t) }),
    head: elStub(), body: elStub(), documentElement: elStub(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
  };
  const lsStore = new Map();
  const lsStub = { getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, String(v)), removeItem: (k) => lsStore.delete(k), clear: () => lsStore.clear() };
  const sandbox = {
    window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, localStorage: lsStub, __DSH_IC_SMOKE__: true },
    document: documentStub, localStorage: lsStub,
    navigator: { userAgent: 'test-audio-drive', clipboard: { writeText: async () => {} } },
    location: { href: 'http://127.0.0.1:1/', reload: noop },
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) }),
    requestAnimationFrame: noop, cancelAnimationFrame: noop,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    console, performance, Blob, URL, AbortController, AbortSignal, structuredClone, crypto,
    Image: class { constructor() { this.src = ''; } },
    Audio: class { constructor() { this.src = ''; } },
    FileReader: class { readAsDataURL() {} readAsArrayBuffer() {} readAsText() {} },
    CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
    Event: class { constructor(t) { this.type = t; } },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    indexedDB: { open: () => { const req = {}; setTimeout(() => { try { req.onerror && req.onerror(); } catch { /* 忽略 */ } }, 0); return req; } },
    alert: noop, confirm: () => false, prompt: () => null,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  let pluginMod = null;
  sandbox.window.__ModuleLoader__ = { load(def) { pluginMod = def; } };
  vm.runInContext(src, sandbox, { filename: 'client.js' });
  const plugin = pluginMod.factory((name) => {
    if (name === 'react') {
      return {
        createElement: () => ({}),
        useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
        useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
        useCallback: (f) => f, useMemo: (f) => f(),
      };
    }
    throw new Error('意外 require: ' + name);
  });
  plugin.apply({ effect(fn) { fn(); }, locale: { register: noop, subscribe: () => () => {} }, slots: { inject(n, cb) { cb(); }, register: () => () => {} }, sidebarRightTabs: { register: () => () => {} } });
  if (!sandbox.window.__DSH_IC_SEGMENT__) throw new Error('未暴露 planShotSegments');
  return sandbox.window.__DSH_IC_SEGMENT__;
}

if (errs.length) {
  console.error('✗ 音频驱动测试失败 ' + errs.length + ' 项');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 音频驱动测试通过');
process.exit(0);

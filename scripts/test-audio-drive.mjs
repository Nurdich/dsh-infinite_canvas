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
import * as DshMedia from '../gen-pool.js';

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

{
  const thin = {
    schema: 'dshic.audio-analysis.v1',
    source: 'qwen-omni',
    method: 'model',
    durationSec: 180,
    bpm: 128,
    summary: '一首充满原始生命力的电子舞曲。镜头应紧贴地面高速移动，捕捉风吹动羊毛的质感与阳光刺眼的瞬间，剪辑节奏需完全卡在重拍上。',
    sections: [],
  };
  const pkg = AD.planMusicVideoPackage(thin, { style: '贴地高速、羊毛和刺眼阳光' });
  const shots = pkg.scenes.flatMap((sc) => sc.shots);
  ok(pkg.durationSec === 180, '三分钟曲子时长不是 180：' + pkg.durationSec);
  const sum = Math.round(shots.reduce((s, sh) => s + sh.duration, 0) * 10) / 10;
  ok(Math.abs(sum - 180) < 0.2, '镜头时长加总不是整首歌：' + sum);
  ok(pkg.scenes.every((sc) => sc.duration <= 15.05), '有场超过 15 秒');
  ok(shots.every((sh) => sh.imagePrompt && sh.videoPrompt && /景别/.test(sh.camera)), '缺关键帧/视频提示词或景别');
  ok(shots.every((sh) => /【风格锁】/.test(sh.videoPrompt)), '风格锁没有写进每镜视频提示词');
  ok(pkg.scenes.some((sc) => sc.join === 'continuous') && pkg.scenes.some((sc) => sc.join === 'cut'), '硬切和续帧没有同时出现');
  ok(pkg.scenes.every((sc) => sc.refs && sc.refs.locations && sc.refs.locations.length), '场上没有绑定场景参考');
  const snap = AD.snapGenerationDuration(7.2);
  ok(snap.requestSec === 8 && snap.slotSec === 7.2 && snap.warn, '7.2 秒没有吸到 8 秒并给出裁切说明');
  const edited = AD.patchPackageShot(pkg, 0, 0, { videoPrompt: '改过的提示词', duration: 6 });
  ok(edited.scenes[0].shots[0].videoPrompt === '改过的提示词', '改提示词没有写回');
  ok(edited.scenes[0].gen && edited.scenes[0].gen.requestSec, '改完没有重算生成时长');
  const sg = AD.AUDIO_ENDPOINT_PRESETS.find((p) => p.id === 'singapore');
  ok(sg && sg.baseUrl.includes('ap-southeast-1') && sg.model === 'qwen3-omni-flash', '新加坡端点预设不对');
}

{
  const diffs = [0, 0.02, 0.5, 0.03, 0.04, 0.4];
  const cuts = AD.cutsFromDiffs(diffs, 1, 0.18);
  ok(cuts[0] === 0 && cuts.includes(2) && cuts.includes(5), '帧差切点不对：' + cuts.join(','));
  const remix = AD.buildRemixPackage({ durationSec: 40, summary: '原片' }, {
    cuts: [10, 22],
    descriptions: ['人物冲镜', '侧脸特写', '拉远'],
    replacements: [{ name: '糯糯' }],
    style: '恶搞，人物替换',
    keep: [1],
    provider: { imageMode: 'edits' },
  });
  ok(remix.remix === true && remix.scenes.length >= 3, '翻拍没有按切点铺场');
  ok(Math.abs(remix.scenes.reduce((s, sc) => s + sc.duration, 0) - 40) < 0.2, '翻拍时长没有盖住原曲');
  ok(remix.scenes.every((sc) => sc.duration <= 15.05), '翻拍单场超过 15 秒');
  ok(remix.scenes[1].keep === true && remix.scenes[1].genMode === 'keep', '指定场没有保留原片');
  ok(remix.scenes[0].genMode === 'first-frame-edit', '图片编辑模式没有走关键帧编辑：' + remix.scenes[0].genMode);
  ok(/糯糯/.test(remix.scenes[0].shots[0].videoPrompt) && /恶搞/.test(remix.scenes[0].shots[0].videoPrompt), '替换角色或恶搞风格没有进提示词');
  const plain = AD.detectRemixCapabilities({});
  ok(plain.path === 'reference-to-video' && plain.videoToVideo === false, '缺省能力应该退到参考图重拍');
  const v2v = AD.detectRemixCapabilities({ videoExtra: '{"mode":"video-to-video"}' });
  ok(v2v.path === 'video-to-video' && /没有通用的视频到视频/.test(v2v.note), '提到视频编辑时没有说明实际退回');
}

{
  // 夹具：任意一首短歌，用来证明成片包只吃分析结果，不吃某支示例 MV 的故事或模型名。
  const pkg = AD.planMusicVideoPackage({
    durationSec: 48,
    bpm: 96,
    summary: '雨夜的器乐',
    characters: [{ name: '阿禾', desc: '短发，深色外套' }],
    locations: [{ name: '雨棚', desc: '夜里的公交站雨棚' }],
    sections: [
      { label: 'verse', startSec: 0, endSec: 24, visual: '鼓点很稳，贝斯在走' },
      { label: 'chorus', startSec: 24, endSec: 48, visual: '合成器铺开' },
    ],
    lyrics: [{ startSec: 2, endSec: 6, text: '测试句' }],
  }, { style: '冷色，手持', allowedDurations: [5, 10] });
  ok(pkg.script.includes('[Tempo Lock - 96 BPM]'), '剧本没有写上这首歌自己的 BPM');
  ok(pkg.sections[0].line.includes('鼓点很稳'), '段落说明没有用分析原文');
  ok(pkg.characters[0].faceId && pkg.characters[0].castingCount === 1, '角色缺少面孔或选角张数');
  ok(pkg.locations[0].mainPrompt && pkg.locations[0].multiViewPrompt && pkg.locations[0].hasMain === false, '场景主图/多视角没有从场景自己的描述来');
  ok(pkg.scenes.some((sc) => /阿禾×1/.test(sc.shots[0].videoPrompt)), '人数锁没有用这一包里的角色');
  ok(!/150 BPM|minimax|VaporWave|喜羊羊|一家四口/.test(JSON.stringify(pkg)), '成片包写进了示例片内容');
  ok(pkg.burnSubtitles === false && pkg.subtitleTrack[0].text === '测试句', '字幕没有留在可编辑轨上');
  ok(pkg.scenes.every((sc) => sc.duration <= 10.05), '没有按模型允许的最长秒数拆段');
  ok(pkg.genDefaults && pkg.genDefaults.model == null && pkg.genDefaults.allowedDurations[1] === 10, '模型名应留空，时长档应记下');
  ok(AD.missingSceneRefs(pkg).some((b) => b.location === '雨棚'), '没有主图时没有拦住');
  pkg.locations[0].hasMain = true;
  ok(AD.missingSceneRefs(pkg).length === 0, '主图齐了还在拦');
  const revised = AD.reviseShotPrompt(pkg, 0, 0, '多了一个人');
  ok(revised.scenes[0].awaitingConfirm && /多了一个人/.test(revised.scenes[0].shots[0].videoPrompt), '返修没有写进用户原话');
  ok(revised.scenes[1].shots[0].videoPrompt === pkg.scenes[1].shots[0].videoPrompt, '返修改动了别的镜');
  ok(AD.confirmShot(revised, 0).scenes[0].awaitingConfirm === false, '确认后仍停在待确认');
  ok(AD.snapGenerationDuration(7.2, [5, 10]).requestSec === 5, '自定义时长档没有就近吸附');
  const bare = AD.decorateMusicPackage({
    bpm: 100, durationSec: 8, treatment: { style: '只有光' },
    characters: [], locations: [],
    scenes: [{ sectionLabel: 'instrumental', startSec: 0, endSec: 8, duration: 8, shots: [{ duration: 8, visual: '光在动', videoPrompt: '光在动', camera: '景别远景' }] }],
  }, {});
  ok(bare.stages.find((s) => s.id === 'cast').status === 'skip', '没有角色时仍要求选角');
  ok(!/各只出现一人/.test(bare.scenes[0].shots[0].videoPrompt), '没有角色却写了人数锁');
}

{
  ok(AD.readAudioDuration({ decodedSec: 0, metadataSec: 245.2, storedSec: 0 }) === 245.2, '上传后的时长应读到解码或 metadata');
  ok(AD.readAudioDuration({}) === 0, '没有时长时不能编一个数');
  ok(AD.timelineLanePx(0, 800, 1) >= 800, '没有时长时轨道不能缩成短条');
  ok(AD.timelineLanePx(240, 800, 1) >= 240 * 8, '有时长时轨道要盖住整首歌');
  const flow = AD.mvCreateFlow({});
  ok(flow.current === 'upload' && flow.steps.length === 5, '流程应从上传开始');
  ok(AD.mvCreateFlow({ hasAudio: true }).current === 'analyze', '有歌后应进入听歌');
  ok(AD.mvCreateFlow({ hasAudio: true, hasAnalysis: true }).current === 'confirm', '听完应停在确认分段');
  ok(AD.mvCreateFlow({ hasAudio: true, hasAnalysis: true, confirmed: true }).current === 'style', '确认后才写风格');
  ok(AD.mvCreateFlow({ hasAudio: true, hasAnalysis: true, confirmed: true, hasPackage: true }).current === 'push', '有时间轴后才是推到画布');
  const windows = AD.planAudioWindows(400, { sampleRate: 16000, base64Limit: 9500000, overlapSec: 2 });
  ok(windows.length > 1 && windows[0].startSec === 0 && windows[windows.length - 1].endSec === 400, '长歌应切成覆盖全长的窗口：' + JSON.stringify(windows.map((w) => w.endSec)));
  ok(windows.every((w, i) => i === 0 || w.startSec < windows[i - 1].endSec), '窗口之间应该重叠');
  ok(AD.snapSectionBoundary(10.2, [8, 10, 12], 0.35) === 10, '段落边界应吸到最近的拍');
  ok(AD.snapSectionBoundary(10.9, [8, 10], 0.35) === 10.9, '离拍太远不应被吸走');
  const moved = AD.moveSectionBoundary([{ startSec: 0, endSec: 10, label: 'verse' }, { startSec: 10, endSec: 20, label: 'chorus' }], 0, 'end', 12.1, [8, 12, 16]);
  ok(moved[0].endSec === 12 && moved[1].startSec === 12, '拖边界应同时改相邻段');
  const slices = AD.sectionsToSlices([{ startSec: 0, endSec: 10 }, { startSec: 10, endSec: 25 }, { startSec: 25, endSec: 40.5 }]);
  ok(Math.abs(AD.sliceDurationSum(slices) - 40.5) < 0.001, '切片时长加总应等于整首');
  const reasons = AD.sectionCutReasons([
    { label: 'intro', startSec: 0, endSec: 8, energy: 0.2 },
    { label: 'chorus', startSec: 8, endSec: 16, energy: 0.8 },
  ], { downbeats: [8], lyrics: [{ startSec: 8.1, endSec: 10, text: '一句' }] });
  ok(/段落变化/.test(reasons[1].cutReason) && /落在重拍/.test(reasons[1].cutReason), '切开的理由没有写上');
}

{
  const songDigest = AD.canvasDigest({
    nodes: { a1: { id: 'a1', type: 'audio', x: 0, y: 0, data: { label: '歌', assetId: 'song' } } },
    edges: [],
  }, ['a1']);
  const shot = AD.keywordCanvasAction('第2段太长了', songDigest, 'a1');
  ok(shot.tool === 'canvas_music_timeline_edit' && shot.args.sceneIndex === 1 && shot.args.nodeId === 'a1', '改某一段没有走统一助手：' + JSON.stringify(shot));
  ok(AD.gateCanvasAction(shot, { digest: songDigest }).allow === true, '改提示词被当成花钱');
  const styled = AD.keywordCanvasAction('做一个搞笑风的 MV', songDigest, 'a1');
  ok(styled.tool === 'canvas_music_timeline' && /搞笑/.test(styled.args.style), '风格没有交给时间轴：' + JSON.stringify(styled));
  const refAct = AD.keywordCanvasAction('用这张做参考', songDigest, 'a1', [{ kind: 'image', assetId: 'face-1', name: '脸.png' }]);
  ok(refAct.tool === 'canvas_create_node' && refAct.args.assetId === 'face-1' && refAct.args.type === 'image', '附件没有变成参考节点');
  const songAct = AD.keywordCanvasAction('分析这首歌', songDigest, '', [{ kind: 'audio', assetId: 'song-9', name: '歌.mp3' }]);
  ok(songAct.tool === 'canvas_analyze_audio' && songAct.args.assetId === 'song-9' && songAct.args.continueMv === true, '附件歌曲没有直接进入听歌和后续规划');
  const marker = 'data:image/png;base64,iVBORw0KGgoASSIST';
  const audioMark = 'data:audio/wav;base64,UklGRiASSIST';
  const videoMark = 'data:video/mp4;base64,AAAAASSIST';
  const mediaBody = AD.buildOmniTextBody({
    model: 'qwen3-omni-flash',
    system: 'sys',
    user: '看这三份',
    parts: [
      { kind: 'image', url: marker },
      { kind: 'audio', url: audioMark, format: 'wav' },
      { kind: 'video', url: videoMark },
    ],
  });
  const packed = JSON.stringify(mediaBody);
  ok(packed.includes(marker) && packed.includes('image_url') && packed.includes(audioMark) && packed.includes('input_audio') && packed.includes(videoMark) && packed.includes('video_url'), '全模态请求没有带上图片、音频和视频');
  ok(mediaBody.stream === true && JSON.stringify(mediaBody.modalities) === '["text"]', '带附件时仍要流式并且只回文字');
  const gen = AD.imageRefPayload([marker], 'generations');
  ok(gen.image && gen.image[0] === marker, '同一张图没有进入图片生成请求');
  const harness = AD.assistantPlannerRoute(null);
  ok(/不接受图片/.test(AD.rejectOmniAttachments(harness, [{ kind: 'image', assetId: 'face-1' }])) && !AD.rejectOmniAttachments({ route: 'omni' }, [{ kind: 'image' }]), '文本模型没有在发送前拒绝图片');
  const kept = AD.assistantHistoryAttachments([{ kind: 'image', assetId: 'face-1', name: '脸', mime: 'image/png', url: marker }]);
  ok(kept.length === 1 && kept[0].assetId === 'face-1' && !JSON.stringify(kept).includes('base64'), '历史里留下了图片正文');
  const sg = AD.assistantPlannerRoute({
    model: 'qwen3-omni-flash',
    baseUrl: 'https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1',
    apiKey: 'sk-test',
  });
  ok(sg.route === 'omni' && sg.model === 'qwen3-omni-flash' && sg.place === '新加坡', '配了新加坡音频理解却没有选它：' + JSON.stringify(sg));
  ok(AD.assistantPlannerRoute(null).route === 'harness', '没配音频理解时应改走文本模型');
  ok(AD.assistantPlannerRoute({ model: 'qwen3-omni-flash', baseUrl: sg.baseUrl, apiKey: '' }).route === 'harness', '没有 Key 不能当成已配置');
  const textBody = AD.buildOmniTextBody({
    model: 'qwen3-omni-flash', system: 'sys', user: 'hi', extra: { stream: false, modalities: ['text', 'audio'] },
  });
  ok(textBody.stream === true && JSON.stringify(textBody.modalities) === '["text"]', '助手规划必须强制 stream 且只要文本');
  ok(!JSON.stringify(textBody).includes('input_audio'), '纯文本规划不应带 input_audio');
  const bal = AD.explainModelError({ status: 400, message: 'Insufficient Balance' }, sg);
  ok(bal.brief === 'qwen3-omni-flash（新加坡）余额不足，请充值或在设置里换模型', '余额不足没有点名模型：' + bal.brief);
  ok(/Insufficient Balance/.test(bal.detail), '原文没有留在详情里');
  ok(/Key 无效/.test(AD.explainModelError({ status: 401, message: 'Unauthorized' }, sg).brief), '401 没有翻成 Key 无效');
  ok(/过于频繁/.test(AD.explainModelError({ status: 429, message: 'rate limit' }, sg).brief), '429 没有翻成限流');
  ok(/超时/.test(AD.explainModelError({ message: 'The request timed out' }, sg).brief), '超时没有翻成中文');
  const hostSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  ok(!hostSrc.includes('audioAssistantTurn') && !hostSrc.includes('runMvAssistantTurn'), '音频节点助手的接口还在');
  const turnSrc = hostSrc.slice(hostSrc.indexOf('async canvasAssistantTurn'), hostSrc.indexOf('async audioPlanStoryboard'));
  ok(turnSrc.includes('rejectOmniAttachments') && turnSrc.includes('parts: mediaParts'), '统一助手没有在拒绝之后才把附件放进请求');
  const omniBranch = turnSrc.split("route.route === 'omni'")[1].split('} else if (step === 0)')[0];
  ok(omniBranch && !omniBranch.includes('complete('), '配了音频理解时仍会改走默认文本模型');
  const clientSrc = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  const analyzeFn = clientSrc.slice(clientSrc.indexOf('async function genAudioNode'), clientSrc.indexOf('async function genStoryboardNode'));
  ok(analyzeFn.includes('tlNeedOmni') && !analyzeFn.includes('complete('), '听歌分析在没配音频理解时不应去叫文本模型');
}

{
  const pkg = AD.planMusicVideoPackage({
    durationSec: 30, bpm: 100, summary: '夜里赶路', style: '',
    sections: [
      { label: 'verse', startSec: 0, endSec: 15, visual: '人还在门口犹豫' },
      { label: 'chorus', startSec: 15, endSec: 30, visual: '推开门走进雨里' },
    ],
    characters: [{ name: '阿禾', desc: '短发' }],
    locations: [{ name: '巷口', desc: '湿漉漉的砖墙' }],
  }, { style: '手持，冷色' });
  ok(pkg.story && pkg.story.source === 'template' && /模板/.test(pkg.story.label), '没有模型时应给出标明的故事骨架');
  ok(pkg.story.logline && pkg.story.synopsis && pkg.story.beats.length >= 2, '故事缺少一句话、梗概或按段情节');
  ok(/推开门走进雨里|音乐进来/.test(pkg.scenes[pkg.scenes.length - 1].shots[0].plotBeat || pkg.scenes[pkg.scenes.length - 1].shots[0].visual), '镜头没有接上这一段的情节');
  const person = pkg.characters[0];
  ok(person.name === '阿禾' && person.appearance && person.appearance.face && person.appearance.hair && person.appearance.build, '角色缺少脸、头发或体态');
  ok(person.role && person.arc && person.imagePrompt && /脸|头发/.test(person.imagePrompt) && /三视图|正面、侧面、背面/.test(person.imagePrompt) && !/无文字|Male Lead/.test(person.imagePrompt), '角色图提示词应带具体外观和三视图：' + person.imagePrompt);
  ok(!/无文字/.test(pkg.locations[0].imagePrompt) && /砖墙/.test(pkg.locations[0].imagePrompt), '场景图没有用上具体描述');
  ok(pkg.imageSuffix && !person.imagePrompt.includes(pkg.imageSuffix), '出图约束不应出现在可编辑提示词里');
  const edited = AD.planMusicVideoPackage({
    durationSec: 30, bpm: 100, summary: '夜里赶路',
    sections: [
      { label: 'verse', startSec: 0, endSec: 15 },
      { label: 'chorus', startSec: 15, endSec: 30 },
    ],
  }, { style: '手持', story: Object.assign({}, pkg.story, { logline: '阿禾必须在雨停前把信送到', source: 'edited' }) });
  ok(edited.story.logline === '阿禾必须在雨停前把信送到' && edited.story.source === 'edited', '改过的剧情没有进入重算');
  ok(AD.promptForImageSend('一张脸', '不要出现文字、字幕、水印或标志').endsWith('不要出现文字、字幕、水印或标志'), '发送时没有补上隐藏约束');
  ok(!/无文字/.test(AD.presentImagePrompt('角色，无文字')), '可见提示词没有去掉无文字');
}

// ---------- 先定稿角色和场景，再出分镜和视频 ----------
{
  const open = [
    { role: 'char', name: '阿禾', assetId: '', locked: false },
    { role: 'loc', name: '巷口', assetId: 'loc-1', locked: false },
  ];
  const missing = DshMedia.missingRefsForShot({ characters: ['阿禾'], scene: '巷口' }, open);
  ok(missing.some((m) => m.name === '阿禾' && m.why === 'missing'), '没有图的角色没有拦住分镜');
  ok(missing.some((m) => m.name === '巷口' && m.why === 'unlocked'), '没定稿的场景没有拦住分镜');
  const ready = DshMedia.missingRefsForShot({ characters: ['阿禾'], scene: '巷口' }, [
    { role: 'char', name: '阿禾', assetId: 'c1', locked: true },
    { role: 'loc', name: '巷口', assetId: 'l1', locked: true },
  ]);
  ok(ready.length === 0, '定稿后的角色和场景仍被拦住');
  const plan = AD.mvWirePlan({ scenes: [{ shots: [{ characters: ['阿禾'], scene: '巷口', props: [] }] }] });
  ok(plan.some((e) => e.fromRole === 'char' && e.fromName === '阿禾' && e.toKey === 'kf:0:0' && e.toPort === 'ref'), '角色图没有接到分镜参考');
  ok(plan.some((e) => e.fromRole === 'loc' && e.fromName === '巷口' && e.toKey === 'kf:0:0' && e.toPort === 'ref'), '场景图没有接到分镜参考');
  ok(plan.some((e) => e.fromKey === 'kf:0:0' && e.toKey === 'vid:0' && e.toPort === 'frame'), '分镜图没有作为视频首帧');
  ok(plan.some((e) => e.fromRole === 'char' && e.toKey === 'vid:0' && e.toPort === 'ref'), '角色图没有接到视频参考');
  const progress = AD.refProgress([
    { role: 'char', assetId: '1', locked: true },
    { role: 'char', assetId: '2', locked: true },
    { role: 'char', assetId: '3', locked: true },
    { role: 'loc', assetId: '4', locked: true },
    { role: 'loc', assetId: '5', locked: true },
    { role: 'loc', assetId: '', locked: false },
    { role: 'loc', assetId: '', locked: false },
    { role: 'shot', assetId: '', locked: false },
  ]);
  ok(progress.characters.locked === 3 && progress.characters.total === 3, '角色进度不是 3/3');
  ok(progress.locations.locked === 2 && progress.locations.total === 4, '场景进度不是 2/4');
  ok(progress.shots.have === 0 && progress.shots.total === 1 && progress.stage === 'refs', '设定没齐时不应进入分镜阶段');
  const down = AD.downstreamOf([{ fromNode: 'c', toNode: 'k' }, { fromNode: 'k', toNode: 'v' }], 'c');
  ok(down.indexOf('k') >= 0 && down.indexOf('v') >= 0, '重生成设定没有找到下游分镜和视频');
  const oldNodes = {
    hero: { id: 'hero', type: 'image', data: { label: '男主角', prompt: '我手改过的脸', assetId: 'keep-me', refLock: true } },
    shot: { id: 'shot', type: 'text', data: { label: 'MV 剧照 1', prompt: '不要动这段文字' } },
  };
  const repaired = AD.planRefRepair({
    characters: [{ name: '男主角', appearance: { face: '瘦脸', hair: '黑发' } }],
    locations: [{ name: '旧巷' }],
  }, oldNodes, 'audio-1');
  const adopt = repaired.actions.find((a) => a.op === 'adopt' && a.name === '男主角');
  const create = repaired.actions.find((a) => a.op === 'create' && a.name === '旧巷');
  ok(adopt && adopt.nodeId === 'hero' && adopt.keepAsset && !adopt.patch.prompt && adopt.patch.mvRole === 'char' && adopt.patch.refName === '男主角', '旧画布没有按名字认领角色图，或改写了手改提示词');
  ok(create && create.role === 'loc' && /旧巷/.test(create.prompt), '缺的场景图没有准备新建');
  ok(!repaired.actions.some((a) => a.nodeId === 'shot'), '文字分镜卡被当成了参考图');
  const sheetUrl = 'data:image/png;base64,abc';
  const sceneUrl = 'data:image/png;base64,def';
  const sent = AD.imageRefPayload([sheetUrl, sceneUrl], 'generations');
  ok(sent.state === 'sent' && sent.field === 'image' && sent.image[0] === sheetUrl && sent.image[1] === sceneUrl, '图片请求没有带上参考图字节');
  ok(AD.strippedRefIsFailure('image', 2) === true && AD.strippedRefIsFailure('watermark', 2) === false, '剥掉参考图字段仍会被当成成功');
  const both = AD.videoConditionPlan({ hasFrameBlob: true, refCount: 2, frameMode: 'auto', refCap: 8 });
  ok(both.state === 'downgraded' && both.field === 'reference_image' && both.sendRefs === 3 && both.dropped === 0, '首帧和参考图没有一起进入视频请求计划');
  const tight = AD.videoConditionPlan({ hasFrameBlob: true, refCount: 4, frameMode: 'auto', refCap: 3 });
  ok(tight.sendRefs === 3 && tight.dropped === 2 && /另外 2 张/.test(tight.say) && /其余 2 张这次没有送出/.test(tight.say) && !/另外 4/.test(tight.say), '首帧占名额后仍宣称全部参考图都会送出：' + tight.say);
  const blocked = AD.videoConditionPlan({ hasFrameBlob: false, refCount: 0 });
  ok(blocked.state === 'missing', '没有图时视频计划仍是成功');
  const unsupported = AD.videoConditionPlan({ hasFrameBlob: true, refCount: 2, refCap: 0 });
  ok(unsupported.state === 'unsupported' && /送不进去/.test(unsupported.say), '不支持参考图的模型没有被拦住');
  const client = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  ok(client.includes("data-tl-gen-chars") && client.includes('生成角色图') && client.includes('生成设定图'), '音乐节点上没有生成角色图入口');
  ok(client.includes('没有把去掉参考图的结果当成成功') && client.includes('没有改走不带图片的 /v1/videos'), '参考图失败后仍会改成纯文字成功');
  ok(client.includes("hostRpc('mvRepairRefs'"), '旧画布修复没有接到主机');
  const host = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  ok(host.includes('async mvRepairRefs') && host.includes('planRefRepair'), '主机没有补角色图的接口');
  ok(!/function videoConditionPlan/.test(client) && client.includes("hostRpc('mediaFit'"), '页面仍抄了一份视频参考计划，没有改走宿主');
  ok(fs.readFileSync(path.join(ROOT, 'audio-drive.js'), 'utf8').includes('export function videoConditionPlan'), '宿主侧的视频参考计划被删掉了');
  const foreign = AD.planRefRepair({ characters: [{ name: '男主角' }], locations: [] }, {
    other: { id: 'other', type: 'image', data: { label: '男主角', mvFrom: 'audio-2', assetId: 'nope' } },
  }, 'audio-1');
  ok(foreign.actions[0] && foreign.actions[0].op === 'create', '另一首歌的角色图被认领了');
}

// ---------- 失败后再生成：先分类，再改参数 ----------
{
  ok(AD.classifyGenFailure('DataInspectionFailed: sexual content', 400) === 'moderation', '审核失败没有归到内容审核');
  ok(AD.classifyGenFailure('Insufficient Balance', 400) === 'balance', '余额不足不应再试');
  ok(AD.classifyGenFailure('Unauthorized', 401) === 'auth', '401 应停在密钥');
  ok(AD.classifyGenFailure('prompt is too long', 400) === 'long', '过长提示词没有识别');
  ok(AD.classifyGenFailure('duration 20 is unsupported', 400) === 'duration', '不支持的时长没有识别');
  ok(AD.classifyGenFailure('aspect ratio is not supported', 400) === 'resolution', '比例不支持没有识别');
  ok(AD.classifyGenFailure('image too large', 400) === 'ref', '参考过大没有识别');
  ok(AD.classifyGenFailure('HTTP 503', 503) === 'transient' && AD.classifyGenFailure('429 rate limit', 429) === 'transient', '超时和 5xx/429 应原参数再试');
  ok(AD.classifyGenFailure('无法解析 JSON', 200) === 'empty', '空结果或乱码应加严');
  ok(AD.classifyGenFailure('完全没见过的错', 400) === 'unknown', '未知原因应先原样再试一次');
  const safe = AD.adaptGenAttempt({ message: '内容审核未通过 nude', params: { prompt: '裸体的人站在雨里' } });
  ok(safe.kind === 'moderation' && safe.auto && /服装完整/.test(safe.params.prompt) && safe.change === '已改写提示词以通过审核', '审核失败没有改写提示词：' + safe.params.prompt);
  const llm = AD.adaptGenAttempt({ message: 'safety policy', params: { prompt: '原提示' }, rewrittenPrompt: '改成穿外套的人' });
  ok(llm.params.prompt === '改成穿外套的人', '有模型改写时应该用模型的句子');
  const dur = AD.adaptGenAttempt({ message: 'duration is unsupported', params: { duration: 20, allowedDurations: [4, 5, 6, 8, 10, 12, 15] } });
  ok(dur.params.duration === 15 && dur.change === '时长 20s→15s', '时长没有收到允许档：' + dur.change);
  const long = AD.adaptGenAttempt({ message: 'prompt too long', params: { prompt: '甲'.repeat(900) } });
  ok(long.kind === 'long' && long.params.prompt.length < 900 && /字/.test(long.change), '过长提示词没有缩短');
  const again = AD.adaptGenAttempt({ message: '完全没见过的错', params: { prompt: '保持' }, history: [{ kind: 'unknown', auto: true }] });
  ok(again.auto === false && /停止/.test(again.say), '未知原因原样试过一次后还应继续');
  const capped = AD.adaptGenAttempt({ message: 'duration is unsupported', params: { duration: 20 }, history: [{ auto: true }, { auto: true }] });
  ok(capped.auto === false, '自动改参数超过 2 次还应继续');
  const pay = AD.adaptGenAttempt({ message: '余额不足', params: { prompt: 'x' } });
  ok(pay.auto === false && pay.kind === 'balance', '余额不足仍会自动重试');
  const digest = AD.canvasDigest({ nodes: { a: { id: 'a', type: 'video', data: { label: '段1', status: 'error', adapt: { kind: 'duration', say: '时长不对', change: '时长 20s→15s' } } } } }, ['a']);
  ok(digest.nodes[0].failure && digest.nodes[0].failure.change === '时长 20s→15s', '画布摘要没有带上失败原因');
  const why = AD.keywordCanvasAction('为什么失败', digest, 'a');
  ok(/时长不对/.test(why.say) && !why.tool, '助手没有解释失败原因');
  const redo = AD.keywordCanvasAction('重生成失败项', digest);
  ok(redo.clientJob === 'regen-failed' && redo.spends === true, '重生成失败项没有标成要确认的生成');
  const gated = AD.gateCanvasAction(redo, { digest });
  ok(gated.allow === false && gated.preview && gated.preview.count === 1, '花钱的失败重跑没有确认');
  ok(AD.gateCanvasAction(redo, { digest, confirmed: true }).allow === true, '确认后失败重跑仍被拦住');
}

// ---------- 听歌超时、重试、流式增量 ----------
{
  const short = AD.analysisBudget({ durationSec: 30 });
  ok(short.idleMs === 90000 && short.totalMs === 10 * 60 * 1000, '短歌应按 90 秒静默、至少 10 分钟：' + JSON.stringify(short));
  const mid = AD.analysisBudget({ durationSec: 5 * 60 });
  ok(mid.totalMs === 20 * 60 * 1000, '5 分钟的窗口应按 4 倍给 20 分钟');
  const long = AD.analysisBudget({ durationSec: 10 * 60 });
  ok(long.totalMs === 30 * 60 * 1000, '超长窗口应封顶 30 分钟');
  const custom = AD.analysisBudget({ durationSec: 30, idleMs: 120000 });
  ok(custom.idleMs === 120000 && custom.totalMs === 10 * 60 * 1000, '设置里的分析超时应改静默上限');
  ok(AD.analysisOuterMaxMs() === 30 * 60 * 1000 * 3 + 2000 + 6000 + 15000, '外层等待短于三次总时长加退避');
  ok(AD.analysisOuterMs(mid) >= mid.totalMs * 3, '外层没有盖住这一段的全部尝试');
  const sentence = AD.explainAnalysisTimeout({ windowIndex: 1, windowCount: 5, elapsedMs: 182000, idleMs: 90000, reason: 'idle' });
  ok(sentence === '第 2/5 段在 3 分 02 秒后超时（90 秒没有新数据），可点重试。', '超时句子不对：' + sentence);
  const acc = AD.createSseAccumulator();
  acc.push('data: {"choices":[{"delta":{"reasoning_content":"先想"}}]}\n');
  const split = 'data: {"choices":[{"delta":{"content":"{\\"bpm\\":"}}]}\nda';
  acc.push(split.slice(0, 20));
  acc.push(split.slice(20) + 'ta: {"choices":[{"delta":{"content":"90}"}}]}\n');
  const done = acc.finish();
  ok(done.reasoning === '先想' && done.text === '{"bpm":90}', '流式增量没有拼上思考或回答：' + JSON.stringify(done));
  const chunks = [];
  const fetchStream = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n'));
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"{\\"bpm\\":90}"}}]}\n\n'));
        controller.close();
      },
    }),
  });
  const seen = [];
  const streamed = await AD.callOmni({
    baseUrl: 'https://example.invalid/v1', apiKey: 'sk', durationSec: 30, idleMs: 5000,
    body: { model: 'm' }, fetchImpl: fetchStream,
    onDelta: (d) => seen.push(d.text + '|' + d.reasoning),
  });
  ok(streamed.includes('90') && seen.some((s) => s.includes('想')), '流式回调没有在整段结束前吐出增量');
  let hung = true;
  const fetchHang = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半截歌词"}}]}\n\n'));
      },
      cancel() { hung = false; },
    }),
  });
  let timed = null;
  try {
    await AD.callOmni({
      baseUrl: 'https://example.invalid/v1', apiKey: 'sk', durationSec: 30, idleMs: 80, totalMs: 5000,
      body: { model: 'm' }, fetchImpl: fetchHang, windowIndex: 1, windowCount: 5,
    });
  } catch (e) { timed = e; }
  ok(timed && timed.timeout && timed.partial && timed.partial.text === '半截歌词', '静默超时没有留下已收到的文字');
  ok(/第 2\/5 段/.test(timed && timed.brief) && /重试/.test(timed && timed.brief), '超时错误没有指明窗口和重试');
  ok(hung === false, '静默超时没有取消还挂着的流');
  let tries = 0;
  const sleeps = [];
  const recovered = await AD.callOmniWithRetry({
    baseUrl: 'https://example.invalid/v1', apiKey: 'sk', durationSec: 10,
    body: { model: 'm' },
    sleep: async (ms) => { sleeps.push(ms); },
    fetchImpl: async () => {
      tries += 1;
      if (tries < 3) return { ok: false, status: 503, text: async () => 'unavailable' };
      return { ok: true, status: 200, text: async () => 'data: {"choices":[{"delta":{"content":"{\\"bpm\\":110}"}}]}\n\n' };
    },
  });
  ok(tries === 3 && sleeps[0] === 2000 && sleeps[1] === 6000 && String(recovered).includes('110'), '5xx 没有按退避重试两次');
  const kept = [];
  let windowErr = null;
  try {
    await AD.runWindows([{ offsetSec: 0 }, { offsetSec: 30 }], async (w) => {
      if (w.offsetSec === 30) { const e = new Error('timeout'); e.timeout = true; e.brief = '第 2/2 段超时，可点重试。'; e.partial = { text: '后半' }; throw e; }
      return { bpm: 100 };
    }, { sleep: async () => {} });
  } catch (e) { windowErr = e; }
  ok(windowErr && windowErr.parts && windowErr.parts.length === 1 && windowErr.parts[0].analysis.bpm === 100, '失败窗口把已经听完的结果丢掉了');
  ok(windowErr.partial && windowErr.partial.text === '后半', '失败窗口没有留下半截文本');
  const host = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const analyzeTool = host.slice(host.indexOf("name: 'canvas_analyze_audio'"), host.indexOf("name: 'canvas_music_timeline'"));
  ok(analyzeTool.includes('timeoutMs: analysisOuterMaxMs()') && !analyzeTool.includes('timeoutMs: 180000'), '分析工具仍是 180 秒');
  ok(!host.includes('AbortSignal.timeout') || !/callOmni[\s\S]{0,400}AbortSignal\.timeout\(/.test(host), '宿主仍用固定超时包住分析');
  const drive = fs.readFileSync(path.join(ROOT, 'audio-drive.js'), 'utf8');
  ok(!drive.includes('timeoutMs: r.timeoutMs || 60000'), '描述帧仍用 60 秒硬超时');
  ok(!/AbortSignal\.timeout\(Math\.max\(5000/.test(drive), 'callOmni 仍在 180 秒处中断整段流');
  const clientSrc3 = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  ok(clientSrc3.includes('30 * 60 * 1000 * 3 + 2000 + 6000 + 15000'), '客户端等待短于内层预算');
  ok(clientSrc3.includes('audioProgress') && clientSrc3.includes('analyzePartial') && clientSrc3.includes('caThinking'), '界面没有轮询进度或展示半截文本');
  ok(clientSrc3.includes("T('tlRetry')") && clientSrc3.includes('analyzeParts'), '超时后不能从失败的那段继续');
}

// ---------- 画布助手：跨节点调度与确认门 ----------
{
  const graph = {
    nodes: {
      t1: { id: 't1', type: 'text', data: { label: '旁白', text: '旧' } },
      s1: { id: 's1', type: 'script', data: { label: '剧本' } },
      b1: { id: 'b1', type: 'storyboard', data: { label: '分镜' } },
      i1: { id: 'i1', type: 'image', data: { label: '角色甲', prompt: '白天', imageModel: 'img-a', count: 2 } },
      v1: { id: 'v1', type: 'video', data: { label: '镜头', duration: 6, videoModel: 'vid-a' } },
      a1: { id: 'a1', type: 'audio', data: { label: '歌' } },
      f1: { id: 'f1', type: 'finalcut', data: { label: '成片' } },
    },
    edges: [{ id: 'e1', fromNode: 't1', toNode: 'i1', fromPort: 'out', toPort: 'prompt' }],
  };
  const digest = AD.canvasDigest(graph, ['i1']);
  ok(digest.selection.length === 1 && digest.selection[0].id === 'i1', '摘要没有标出选中节点');
  ok(digest.edges[0] && digest.edges[0].from === 't1' && digest.edges[0].to === 'i1', '摘要没有连线');
  ok(AD.canvasContextChip(digest) === '当前：角色甲 图片节点', '上下文条没有写成选中节点：' + AD.canvasContextChip(digest));
  ok(AD.keywordCanvasAction('新建一个文本节点', digest).args.type === 'text', '没有调度文本节点');
  ok(AD.keywordCanvasAction('新建一个剧本节点', digest).args.type === 'script', '没有调度剧本节点');
  ok(AD.keywordCanvasAction('新建一个分镜节点', digest).args.type === 'storyboard', '没有调度分镜节点');
  ok(AD.keywordCanvasAction('新建一个图片节点', digest).args.type === 'image', '没有调度图片节点');
  ok(AD.keywordCanvasAction('新建一个视频节点', digest).args.type === 'video', '没有调度视频节点');
  ok(AD.keywordCanvasAction('新建一个音频节点', digest).args.type === 'audio', '没有调度音频节点');
  ok(AD.keywordCanvasAction('新建一个成片节点', digest).args.type === 'finalcut', '没有调度成片节点');
  const edit = AD.keywordCanvasAction('把这个提示词改成夜景', digest);
  ok(edit.tool === 'canvas_update_node' && edit.args.nodeId === 'i1' && edit.args.patch.prompt === '夜景', '这个没有指到选中的图片');
  ok(AD.gateCanvasAction(edit, { digest }).allow === true, '改提示词被误拦');
  const gen = AD.keywordCanvasAction('生成这个', digest);
  const blocked = AD.gateCanvasAction(gen, { digest, modelLabel: 'fallback' });
  ok(gen.tool === 'canvas_run_node' && gen.args.nodeId === 'i1', '生成这个没有打到选中图片');
  ok(blocked.allow === false && blocked.preview.kind === 'image' && blocked.preview.count === 2 && blocked.preview.model === 'img-a', '图片生成确认卡不对：' + JSON.stringify(blocked.preview));
  ok(AD.gateCanvasAction(gen, { digest, confirmed: true }).allow === true, '确认后图片生成仍被拦住');
  const vdigest = AD.canvasDigest(graph, ['v1']);
  const vgate = AD.gateCanvasAction(AD.keywordCanvasAction('出视频', vdigest), { digest: vdigest });
  ok(vgate.allow === false && vgate.preview.kind === 'video' && vgate.preview.seconds === 6 && vgate.preview.model === 'vid-a', '视频生成没有给出秒数和模型');
  const fdigest = AD.canvasDigest(graph, ['f1']);
  const cgate = AD.gateCanvasAction(AD.keywordCanvasAction('合成成片', fdigest), { digest: fdigest });
  ok(cgate.allow === false && cgate.preview.kind === 'compose', '成片合成没有确认');
  const dgate = AD.gateCanvasAction(AD.keywordCanvasAction('删除这个', vdigest), { digest: vdigest });
  ok(dgate.allow === false && dgate.preview.kind === 'delete', '删除节点没有确认');
  ok(AD.gateCanvasAction({ tool: 'canvas_delete_node', args: { nodeId: 'v1' } }, { digest: vdigest, confirmed: true }).allow === true, '确认后删除仍被拦住');
  const adigest = AD.canvasDigest(graph, ['a1']);
  const analyze = AD.keywordCanvasAction('分析这首歌', adigest);
  ok(analyze.tool === 'canvas_analyze_audio' && analyze.args.nodeId === 'a1' && AD.gateCanvasAction(analyze, { digest: adigest }).allow === true, '分析歌曲没有直接执行');
  ok(AD.keywordCanvasAction('生成时间轴', adigest).tool === 'canvas_music_timeline', '没有调度音乐时间轴');
  ok(AD.keywordCanvasAction('推到画布', adigest).tool === 'canvas_music_video', '没有调度推到画布');
  ok(AD.keywordCanvasAction('按复刻替换角色', adigest).tool === 'canvas_music_remix', '没有调度复刻');
  const link = AD.keywordCanvasAction('把这两个连线', AD.canvasDigest(graph, ['t1', 'i1']));
  ok(link.tool === 'canvas_connect' && link.args.fromNode === 't1' && link.args.toNode === 'i1' && AD.gateCanvasAction(link, { digest }).allow === true, '连线没有直接执行');
  ok(AD.gateCanvasAction({ tool: 'canvas_write_node', args: { nodeId: 's1', text: '第一场' } }, { digest }).allow === true, '写剧本被误拦');
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"canvas_create_node","arguments":""}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"type\\":\\"script\\"}"}}]}}]}',
  ].join('\n');
  const native = AD.parseCanvasAction(sse);
  ok(native && native.native === true && native.tool === 'canvas_create_node' && native.args.type === 'script', '没有解析原生工具调用');
  const jsonAct = AD.parseCanvasAction('{"say":"改","tool":"canvas_update_node","args":{"nodeId":"t1","patch":{"text":"夜"}}}');
  ok(jsonAct && jsonAct.native === false && jsonAct.args.patch.text === '夜', 'JSON 一步协议没有解析');
  ok(AD.CANVAS_ASSISTANT_MAX_STEPS === 4, '步数上限不是 4');
  const host = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const fn = host.slice(host.indexOf('async canvasAssistantTurn'), host.indexOf('async audioPlanStoryboard'));
  ok(fn.includes('dispatchCanvasAssistant') && !fn.includes('canvasCreateNode'), '画布助手没有复用已有工具函数');
  ok(fn.includes('callOmni') && fn.includes('CANVAS_ASSISTANT_MAX_STEPS'), '画布助手没有走全模态或多步上限');
  ok(!/await complete\(/.test(fn.slice(0, fn.indexOf('} else if (step === 0)'))), '配了全模态时画布助手仍调用 Harness');
  const clientSrc2 = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  const audioBody = clientSrc2.slice(clientSrc2.indexOf('function AudioNodeBody'), clientSrc2.indexOf('function nodeBody'));
  ok(!audioBody.includes('data-tl-agent') && !clientSrc2.includes('audioAssistantTurn'), '音乐节点仍留着第二套助手');
  ok(clientSrc2.includes("data-canvas-assistant': 'open'") && clientSrc2.includes('data-assist-float') && clientSrc2.includes('canvasAssistantTurn'), '画布上没有可移动的统一助手');
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
  for (const name of ['canvas_analyze_audio', 'canvas_music_video', 'canvas_music_timeline', 'canvas_music_timeline_edit', 'canvas_music_remix']) {
    ok(byName.has(name), '缺少工具 ' + name);
  }
  const created = await byName.get('canvas_create_project').execute({ name: '音频MV测试' }, {});
  const projectId = created.projectId;
  ok(!!projectId, '没有建出项目');
  const pic = await byName.get('canvas_create_node').execute({ projectId, type: 'image', name: '参考图', assetId: 'face-1' }, {});
  const clip = await byName.get('canvas_create_node').execute({ projectId, type: 'video', name: '镜头', assetId: 'clip-1' }, {});
  const withAssets = JSON.parse(fs.readFileSync(path.join(process.env.DSH_IC_PROJECTS_DIR, projectId + '.json'), 'utf8'));
  ok(withAssets.nodes[pic.nodeId].data.assetId === 'face-1' && withAssets.nodes[clip.nodeId].data.assetId === 'clip-1', '附件没有写进图片或视频节点');
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
  const docNow = JSON.parse(fs.readFileSync(path.join(process.env.DSH_IC_PROJECTS_DIR, projectId + '.json'), 'utf8'));
  const boards = Object.values(docNow.nodes || {}).filter((n) => n && n.type === 'storyboard' && n.data && n.data.mvFrom);
  const shotSum = boards.reduce((s, n) => s + ((n.data.shots && n.data.shots.length) || 0), 0);
  ok(Array.isArray(sb.shots) && shotSum === mv.shotCount, '分镜表镜头数与工具回执不一致 ' + shotSum + ' vs ' + mv.shotCount);
  ok(sb.shots.every((s) => ['opening', 'continuation', 'scene_change', 'closeup', 'new_character', 'state_jump'].includes(s.seg)), '分镜 seg 不在切段器认识的取值里');
  const audioStatus = await byName.get('canvas_node_status').execute({ projectId, nodeId: analyzed.nodeId }, {});
  ok(audioStatus.analysis && audioStatus.analysis.schema === 'dshic.audio-analysis.v1', '节点状态没有带回分析摘要');
  ok(/BPM|本地/.test(audioStatus.text), '状态文本没有分析摘要');
  const doc = JSON.parse(fs.readFileSync(path.join(process.env.DSH_IC_PROJECTS_DIR, projectId + '.json'), 'utf8'));
  const edges = doc.edges || [];
  ok(edges.some((e) => e.fromPort === 'analysis' && e.toPort === 'music' && e.toNode === mv.storyboardNodeId), '分析输出口没有连到分镜 music');
  ok(edges.some((e) => e.fromNode === analyzed.nodeId && e.fromPort === 'out' && e.toPort === 'music' && e.toNode === mv.finalcutNodeId), '原曲没有接到成片 music');
  const charNode = Object.values(doc.nodes).find((nd) => nd && nd.data && nd.data.mvRole === 'char');
  const shotNode = Object.values(doc.nodes).find((nd) => nd && nd.data && nd.data.mvRole === 'shot' && nd.data.shotIndex === 0);
  ok(charNode && shotNode && edges.some((e) => e.fromNode === charNode.id && e.toNode === shotNode.id && e.toPort === 'ref'), '角色设定没有连到分镜图的参考口');
  ok(edges.some((e) => e.fromNode === shotNode.id && e.toPort === 'frame'), '第一张分镜图没有连到视频首帧');
  ok(edges.some((e) => e.toNode === mv.finalcutNodeId && e.toPort === 'in'), '成片没有视频入口');
  const profile = doc.skillProfile || {};
  ok(profile.form === 'music-video', '空规格没有默认成 music-video');
  const kept = JSON.parse(fs.readFileSync(path.join(process.env.DSH_IC_PROJECTS_DIR, projectId + '.json'), 'utf8'));
  kept.skillProfile = { ...(kept.skillProfile || {}), form: 'trailer' };
  fs.writeFileSync(path.join(process.env.DSH_IC_PROJECTS_DIR, projectId + '.json'), JSON.stringify(kept));
  await byName.get('canvas_music_video').execute({ projectId, nodeId: analyzed.nodeId, keepPackage: true }, {});
  const keptAfter = JSON.parse(fs.readFileSync(path.join(process.env.DSH_IC_PROJECTS_DIR, projectId + '.json'), 'utf8'));
  ok(keptAfter.skillProfile.form === 'trailer', '铺 MV 改掉了用户自己选的规格');
  const shots = Object.values(keptAfter.nodes).filter((n) => n && n.data && n.data.mvRole === 'shot');
  const heroNode = Object.values(keptAfter.nodes).find((n) => n && n.data && n.data.mvRole === 'char');
  ok(shots.length >= 2 && heroNode, '多镜 MV 没有角色或不够两镜');
  if (heroNode) {
    heroNode.data.assetId = 'same-face';
    heroNode.data.refLock = true;
    heroNode.data.prompt = '同一张脸';
    fs.writeFileSync(path.join(process.env.DSH_IC_PROJECTS_DIR, projectId + '.json'), JSON.stringify(keptAfter));
    await byName.get('canvas_music_video').execute({ projectId, nodeId: analyzed.nodeId, keepPackage: true, force: true }, {});
    const wired = JSON.parse(fs.readFileSync(path.join(process.env.DSH_IC_PROJECTS_DIR, projectId + '.json'), 'utf8'));
    const face = wired.nodes[heroNode.id];
    ok(face.data.assetId === 'same-face' && face.data.prompt === '同一张脸' && face.data.refLock === true, '定稿角色被铺时间轴换成了新的脸');
    const shotNodes = Object.values(wired.nodes).filter((n) => n && n.data && n.data.mvRole === 'shot');
    ok(shotNodes.length >= 2 && shotNodes.every((sh) => (wired.edges || []).some((e) => e.fromNode === heroNode.id && e.toNode === sh.id && e.toPort === 'ref')), '不是每一镜都连着同一张定稿角色图');
    const marker = 'data:image/png;base64,' + Buffer.from('PNGREF:same-face').toString('base64');
    const bodies = shotNodes.map(() => AD.imageRefPayload([marker], 'generations'));
    ok(bodies.every((b) => b.image && b.image[0] === marker), '各镜图片请求没有带上同一份角色字节');
  }
  const again = await byName.get('canvas_analyze_audio').execute({ projectId, nodeId: analyzed.nodeId }, {});
  ok(again.cached === true, '已有分析应直接返回，不重复听');
  const rpc = mod._internals.rpcMethods();
  const img = await byName.get('canvas_create_node').execute({ projectId, type: 'image', name: '待确认' }, {});
  const held = await rpc.canvasRunNode({ projectId, nodeId: img.nodeId, source: 'assistant' });
  ok(held.needsConfirm === true && /确认后才会执行/.test(held.text), '助手发起的出图没有停住：' + (held && held.text));
  const cfgNow = JSON.parse(fs.readFileSync(process.env.DSH_IC_CONFIG_PATH, 'utf8'));
  ok(!(cfgNow.ui && cfgNow.ui.runRequest && cfgNow.ui.runRequest.nodeId === img.nodeId), '未确认却写下了运行请求');
  const clicked = await rpc.canvasRunNode({ projectId, nodeId: img.nodeId, source: 'user' });
  ok(clicked.needsConfirm !== true, '节点按钮仍被确认卡拦住');
  const GP = await import(pathToFileURL(path.join(ROOT, 'gen-pool.js')).href);
  ok(GP.honestSay('歌曲已经分析完，MV 时间轴也铺好了。', { hasAnalysis: false, hasPackage: false, job: { status: 'running', line: '正在听 1/3 · 1 分 54 秒 · 正在连接' } }).includes('正在听 1/3'), '助手把进行中的听歌说成了完成');
  ok(GP.decideTimeline({ job: null, hasAnalysis: false, hasAsset: true }).action === 'need-analysis', '有歌没分析时不应直接去铺时间轴');
  const bare = await byName.get('canvas_create_node').execute({ projectId, type: 'audio', name: '只有歌', assetId: 'song-1' }, {});
  const queued = await byName.get('canvas_analyze_audio').execute({ projectId, nodeId: bare.nodeId }, {});
  ok(queued.inProgress === true && queued.queued === true && /已经在节点里/.test(queued.text) && !/已分析/.test(queued.text), '有歌但没在听时仍说要上传或说已经分析完：' + (queued && queued.text));
  await rpc.jobOpen({ projectId, nodeId: analyzed.nodeId, kind: 'analyze', owner: 'client', status: 'running', line: '正在听 1/3 · 1 分 54 秒 · 正在连接', force: true });
  const joined = await byName.get('canvas_analyze_audio').execute({ projectId, nodeId: analyzed.nodeId }, {});
  ok(joined.joined === true && joined.inProgress === true && /正在听 1\/3/.test(joined.text) && !/已分析/.test(joined.text), '节点已在听时助手又开了一次或说完成了：' + (joined && joined.text));
  const waiting = await byName.get('canvas_music_timeline').execute({ projectId, nodeId: analyzed.nodeId, style: '红黑白水墨' }, {});
  ok(waiting.inProgress === true && /还没有时间轴/.test(waiting.text) && /红黑白|风格已记下/.test(waiting.text), '听歌没完时铺时间轴没有如实说明：' + (waiting && waiting.text));
  const remixed = await byName.get('canvas_music_remix').execute({
    projectId, nodeId: analyzed.nodeId, style: '恶搞，人物替换',
    cuts: [8], descriptions: ['原镜人物挥手'], replacements: [{ name: '糯糯' }],
    providerHint: { imageMode: 'generations' }, keep: [],
  }, {});
  ok(remixed.ok === true && remixed.path === 'reference-to-video', '翻拍工具没有退到参考图重拍：' + (remixed && remixed.path));
  ok(remixed.package && remixed.package.scenes.every((sc) => sc.duration <= 15.05), '翻拍工具的场超过 15 秒');
  const edited = await byName.get('canvas_music_timeline_edit').execute({
    projectId, nodeId: analyzed.nodeId, sceneIndex: 0, shotIndex: 0,
    patch: { join: 'continuous', refs: { characters: ['糯糯'], locations: ['原片场景'], props: [] } },
  }, {});
  ok(edited.ok === true && edited.package.scenes[0].join === 'continuous', '时间轴编辑没有改成续帧');
  ok(edited.package.scenes[0].refs.characters[0] === '糯糯', '时间轴编辑没有改参考角色');
  const docPath = path.join(process.env.DSH_IC_PROJECTS_DIR, projectId + '.json');
  const before = JSON.parse(fs.readFileSync(docPath, 'utf8'));
  const analysisJson = JSON.stringify((before.nodes[analyzed.nodeId].data || {}).analysis);
  const styleText = before.nodes[analyzed.nodeId].data.styleText;
  const hero = Object.values(before.nodes).find((n) => n && n.data && n.data.mvRole === 'char');
  const place = Object.values(before.nodes).find((n) => n && n.data && n.data.mvRole === 'loc');
  const heroName = hero.data.refName;
  hero.data.label = heroName;
  hero.data.prompt = '手改过的脸';
  hero.data.assetId = 'uploaded-face';
  hero.data.refLock = true;
  delete hero.data.mvRole;
  delete hero.data.refName;
  delete before.nodes[place.id];
  fs.writeFileSync(docPath, JSON.stringify(before));
  const repaired = await rpc.mvRepairRefs({ projectId, nodeId: analyzed.nodeId });
  ok(repaired.ok === true && repaired.adopted >= 1 && repaired.created >= 1, '旧画布修复没有认领角色并补场景：' + JSON.stringify(repaired));
  const after = JSON.parse(fs.readFileSync(docPath, 'utf8'));
  const heroAfter = after.nodes[hero.id];
  ok(heroAfter.data.mvRole === 'char' && heroAfter.data.refName === heroName && heroAfter.data.prompt === '手改过的脸' && heroAfter.data.assetId === 'uploaded-face' && heroAfter.data.refLock === true, '认领后改掉了手改提示词、图片或定稿');
  ok(JSON.stringify(after.nodes[analyzed.nodeId].data.analysis) === analysisJson, '补角色图重跑了听歌分析');
  ok(after.nodes[analyzed.nodeId].data.styleText === styleText, '补角色图改掉了风格句');
  ok(Object.values(after.nodes).some((n) => n && n.data && n.data.mvRole === 'loc' && n.data.refName === place.data.refName), '缺的场景图没有建出来');
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
  sandbox.window.__DSH_IC_GEN_POOL__ = DshMedia;
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
  const seg = sandbox.window.__DSH_IC_SEGMENT__;
  seg.musicTimelineChrome = sandbox.window.__DSH_IC_MTL__ && sandbox.window.__DSH_IC_MTL__.musicTimelineChrome;
  return seg;
}

{
  const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  const start = src.indexOf('function AudioNodeBody');
  const end = src.indexOf('function nodeBody', start);
  const body = src.slice(start, end);
  ok(!/disabled:\s*!url/.test(body), '空节点的上传按钮仍因没有 url 而被禁用');
  ok(/disabled:\s*chrome\.uploadDisabled/.test(body), '上传按钮没有走 uploadDisabled');
  ok(/disabled:\s*chrome\.generateDisabled/.test(body), '生成时间轴没有走 generateDisabled');
  ok(/chrome\.showImport\s*\?/.test(body), '导入原片没有按复刻模式收起');
  ok(/data-tl-empty/.test(body) && /onDrop:\s*onDropAudio/.test(body), '空态缺少上传区或拖放');
  ok(/useState\('create'\)/.test(body), '默认模式不是 MV 创作');
  const ui = loadSegmentPlanner().musicTimelineChrome;
  ok(typeof ui === 'function', '没有暴露 musicTimelineChrome');
  const empty = ui({ hasAudio: false, busy: false, mode: 'create' });
  ok(empty.uploadDisabled === false, '空节点上传按钮应该可点');
  ok(empty.showEmpty === true, '没有歌曲时应显示空态');
  ok(empty.showImport === false && empty.showCast === false, '创作模式不应出现导入原片或替换角色');
  ok(empty.generateDisabled === true && empty.generateHint === 'need-audio', '没有歌曲时生成时间轴应该关闭并给出提示');
  const ready = ui({ hasAudio: true, busy: false, mode: 'create' });
  ok(ready.generateDisabled === true && ready.generateHint === 'need-analyze' && ready.showImport === false, '只有歌曲、还没听完时不能直接生成时间轴');
  const confirmed = ui({ hasAudio: true, hasAnalysis: true, confirmed: true, busy: false, mode: 'create' });
  ok(confirmed.generateDisabled === false && confirmed.showEmpty === false, '确认分段之后才能生成时间轴');
  const remix = ui({ hasAudio: false, busy: false, mode: 'remix' });
  ok(remix.showImport === true && remix.showCast === true, '复刻模式应显示导入原片和替换角色');
  ok(ui({ hasAudio: false, busy: true, mode: 'create' }).uploadDisabled === true, '忙时上传才应禁用');
}

if (errs.length) {
  console.error('✗ 音频驱动测试失败 ' + errs.length + ' 项');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 音频驱动测试通过');
process.exit(0);

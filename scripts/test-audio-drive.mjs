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
  const analysis = { durationSec: 20, bpm: 100, summary: '测试曲', sections: [{ label: 'verse', startSec: 0, endSec: 20, energy: 0.4 }] };
  const pkg = AD.planMusicVideoPackage(analysis, { style: '冷' });
  const state = {
    hasAudio: true, hasAnalysis: true, confirmed: true, hasPackage: true,
    styleText: '冷', analysis, mvPackage: pkg, durationSec: 20, mode: 'create',
  };
  const edited = AD.runMvAssistantTurn({ message: '第2段太长了', state, modelText: null, confirmed: false });
  ok(edited.executed === 'edit_shot' && edited.needsConfirm === false, '改提示词不应被当成花钱：' + edited.executed);
  ok(edited.state.mvPackage.scenes[1].awaitingConfirm, '被点名的段应停在待确认');
  ok(edited.state.mvPackage.scenes[0].shots[0].videoPrompt === pkg.scenes[0].shots[0].videoPrompt, '助手改了一段却动了另一段');
  ok(AD.assistantStateDigest(edited.state).scenes[1].awaitingConfirm === true, '下一轮读不到刚才的修改');
  const blocked = AD.runMvAssistantTurn({ message: '生成全部', state: edited.state, confirmed: false });
  ok(blocked.needsConfirm === true && blocked.executed == null && !blocked.clientJob, '未确认就发出了生成');
  ok(blocked.preview && blocked.preview.count === edited.state.mvPackage.scenes.length, '确认卡没有段数');
  const allowed = AD.runMvAssistantTurn({
    message: '生成全部', state: edited.state, confirmed: true,
    modelText: JSON.stringify({ say: '开始', tool: 'generate', args: { scope: 'all' } }),
  });
  ok(allowed.needsConfirm === false && allowed.clientJob === 'generate', '确认后仍不放行生成');
  const styled = AD.runMvAssistantTurn({ message: '做一个搞笑风的 MV', state: { hasAudio: true }, confirmed: false });
  ok(styled.executed === 'set_style' && /搞笑/.test(styled.state.styleText), '风格没有写进节点状态');
  ok(AD.nextAutoStep({ hasAudio: true }).tool === 'analyze' && AD.nextAutoStep({ hasAudio: true }).spends === false, '自动推进不应第一步就生成');
  const parsed = AD.parseAssistantAction('说明\n{"say":"只改这一镜","tool":"edit_shot","args":{"sceneIndex":0,"complaint":"多了一个人"}}');
  ok(parsed && parsed.tool === 'edit_shot' && parsed.spends === false, '模型返回的工具没有解析出来');
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
  const turnStart = hostSrc.indexOf('async audioAssistantTurn');
  const turnEnd = hostSrc.indexOf('async audioPlanStoryboard', turnStart);
  const turnSrc = hostSrc.slice(turnStart, turnEnd);
  ok(turnSrc.includes('buildOmniTextBody') && turnSrc.includes("route.route === 'omni'"), '助手规划没有走音频理解请求');
  const omniBranch = turnSrc.split("route.route === 'omni'")[1].split('} else {')[0];
  ok(omniBranch && !omniBranch.includes('complete('), '配了音频理解时仍会改走默认文本模型');
  const clientSrc = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  const analyzeFn = clientSrc.slice(clientSrc.indexOf('async function genAudioNode'), clientSrc.indexOf('async function genStoryboardNode'));
  ok(analyzeFn.includes('tlNeedOmni') && !analyzeFn.includes('complete('), '听歌分析在没配音频理解时不应去叫文本模型');
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
  ok(edges.some((e) => e.toNode === mv.finalcutNodeId && e.toPort === 'in'), '成片没有视频入口');
  const profile = doc.skillProfile || {};
  ok(profile.form === 'music-video', '项目规格没有写成 music-video');
  const again = await byName.get('canvas_analyze_audio').execute({ projectId, nodeId: analyzed.nodeId }, {});
  ok(again.cached === true, '已有分析应直接返回，不重复听');
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

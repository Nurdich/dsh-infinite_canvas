#!/usr/bin/env node
/**
 * 参考图必须出现在真实请求里，而不是只出现在计划函数的返回值里。
 * 传输是本地假的：不访问图片或视频厂商。
 * 运行：node scripts/test-ref-bytes.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

function markerBlob(marker) {
  return new Blob([Buffer.from('PNGREF:' + marker)], { type: 'image/png' });
}
function dataUrlOf(marker) {
  return 'data:image/png;base64,' + Buffer.from('PNGREF:' + marker).toString('base64');
}
function httpResponse(status, body, contentType) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const buf = Buffer.from(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? contentType : '') },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

const calls = [];
let script = 'image-ok';
async function fetchStub(_url, init) {
  const payload = JSON.parse(init.body);
  calls.push(payload);
  const up = String(payload.url || '');
  const upstream = payload.body || {};
  if (up.includes('example.test/v.mp4')) return httpResponse(200, 'mp4', 'video/mp4');
  if (script === 'image-reject') return httpResponse(400, { error: { message: 'image is not a supported field' } }, 'application/json');
  if (script === 'image-watermark') {
    const posts = calls.filter((c) => String(c.url || '').includes('/images/generations'));
    if (posts.length === 1) return httpResponse(400, { error: { message: 'watermark 不是文生图队列支持的字段' } }, 'application/json');
    return httpResponse(200, { data: [{ b64_json: Buffer.from('ok').toString('base64') }] }, 'application/json');
  }
  if (script === 'image-ok' || script === 'image-edits') {
    return httpResponse(200, { data: [{ b64_json: Buffer.from('ok').toString('base64') }] }, 'application/json');
  }
  if (script === 'video-ok') {
    if (upstream.images || upstream.image || upstream.content) return httpResponse(200, { video_url: 'https://example.test/v.mp4' }, 'application/json');
  }
  if (script === 'video-reject') {
    return httpResponse(400, { error: { message: 'images is not a supported field' } }, 'application/json');
  }
  return httpResponse(500, { error: 'unexpected ' + up }, 'application/json');
}

function loadClient() {
  const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  const noop = () => {};
  const el = () => ({
    style: {}, dataset: {}, children: [], textContent: '', id: '',
    appendChild: noop, removeChild: noop, remove: noop, setAttribute: noop, getAttribute: () => null,
    addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    getContext: () => new Proxy({}, { get: (t, p) => (p === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true }),
    toDataURL: () => 'data:,', classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  });
  const documentStub = {
    createElement: () => el(), createTextNode: (t) => ({ nodeValue: String(t) }),
    head: el(), body: el(), documentElement: el(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
  };
  const ls = { getItem: () => null, setItem: noop, removeItem: noop, clear: noop };
  class FileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        const type = blob.type || 'application/octet-stream';
        this.result = 'data:' + type + ';base64,' + Buffer.from(buf).toString('base64');
        if (this.onload) this.onload();
      }).catch((e) => { this.error = e; if (this.onerror) this.onerror(); });
    }
  }
  const sandbox = {
    window: { devicePixelRatio: 1, innerWidth: 1400, innerHeight: 900, addEventListener: noop, removeEventListener: noop, localStorage: ls, __DSH_IC_SMOKE__: true },
    document: documentStub, localStorage: ls,
    navigator: { userAgent: 'test-ref-bytes', clipboard: { writeText: async () => {} } },
    location: { href: 'http://127.0.0.1/' },
    fetch: fetchStub,
    requestAnimationFrame: noop, cancelAnimationFrame: noop,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    console, performance, Blob, URL, AbortController, AbortSignal, structuredClone, crypto,
    FormData, Response, Headers, TextDecoder, TextEncoder, Uint8Array, atob, btoa,
    Image: class { constructor() { this.src = ''; } },
    Audio: class { constructor() { this.src = ''; } },
    FileReader,
    CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
    Event: class { constructor(t) { this.type = t; } },
    ResizeObserver: class { observe() {} disconnect() {} },
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
  plugin.apply({
    effect(fn) { try { fn(); } catch { /* 启动期拉项目失败不影响请求构造 */ } },
    locale: { register: noop, subscribe: () => () => {} },
    slots: { inject(_n, cb) { cb(); }, register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
  });
  const gen = sandbox.window.__DSH_IC_GEN__;
  if (!gen || typeof gen.apiImage !== 'function' || typeof gen.apiVideo !== 'function') throw new Error('没有暴露真实的 apiImage / apiVideo');
  return gen;
}

const gen = loadClient();
const imageCfg = { baseUrl: 'https://img.example.test/v1', apiKey: 'test-image', model: 'img-test', mode: 'generations' };

{
  calls.length = 0;
  script = 'image-ok';
  const blobs = [markerBlob('hero'), markerBlob('alley')];
  await gen.apiImage('男主角站在旧巷', blobs, imageCfg, { ratio: '16:9', size: '2K' });
  const posts = calls.filter((c) => String(c.url || '').includes('/images/generations'));
  ok(posts.length === 1, '图片生成没有发出请求，或发了多次：' + posts.length);
  const body = posts[0] && posts[0].body;
  ok(body && Array.isArray(body.image) && body.image.length === 2, '图片 JSON 里没有 image 数组');
  ok(body.image[0] === dataUrlOf('hero') && body.image[1] === dataUrlOf('alley'), '图片 JSON 里的参考图不是这两张的字节');
  ok(JSON.stringify(body).includes(Buffer.from('PNGREF:hero').toString('base64')), '序列化后的请求正文里找不到角色图字节');
}

{
  calls.length = 0;
  script = 'image-edits';
  await gen.apiImage('改这张脸', [markerBlob('edit-a'), markerBlob('edit-b')], { ...imageCfg, mode: 'edits' }, {});
  const posts = calls.filter((c) => String(c.url || '').includes('/images/edits'));
  ok(posts.length === 1 && posts[0].bodyRaw && /multipart/.test(posts[0].bodyContentType || ''), '编辑接口没有发出 multipart');
  const raw = Buffer.from(posts[0].bodyRaw, 'base64');
  ok(raw.includes(Buffer.from('PNGREF:edit-a')) && raw.includes(Buffer.from('PNGREF:edit-b')), 'multipart 里没有两张参考图的字节');
  ok(raw.includes(Buffer.from('ref-0.png')) && raw.includes(Buffer.from('image[]')), 'multipart 没有用 image[] 字段');
}

{
  calls.length = 0;
  script = 'image-reject';
  let thrown = '';
  try { await gen.apiImage('要参考图', [markerBlob('reject')], imageCfg, {}); }
  catch (e) { thrown = String(e && e.message || e); }
  const posts = calls.filter((c) => String(c.url || '').includes('/images/generations'));
  ok(posts.length === 1, '模型拒绝 image 字段后仍发出了第二次请求：' + posts.length);
  ok(posts[0].body && Array.isArray(posts[0].body.image) && posts[0].body.image[0] === dataUrlOf('reject'), '被拒绝的那次请求里没有参考图字节');
  ok(/没有把去掉参考图的结果当成成功/.test(thrown), '拒绝参考图字段后没有说明失败：' + thrown);
  ok(!posts.some((c) => c.body && !c.body.image), '存在一次不带 image 的图片请求');
}

{
  calls.length = 0;
  script = 'image-watermark';
  await gen.apiImage('去水印但仍带参考', [markerBlob('wm')], imageCfg, {});
  const posts = calls.filter((c) => String(c.url || '').includes('/images/generations'));
  ok(posts.length === 2, 'watermark 不被支持时应带着参考图再发一次：' + posts.length);
  ok(posts[1].body && posts[1].body.watermark === undefined && posts[1].body.image && posts[1].body.image[0] === dataUrlOf('wm'), '剥掉 watermark 时把参考图也剥掉了');
}

{
  calls.length = 0;
  script = 'video-ok';
  const refs = [];
  for (let i = 0; i < 8; i++) refs.push(markerBlob('r' + i));
  let delivery = null;
  await gen.apiVideo('推开门', markerBlob('frame'), {
    url: 'https://vid.example.test/v1/video/generations', apiKey: 'test-video', model: 'vid-test', vendor: 'openai',
  }, {
    duration: 5, resolution: '720p', ratio: '16:9', frameMode: 'auto', refs,
    onDelivery: (d) => { delivery = d; },
  });
  const posts = calls.filter((c) => String(c.url || '').includes('/video/generations') && c.body && c.body.images);
  ok(posts.length === 1, '视频没有把参考图放进 generations 请求');
  const images = posts[0].body.images;
  ok(Array.isArray(images) && images.length === 8, '首帧加 8 张参考图后发出了 ' + (images && images.length) + ' 张，应停在厂商上限 8');
  ok(images[0].url === dataUrlOf('frame') && images[0].role === 'reference_image', '第一张不是分镜首帧');
  ok(images[1].url === dataUrlOf('r0') && images[7].url === dataUrlOf('r6'), '裁掉的不是排在后面的参考图');
  ok(!JSON.stringify(posts[0].body).includes(Buffer.from('PNGREF:r7').toString('base64')), '超出上限的参考图仍在请求正文里');
  ok(delivery && delivery.count === images.length && delivery.sendRefs === images.length && delivery.dropped === 1, '节点上的张数和实际发出的不一致：' + JSON.stringify(delivery));
  ok(delivery.say && /另外 7 张/.test(delivery.say) && /其余 1 张这次没有送出/.test(delivery.say) && !/另外 8/.test(delivery.say), '说明写成了全部参考图都会送出：' + (delivery && delivery.say));
}

{
  calls.length = 0;
  script = 'video-reject';
  let thrown = '';
  const refs = [];
  for (let i = 0; i < 8; i++) refs.push(markerBlob('c' + i));
  try {
    await gen.apiVideo('超限后失败', markerBlob('capframe'), {
      url: 'https://vid.example.test/v1/video/generations', apiKey: 'test-video', model: 'vid-test', vendor: 'openai',
    }, { duration: 5, refs, frameMode: 'auto' });
  } catch (e) { thrown = String(e && e.message || e); }
  ok(/没有改走不带图片的 \/v1\/videos/.test(thrown), '超限请求失败后改走了纯文字：' + thrown);
  const gens = calls.filter((c) => c.body && Array.isArray(c.body.images));
  const content = calls.filter((c) => c.body && Array.isArray(c.body.content));
  ok(gens.length === 1 && gens[0].body.images.length === 8 && gens[0].body.images[0].url === dataUrlOf('capframe') && gens[0].body.images[7].url === dataUrlOf('c6'), '失败前的 generations 没有按上限裁到 8 张');
  const imgs = content[0] && content[0].body.content.filter((x) => x && x.type === 'image_url');
  ok(imgs && imgs.length === 8 && imgs[0].image_url.url === dataUrlOf('capframe') && imgs[7].image_url.url === dataUrlOf('c6'), 'content 降级把首帧又加回去，超过了 8 张');
  ok(!calls.some((c) => String(c.url || '').includes('/v1/videos')), '超限失败后仍走了 /v1/videos');
  ok(!JSON.stringify(calls).includes(Buffer.from('PNGREF:c7').toString('base64')), '被裁掉的第 8 张参考图仍出现在某次请求里');
}

{
  calls.length = 0;
  script = 'video-reject';
  let thrown = '';
  try {
    await gen.apiVideo('推开门', markerBlob('frame'), {
      url: 'https://vid.example.test/v1/video/generations', apiKey: 'test-video', model: 'vid-test', vendor: 'openai',
    }, { duration: 5, refs: [markerBlob('hero')], frameMode: 'auto' });
  } catch (e) { thrown = String(e && e.message || e); }
  const posts = calls.filter((c) => /video\/generations|\/v1\/videos/.test(String(c.url || '')));
  const textOnly = posts.filter((c) => {
    const b = c.body || {};
    const contentImgs = Array.isArray(b.content) ? b.content.filter((x) => x && x.type === 'image_url') : [];
    return !b.image && !(Array.isArray(b.images) && b.images.length) && !contentImgs.length;
  });
  ok(/没有改走不带图片的 \/v1\/videos/.test(thrown), '带参考图失败后没有停住：' + thrown);
  ok(!posts.some((c) => String(c.url || '').includes('/v1/videos')), '失败后仍请求了不带图片的 /v1/videos');
  ok(textOnly.length === 0, '有一次视频请求没有带上图片');
  const first = posts.find((c) => c.body && c.body.images);
  const second = posts.find((c) => c.body && Array.isArray(c.body.content));
  ok(first && first.body.images.length === 2 && first.body.images[0].url === dataUrlOf('frame') && first.body.images[1].url === dataUrlOf('hero'), '第一次视频请求没有同时带上首帧和角色图');
  const contentImgs = second && second.body.content.filter((x) => x && x.type === 'image_url');
  ok(contentImgs && contentImgs.length === 2 && contentImgs[0].image_url.url === dataUrlOf('frame') && contentImgs[1].image_url.url === dataUrlOf('hero'), 'content 降级请求丢掉了图片或超出了张数');
}

{
  const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-ref-bytes-'));
  process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
  process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');
  const tools = [];
  const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href + '?ref-bytes=1');
  mod.apply({
    effect(fn) { fn(); return () => {}; },
    get() { return undefined; },
    webServer: { register: () => () => {} },
    tools: { register: (def) => { tools.push(def); return () => {}; } },
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const created = await byName.get('canvas_create_project').execute({ name: '参考图修复' }, {});
  const projectId = created.projectId;
  const energy = [];
  for (let i = 0; i < 20; i++) energy.push(i % 4 === 0 ? 0.8 : 0.1);
  const analyzed = await byName.get('canvas_analyze_audio').execute({ projectId, durationSec: 12, energy, hopSec: 0.5, name: '测试曲' }, {});
  await byName.get('canvas_music_video').execute({ projectId, nodeId: analyzed.nodeId, brief: '雨' }, {});
  const docPath = path.join(process.env.DSH_IC_PROJECTS_DIR, projectId + '.json');
  const before = JSON.parse(fs.readFileSync(docPath, 'utf8'));
  const analysisJson = JSON.stringify(before.nodes[analyzed.nodeId].data.analysis);
  const hero = Object.values(before.nodes).find((n) => n && n.data && n.data.mvRole === 'char');
  const place = Object.values(before.nodes).find((n) => n && n.data && n.data.mvRole === 'loc');
  const shot = Object.values(before.nodes).find((n) => n && n.data && n.data.mvKey === 'mv:' + analyzed.nodeId + ':kf:0:0');
  const video = Object.values(before.nodes).find((n) => n && n.data && n.data.mvKey === 'mv:' + analyzed.nodeId + ':vid:0');
  ok(hero && place && shot && video, '铺好的 MV 里缺角色、场景、分镜或视频');
  const heroName = hero.data.refName;
  hero.data.label = heroName;
  hero.data.prompt = '手改过的脸';
  hero.data.assetId = 'uploaded-face';
  hero.data.refLock = true;
  delete hero.data.mvRole;
  delete hero.data.refName;
  delete before.nodes[place.id];
  before.edges = [];
  fs.writeFileSync(docPath, JSON.stringify(before));
  const rpc = mod._internals.rpcMethods();
  const once = await rpc.mvRepairRefs({ projectId, nodeId: analyzed.nodeId });
  const mid = JSON.parse(fs.readFileSync(docPath, 'utf8'));
  const sig = (doc) => (doc.edges || []).map((e) => [e.fromNode, e.fromPort, e.toNode, e.toPort].join('>')).sort().join('|');
  const midSig = sig(mid);
  const twice = await rpc.mvRepairRefs({ projectId, nodeId: analyzed.nodeId });
  const after = JSON.parse(fs.readFileSync(docPath, 'utf8'));
  ok(once.created >= 1 && twice.created === 0, '第二次修复又新建了节点：' + JSON.stringify({ once, twice }));
  ok(sig(after) === midSig, '重复修复改动了连线');
  const heroAfter = after.nodes[hero.id];
  ok(heroAfter.data.assetId === 'uploaded-face' && heroAfter.data.prompt === '手改过的脸' && heroAfter.data.refLock === true && heroAfter.data.mvRole === 'char', '重复修复改掉了手改提示词、上传的图或定稿');
  ok(JSON.stringify(after.nodes[analyzed.nodeId].data.analysis) === analysisJson, '修复重跑了听歌');
  const frames = (after.edges || []).filter((e) => e.toNode === video.id && e.toPort === 'frame');
  const shotAsRef = (after.edges || []).filter((e) => e.toNode === video.id && e.toPort === 'ref' && e.fromNode === shot.id);
  const charRefs = (after.edges || []).filter((e) => e.toNode === video.id && e.toPort === 'ref' && e.fromNode === hero.id);
  ok(frames.length === 1 && frames[0].fromNode === shot.id, '分镜没有作为这一段视频的唯一首帧');
  ok(shotAsRef.length === 0, '分镜首帧被重复修复又接成了一条参考线');
  ok(charRefs.length === 1, '角色图没有恰好一条参考线连到视频：' + charRefs.length);
  calls.length = 0;
  script = 'video-ok';
  let delivery = null;
  await gen.apiVideo('沿用修复后的连线', markerBlob('shot:' + shot.id), {
    url: 'https://vid.example.test/v1/video/generations', apiKey: 'test-video', model: 'vid-test', vendor: 'openai',
  }, {
    duration: 5, frameMode: 'auto',
    refs: [markerBlob('char:' + hero.id)],
    onDelivery: (d) => { delivery = d; },
  });
  const post = calls.find((c) => c.body && Array.isArray(c.body.images));
  ok(post && post.body.images.length === 2, '修复后的视频请求没有同时带上首帧和角色图');
  ok(post.body.images[0].url === dataUrlOf('shot:' + shot.id) && post.body.images[1].url === dataUrlOf('char:' + hero.id), '请求里的字节不是这条首帧和这条角色连线');
  ok(delivery && delivery.count === 2 && delivery.sendRefs === 2 && /另外 1 张/.test(delivery.say), '修复后的说明和实际张数不一致：' + JSON.stringify(delivery));
}

if (errs.length) {
  console.error('✗ 参考图真实请求测试失败 ' + errs.length + ' 项');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 参考图真实请求测试通过');
process.exit(0);

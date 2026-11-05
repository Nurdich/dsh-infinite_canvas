#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = await import(pathToFileURL(path.join(ROOT, 'gen-pool.js')).href);
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

ok(G.defaultGenConcurrency('image') === 4, '图片默认并发不是 4');
ok(G.defaultGenConcurrency('video') === 2, '视频默认并发不是 2');
ok(G.providerConcurrency({ concurrency: '6' }, 'image') === 6, '供应商并发数没有生效');
ok(G.providerConcurrency({ extra: '{"parallel":3}' }, 'video') === 3, '扩展参数里的并发没有生效');
ok(G.providerConcurrency({}, 'image') === 4 && G.providerConcurrency({}, 'video') === 2, '没填并发时没有用默认值');

{
  let active = 0;
  let max = 0;
  const items = Array.from({ length: 8 }, (_, i) => ({ id: 'i' + i }));
  await G.runGenPool(items, async () => {
    active += 1;
    max = Math.max(max, active);
    await delay(30);
    active -= 1;
  }, { concurrency: 4 });
  ok(max === 4, '并发池没有顶到上限 4，实际 ' + max);
  ok(max <= 4, '并发池超过了上限');
}

{
  const deps = G.videoDeps([
    { id: 'a' },
    { id: 'b', continued: true },
    { id: 'c', join: 'cut' },
    { id: 'd', join: 'continuous' },
  ]);
  ok(deps[0].waitFor == null && deps[1].waitFor === 'a' && deps[2].waitFor == null && deps[3].waitFor === 'c', '续帧视频没有等上一段，或硬切被错误串行：' + JSON.stringify(deps));
  const order = [];
  await G.runGenPool(deps, async (item) => {
    order.push('s' + item.id);
    if (item.id === 'a') await delay(40);
    order.push('e' + item.id);
  }, { concurrency: 4 });
  ok(order.indexOf('sa') < order.indexOf('sb') && order.indexOf('ea') < order.indexOf('sb'), '续帧段在上一段结束前就启动了：' + order.join(','));
  ok(order.indexOf('sc') < order.indexOf('ea'), '独立段没有和续帧的上一段并行');
}

{
  const aimd = G.createAimd(4);
  const hit = aimd.onRateLimit(1000);
  ok(hit.limit === 2 && hit.backoffMs === 2000, '429 没有把并发减半：' + JSON.stringify(hit));
  aimd.onSuccess();
  aimd.onSuccess();
  ok(aimd.limit() === 3, '连续成功没有把并发加回来');
  let calls = 0;
  const out = await G.runGenPool(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    async (item) => {
      if (item.id === 'a') {
        calls += 1;
        if (calls === 1) { const e = new Error('429 rate limit'); e.status = 429; throw e; }
      }
      if (item.id === 'b') throw new Error('审核失败');
    },
    { concurrency: 4, aimd: G.createAimd(4), sleep: async () => {} },
  );
  const by = Object.fromEntries(out.results.map((r) => [r.id, r]));
  ok(by.a && by.a.ok, '429 退避后没有再试成功');
  ok(by.b && !by.b.ok, '失败项不该被算成成功');
  ok(by.c && by.c.ok, '一个失败把兄弟任务取消了');
  ok(out.limit < 4, '池子看到 429 后没有降低并发，仍是 ' + out.limit);
}

{
  const fresh = {
    nodes: {
      a: { id: 'a', data: { assetId: 'img-new', prompt: '已出图', refLock: true } },
      c: { id: 'c', data: { prompt: '只在磁盘上' } },
    },
    edges: [{ id: 'e1', fromNode: 'a', toNode: 'c', fromPort: 'out', toPort: 'ref' }],
    tombstones: [],
  };
  const incoming = {
    nodes: {
      a: { id: 'a', data: { assetId: null, prompt: '已出图' } },
      b: { id: 'b', data: { prompt: '新分镜' } },
    },
    edges: [{ id: 'e2', fromNode: 'b', toNode: 'a', fromPort: 'out', toPort: 'ref' }],
    tombstones: [],
  };
  const merged = G.mergeDocWrite(fresh, incoming);
  ok(merged.nodes.a.data.assetId === 'img-new', '后写入的空成图把已有成图抹掉了');
  ok(merged.nodes.a.data.refLock === true, '定稿标记丢了');
  ok(merged.nodes.b.data.prompt === '新分镜', '并发写入的新节点丢了');
  ok(merged.nodes.c.data.prompt === '只在磁盘上', '磁盘上已有的节点被整份覆盖丢掉了');
  ok(merged.edges.some((e) => e.id === 'e1') && merged.edges.some((e) => e.id === 'e2'), '两边的连线没有合并');
  const removed = G.mergeDocWrite(merged, { nodes: {}, edges: [], tombstones: ['b'] });
  ok(!removed.nodes.b, '墓碑没有删掉节点');
}

if (errs.length) {
  console.error('✗ 并发池测试失败 ' + errs.length + ' 项');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 并发池测试通过');

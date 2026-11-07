/**
 * Host 侧「技能包切片」构建：把四层配置 + manifest 变成可注入的文本。
 *
 * 与 Client 侧同源（都用 assets/canvas-director/pack.js 的纯函数），保证
 * 画布自生成与对话侧写出的提示词口径一致。这是「技能要对所有提示词生成起作用」的落点。
 */
import {
  getPackModule, packInventory, readCard, readMove, findEntry, allowedIds, readManifestRaw,
} from './skill-pack-loader.js';
import { normalizeSkillProfile } from './index-core-skill-profile.js';

/** moves 永远随 storyboard/prompt 走（运镜是这两类生成的必需品）。 */
const MOVES_FOR_KIND = {
  script: [],
  // 分镜要调度动作，运镜 + 打斗节奏两张卡都带；提示词只需运镜。
  storyboard: ['camera-moves', 'fight-rhythm'],
  prompt: ['camera-moves'],
  assets: [],
};

/**
 * 构建某生成能力下的注入文本。
 * @param {object} opts
 * @param {string} opts.kind       script | storyboard | prompt | assets
 * @param {object} opts.profile    技能配置（已归一或原始，函数内部会再归一）
 * @param {string} opts.hereDir    插件根目录
 * @param {boolean} opts.zh        中文
 * @returns {Promise<{text:string,bytes:number,used:Array,profile:object,inventory:object}>}
 */
export async function buildSkillPack(opts) {
  const o = opts || {};
  const kind = String(o.kind || 'script');
  const zh = o.zh !== false;
  const hereDir = String(o.hereDir || '');

  const inv = packInventory(hereDir);
  const allow = allowedIds(inv);
  const profile = normalizeSkillProfile(o.profile, allow);
  const hasAnyLayer = !!(profile.lens || profile.form || profile.look || (profile.genres || []).length);
  if (!hasAnyLayer && !o.force) {
    return { text: '', bytes: 0, used: [], profile, inventory: inv };
  }

  // 内层：genres 里既可能是叙事题材 id，也可能是行业题材 id —— 两者都从各自层读
  const items = [];
  const lensEntry = profile.lens ? findEntry(inv, 'lenses', profile.lens) : null;
  if (lensEntry) {
    const md = readCard(hereDir, 'lenses', lensEntry.file);
    if (md) items.push({ layer: 'lens', md, meta: lensEntry });
  }
  for (const gid of profile.genres) {
    const ge = findEntry(inv, 'genres', gid);
    if (ge) {
      const md = readCard(hereDir, 'genres', ge.file);
      if (md) { items.push({ layer: 'genre', md, meta: ge }); continue; }
    }
    const ie = findEntry(inv, 'industries', gid);
    if (ie) {
      const md = readCard(hereDir, 'industries', ie.file);
      if (md) items.push({ layer: 'industry', md, meta: ie });
    }
  }
  const formEntry = profile.form ? findEntry(inv, 'forms', profile.form) : null;
  if (formEntry) {
    const md = readCard(hereDir, 'forms', formEntry.file);
    if (md) items.push({ layer: 'form', md, meta: formEntry });
  }
  const lookEntry = profile.look ? findEntry(inv, 'looks', profile.look) : null;
  if (lookEntry) {
    const md = readCard(hereDir, 'looks', lookEntry.file);
    if (md) items.push({ layer: 'look', md, meta: lookEntry });
  }
  // 运镜只在「已经有层卡命中」时才跟随注入。
  // 否则四层全空的项目也会被塞进 5KB 运镜词典 —— 违反「未配置不注入」（老项目零变化）。
  if (items.length) {
    for (const mid of (MOVES_FOR_KIND[kind] || [])) {
      const mv = (inv.moves || []).find((x) => x.id === mid);
      if (!mv) continue;
      const md = readMove(hereDir, mv.file);
      if (md) items.push({ layer: 'moves', md, meta: mv });
    }
  }

  const P = await getPackModule();
  // 一条卡都没取到 → 不注入（连 head 都不给：否则「未配置」也会往 system 里塞一段空壳）
  if (!items.length) {
    return { text: '', bytes: 0, used: [], profile, inventory: inv };
  }
  const head = headLine(kind, profile, inv, zh);
  const built = P.buildPackText(kind, items, { zh, head });
  return { text: built.text, bytes: built.bytes, used: built.used, profile, inventory: inv };
}

/** 注入块的头部一行：把生效配置写清，并声明优先级（模型据此裁决冲突）。 */
function headLine(kind, profile, inv, zh) {
  const nameOf = (layer, id) => {
    if (!id) return '—';
    const e = findEntry(inv, layer, id);
    return e ? e.name : id;
  };
  const genreNames = (profile.genres || []).map((g) => {
    const e = findEntry(inv, 'genres', g) || findEntry(inv, 'industries', g);
    return e ? e.name : g;
  });
  if (zh) {
    return [
      '【画布技能包 · ' + kindLabel(kind) + '】',
      '导演透镜：' + nameOf('lenses', profile.lens) + '　题材：' + (genreNames.join('、') || '—')
        + '　规格：' + nameOf('forms', profile.form) + '　影调：' + (profile.look ? nameOf('looks', profile.look) : '跟随导演'),
      '优先级：用户显式指令 > 导演透镜 > 规格（仅单镜时长与结构上压过透镜；画幅由视频节点生成时决定，不在此列）> 题材 > 影调 > 技能默认。以下为对应切片，写提示词时必须遵守；与本块冲突的通则让位于本块。',
      ...(kind === 'script' ? ['【机制与素材】题材卡的机制库条目是可自由组合的零件：按当下故事的需要选择、改造、混搭或不用，事件与走向由剧本决定，条目绝不规定唯一走向，也绝不要求"用某设定就必须叠加某机制"。【素材优先级】已有小说/剧本原文与设定集设定 > 题材素材库：库条目仅供二次创作借形，绝不替代或改写既有设定。风格基调与导演运镜始终有效。'] : []),
    ].join('\n');
  }
  return [
    '[Canvas skill pack · ' + kindLabel(kind, false) + ']',
    'Director lens: ' + nameOf('lenses', profile.lens) + '  Genre: ' + (genreNames.join(', ') || '-')
      + '  Spec: ' + nameOf('forms', profile.form) + '  Look: ' + (profile.look ? nameOf('looks', profile.look) : 'follow the lens'),
    'Precedence: explicit user instruction > director lens > spec (only clip length and structure; aspect is chosen on the video node at generation time) > genre > look > skill defaults. The slices below are binding; where a generic rule disagrees, this block wins.',
  ].join('\n');
}

function kindLabel(kind, zh) {
  const ZH = { script: '剧本', storyboard: '分镜', prompt: '提示词', assets: '资产设定图' };
  const EN = { script: 'script', storyboard: 'storyboard', prompt: 'prompt', assets: 'asset sheet' };
  const m = zh === false ? EN : ZH;
  return m[kind] || kind;
}

/** 给 canvas_list_skills 用的技能清单（4 份内置技能 + 何时用）。 */
export const SKILL_CATALOG = [
  { name: 'canvas-studio', when: '任何时候先读：建项目 / 写节点 / 触发生成 / 查状态' },
  { name: 'canvas-craft', when: '写剧本或拆分镜前：剧本四要素、分镜六要素、提示词规范' },
  { name: 'canvas-layout', when: '批量建节点前：一类型一列、绝不重叠' },
  { name: 'canvas-director', when: '写任何提示词前：导演透镜 / 题材 / 规格 / 影调 / 运镜，先用 canvas_skill_pack 取切片' },
];

/** 层清单的可读渲染（canvas_list_skills 的正文）。 */
export function renderInventory(inv, profile, zh) {
  const lines = [];
  const ZH_LABEL = { lenses: '导演透镜', genres: '叙事题材', industries: '行业题材', forms: '规格', looks: '影调质感' };
  const EN_LABEL = { lenses: 'Director lenses', genres: 'Genres', industries: 'Industries', forms: 'Specs', looks: 'Looks' };
  const L = zh === false ? EN_LABEL : ZH_LABEL;
  for (const layer of ['lenses', 'genres', 'industries', 'forms', 'looks']) {
    const list = (inv && inv[layer]) || [];
    if (!list.length) continue;
    lines.push('');
    lines.push('### ' + L[layer] + '（' + list.length + '）');
    // 按 group 分组展示
    const byGroup = new Map();
    for (const it of list) {
      const g = it.group || '';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(it);
    }
    for (const [g, arr] of byGroup) {
      lines.push((g ? g + '：' : '') + arr.map((x) => x.id + '=' + x.name + ((x.aliases && x.aliases.length) ? '（' + x.aliases.join('/') + '）' : '') + (x.available ? '' : '（缺文件）')).join('　'));
    }
  }
  const mv = (inv && inv.moves) || [];
  if (mv.length) {
    lines.push('');
    lines.push('### ' + (zh === false ? 'Camera & rhythm' : '运镜与节奏') + '（' + mv.length + '）');
    lines.push(mv.map((x) => x.id + '=' + x.name).join('　'));
  }
  return lines.join('\n');
}

/** 当前项目配置的可读渲染。 */
export function renderProfile(profile, inv, zh) {
  const nameOf = (layer, id) => {
    if (!id) return '';
    const e = findEntry(inv, layer, id);
    return e ? e.name : id;
  };
  const g = (profile.genres || []).map((x) => {
    const e = findEntry(inv, 'genres', x) || findEntry(inv, 'industries', x);
    return e ? e.name : x;
  });
  if (zh === false) {
    return 'lens=' + (profile.lens || '(none)') + ' genres=' + (g.join(',') || '(none)')
      + ' form=' + (profile.form || '(none)') + ' look=' + (profile.look || '(follow the lens)');
  }
  return '导演=' + (nameOf('lenses', profile.lens) || '（未选）')
    + '　题材=' + (g.join('、') || '（未选）')
    + '　规格=' + (nameOf('forms', profile.form) || '（未选）')
    + '　影调=' + (profile.look ? nameOf('looks', profile.look) : '跟随导演');
}

function utf8Len(s) {
  let n = 0;
  for (const ch of String(s || '')) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}
function capText(text, maxBytes) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (utf8Len(t) <= maxBytes) return t;
  const heads = t.split(/(?<=[。；;!?])/);
  let out = '';
  for (const h of heads) {
    if (utf8Len(out + h) > maxBytes) break;
    out += h;
  }
  return (out || t.slice(0, maxBytes)).trim();
}

/** 图片紧凑锁。长文会进画面，所以只留镜头、色彩、场面材料和负向词。 */
async function buildImageLock(P, hereDir, profile, inv, kind) {
  const parts = [];
  const push = (label, body) => { const b = String(body || '').trim(); if (b) parts.push(label + '\n' + b); };
  if (profile.lens) {
    const md = readCard(hereDir, 'lenses', (findEntry(inv, 'lenses', profile.lens) || {}).file);
    if (md) {
      const y = P.yamlBlock(md) || '';
      const bits = [];
      const mm = /lens_kit_mm:\s*\[([^\]]+)\]/.exec(y);
      if (mm) {
        const nums = mm[1].replace(/#.*$/, '').split(',').map((x) => x.trim()).filter(Boolean);
        if (nums.length) bits.push('焦距 ' + nums.join('/') + 'mm');
      }
      const kr = /key_ratio:\s*"?([^"\n]+)"?/.exec(y);
      if (kr) bits.push('光比 ' + kr[1].trim());
      const dom = /\n\s*dominant:\s*([^\n]+)/.exec(y);
      if (dom) bits.push('主色 ' + dom[1].trim());
      const acc = /\n\s*accent:\s*([^\n]+)/.exec(y);
      if (acc) bits.push('点缀 ' + acc[1].trim());
      const sat = /\n\s*saturation:\s*([^\n]+)/.exec(y);
      if (sat) bits.push('饱和 ' + sat[1].trim());
      const con = /\n\s*contrast:\s*([^\n]+)/.exec(y);
      if (con) bits.push('对比 ' + con[1].trim());
      if (bits.length) push('画面风格：', bits.join('；') + '。');
    }
  }
  if (profile.look) {
    const md = readCard(hereDir, 'looks', (findEntry(inv, 'looks', profile.look) || {}).file);
    if (md) {
      const color = capText(P.sectionText(md, '色彩命题'), 420);
      if (color) push('色彩：', color);
      const tone = capText(P.sectionText(md, '影调与光比'), 320);
      if (tone) push('影调：', tone);
      if (kind === 'assets') {
        const mat = capText(P.sectionText(md, '材质响应'), 300);
        if (mat) push('材质：', mat);
      }
    }
  }
  for (const gid of (profile.genres || [])) {
    const ge = findEntry(inv, 'genres', gid);
    const ie = ge ? null : findEntry(inv, 'industries', gid);
    const entry = ge || ie;
    if (!entry) continue;
    const md = readCard(hereDir, ge ? 'genres' : 'industries', entry.file);
    if (!md) continue;
    const gr = P.sectionText(md, '常见场面颗粒') || P.sectionText(md, '视觉母题');
    if (gr) push('场面材料：', capText(gr, 260));
  }
  const negs = [];
  for (const [layer, id] of [['lenses', profile.lens], ['looks', profile.look], ['forms', profile.form]]) {
    if (!id) continue;
    const entry = findEntry(inv, layer, id);
    if (!entry) continue;
    const md = readCard(hereDir, layer, entry.file);
    if (!md) continue;
    negs.push(...(P.negativePhrases(md) || []));
  }
  for (const gid of (profile.genres || [])) {
    const ge = findEntry(inv, 'genres', gid);
    if (!ge) continue;
    const md = readCard(hereDir, 'genres', ge.file);
    if (md) negs.push(...(P.negativePhrases(md) || []));
  }
  if (negs.length) {
    const uniq = [...new Set(negs.map((x) => String(x).trim()).filter(Boolean))];
    push('必须排除：', capText(uniq.join(', '), 700));
  }
  if (!parts.length) return '';
  return '[画面风格锁] 以下决定画面成色（与正文冲突时以本块为准）：\n' + parts.join('\n');
}

/** 视频总控锁。运镜教材不进请求，只留影调短语、交付规格和最多 6 条负向词。 */
async function buildVideoLock(P, hereDir, profile, inv, fxMotion) {
  const parts = [];
  const push = (label, body) => { const b = String(body || '').trim(); if (b) parts.push(label + '\n' + b); };
  if (profile.look) {
    const md = readCard(hereDir, 'looks', (findEntry(inv, 'looks', profile.look) || {}).file);
    if (md) {
      const essence = P.sectionText(md, '成像底层') || P.sectionText(md, '质感基线') || '';
      if (essence) push('影调质感：', capText(essence, 200));
    }
  }
  if (profile.form) {
    const md = readCard(hereDir, 'forms', (findEntry(inv, 'forms', profile.form) || {}).file);
    if (md) {
      const spec = P.frontmatterSpec(md);
      const bits = [];
      if (spec.asl_floor_s) bits.push('单镜不短于 ' + spec.asl_floor_s + 's');
      if (spec.asl_target_s) bits.push('平均镜长 ' + spec.asl_target_s + 's');
      if (bits.length) push('交付规格：', bits.join('；'));
    }
  }
  const negs = [];
  const seenNeg = new Set();
  const addNegs = (phrases) => {
    for (const raw of (phrases || [])) {
      const s = String(raw || '').trim();
      if (s && !seenNeg.has(s.toLowerCase())) { seenNeg.add(s.toLowerCase()); negs.push(s); }
    }
  };
  for (const [layer, id] of [['lenses', profile.lens], ['looks', profile.look], ['forms', profile.form]]) {
    if (!id) continue;
    const entry = findEntry(inv, layer, id);
    if (!entry) continue;
    const md = readCard(hereDir, layer, entry.file);
    if (md) addNegs(P.negativePhrases(md));
  }
  for (const gid of (profile.genres || [])) {
    const ge = findEntry(inv, 'genres', gid);
    if (!ge) continue;
    const md = readCard(hereDir, 'genres', ge.file);
    if (md) addNegs(P.negativePhrases(md));
  }
  if (negs.length) push('必须排除：', negs.slice(0, 6).join(', '));
  if (fxMotion) push('速度与特效：', '瞬时事件（一闪/瞬移/现身）=切点两侧的状态差；速度感只来自硬切、静止主体+光效突变、甩镜；禁止镜内高速位移。');
  if (!parts.length) return '';
  return '[全片风格锚] 以下为全片级总控；逐镜画面与动作以正文为准：\n' + parts.join('\n');
}

/** 图片和视频提示词锁。剧本/分镜的长切片仍走 buildSkillPack。 */
export async function buildPromptLock(opts) {
  const o = opts || {};
  const hereDir = String(o.hereDir || '');
  const inv = packInventory(hereDir);
  const profile = normalizeSkillProfile(o.profile, allowedIds(inv));
  const hasAnyLayer = !!(profile.lens || profile.form || profile.look || (profile.genres || []).length);
  if (!hasAnyLayer) return '';
  const P = o.pack || await getPackModule();
  const medium = o.medium || 'video';
  const kind = o.kind === 'assets' ? 'assets' : 'prompt';
  if (medium === 'image') return buildImageLock(P, hereDir, profile, inv, kind);
  return buildVideoLock(P, hereDir, profile, inv, !!o.fxMotion);
}

export { readManifestRaw, normalizeSkillProfile };

# 无限画布架构

这份说明按代码本身写。它是插件里唯一的架构文档。导演台的几何和技能包的正文不在这里展开，只说明它们接在哪一层。

## 模块

| 文件 | 职责 |
| --- | --- |
| `index.js` | 宿主。项目和画布文档、SQLite 资产、`canvas_*` 工具、`/infinite-canvas/api/*`。真正的出图出视频不在这里发，只负责把「请画布执行」交给浏览器。 |
| `client.js` | 浏览器。节点、连线、生成面板、时间轴、助手侧栏。图片、视频、成片、听歌的请求在这里组好，经宿主代理发出。 |
| `audio-drive.js` | 纯函数。听歌请求、分窗、故事和 MV 包、参考图怎么放进请求、助手该不该动手。宿主引用它。浏览器不引用它。 |
| `gen-pool.js` | 纯函数。并发池、文档合并，以及同一节点同一种任务的登记：加入、排队、完成、失败，以及助手的话能不能说「完成」。 |
| `skill-pack.js` / `skill-pack-loader.js` / `index-core-skill-profile.js` | 把导演透镜、题材、规格、影调收成一段可注入的文字。宿主和浏览器各走一份入口，算法在 `assets/canvas-director/pack.js`。 |
| `skills.js` | 把 `skills/*/SKILL.md` 注册给 Harness。 |
| `assets/director/engine.js` | 3D 导演台，浏览器按需加载，不参与出图。 |

`client.js` 不能 `import`。端口表、旧类型名、分镜锁定判定、并发池算法只写在 `gen-pool.js`。浏览器启动时同步取出这一份（测试里注入 `window.__DSH_IC_GEN_POOL__`，页面上从 `/infinite-canvas/api/plugin-asset?rel=gen-pool.js` 读取）。工人仍在浏览器里跑，因为图片字节在浏览器里。

## 宿主和浏览器

浏览器只 `require('react')`。其余都是 `fetch`：

- `POST /infinite-canvas/api/rpc`：`hostRpc(method, args)`。方法表在 `index.js` 的 `apply` 里，`_rpcMethods`。
- `POST /infinite-canvas/api/fetch-proxy`：出图、出视频。浏览器把上游 URL 和正文交给宿主转发。
- `POST /infinite-canvas/api/audio-understand`：一窗压好的 WAV。宿主调全模态或本地兜底。
- `POST /infinite-canvas/api/llm-stream`：剧本、分镜的流式文本。
- `GET /infinite-canvas/api/file`：数据根里的文件。

对话工具是另一条入口，名字都是 `canvas_*`，实现和 RPC 里的函数是同一批。工具不直接出图。`canvas_run_node` 写一次 `runRequest`，浏览器每 3 秒 `projectsSync` 取走，再走和按钮相同的 `runGenNode`。

## 文档、节点、连线

一个项目一份文档，子画布是 `项目id::画布id`。文档里有 `nodes`、`edges`、`view`、`tombstones`、`bible`、`assistantChat`、`skillProfile`。

节点类型和端口（只在 `gen-pool.js` 的 `PORTS`）：

| 类型 | 输入 | 输出 | 生成时看的字段 |
| --- | --- | --- | --- |
| `text` | 无 | `out` 文本 | `text` |
| `script` | 无 | `out` 文本 | `idea`、`output` |
| `shot` | `char` / `scene` / `prop` 图 | `visual`、`motion` 文本 | 不单独跑生成 |
| `storyboard` | `prev`、`script`、`music` | `out`、`tail` | `shots`、`requirement` |
| `audio` | 无 | `out` 音频、`analysis` 文本 | `assetId`、`analysis`、`mvPackage`、`styleText`、`job` |
| `image` | `prompt`、`ref` | `out` 图 | `prompt`、`assetId`、`ratio`、`size`、`imageModel` |
| `video` | `prompt`、`frame`、`ref` | `out` 视频、`tailpick`、`last` | `prompt`、`assetId`、`duration`、`frameMode`、`videoModel` |
| `finalcut` | `in` 视频、`music` 音频 | 无 | 片段列表、字幕 |
| `group` | 无 | 无 | 只成组 |

旧名 `image-gen`、`image-asset`、`video-gen`、`video-asset` 读入时收成 `image` / `video`。`assetId` 还在就是已有素材。

连线：`ref`、`char`、`scene`、`prop`、`in` 可以多条。其余口新线替换旧线。上游没有产物时，这条线不能当成已经准备好。规则在 `gen-pool.js` 的 `edgeBlock`：图口要有 `assetId`，文本口要有正文或分镜表。

## 每种媒体怎么生成

全部按钮最终进 `client.js` 的 `runGenNode`。它按类型分发：

- `script` → `genScriptNode`：`/api/llm-stream` 或宿主 `complete`。
- `storyboard` → `genStoryboardNode`：同上；若连了音频分析，改走 `audioPlanStoryboard`。
- `audio` → `genAudioNode`：唯一的听歌实现。本地解码、分窗、每窗 `POST /api/audio-understand`（里面才调全模态），再 `audioMergeAnalyses`。助手的 `canvas_analyze_audio` 不再自己调全模态：进行中就加入，节点里有歌就排队给这一次，只有调用方直接给了能量曲线才写本地节拍。
- `finalcut` → `genFinalCutNode` → `composeFinalCut`：浏览器里合成，不打厂商。
- `image` → `collectRefs`（只取 `ref` 口）→ `apiImage`。
- `video` → `collectRefs` 加首帧 → `apiVideo`。

`apiImage`（`client.js`）：`compshare`、`sanbao` 走各自的任务式；`edits` 走 multipart 的 `image[]`；其余走 `/images/generations`，参考图在 `image` 数组。字段名由宿主 `mediaFit` 决定。厂商拒绝 `image` 字段就停止，不把去掉参考图的结果当成功。`watermark` 这类非参考字段仍可剥掉再试，参考图留着。

`apiVideo`：先认厂商（`detectVideoVendor`）。`kling`、`wan`、`sanbao`、`minimax`、`minimaxv2`、`vidu`、`runway`、`veo`、`luma`、`pixverse`、`stability` 各有一个 runner，都是提交、轮询、下载。`openai` 和 `seedance` 走通用正文。首帧和参考图不能同时当两种字段时，首帧作为第一张参考图，并且占用厂商上限里的一个名额。张数由 `audio-drive.js` 的 `videoConditionPlan` 算，浏览器只按返回的数字裁切。失败后若请求里带了图，不会改走不带图的 `/v1/videos`。

TTS 没有单独的节点类型。角色声音是视频请求里的 `audios`，来自 `@` 提及到的音频资产。

## 入口

| 谁来点 | 走到哪 |
| --- | --- |
| 节点上的生成、重新生成 | `runGenNode` |
| 时间轴「生成全部 / 此段 / 到结尾 / 重生成失败项」 | `runNodePool` → `runGenNode` |
| 时间轴「开始分析」 | `genAudioNode` |
| 时间轴「生成时间轴」 | `audioBuildTimeline` |
| 全局助手 | `canvasAssistantTurn`。改字、连线、听歌、铺时间轴直接做。出图、出视频、成片、删除先出确认卡，确认后 `canvas_run_node`，浏览器再 `runGenNode`。 |
| 批量并发 | `runNodePool` 只组工作项和字节，算法是 `gen-pool.js` 的 `runGenPool`。工人仍是 `runGenNode`。 |

MV 的角色锁定、分镜闸门是加在这条通用路上的规则（`mvRefBlock`），不是另一套生成器。

## 状态放哪，两边怎么对齐

- 画布正文在浏览器 `localStorage`，约 450ms 后 `projectsPut` 推到宿主。宿主 `mergeDocWrite` 合并，空的 `assetId` 不会抹掉已经生成的图。
- 浏览器每 3 秒 `projectsSync`。宿主改过文档会带 `docChanged`，浏览器 `mergeHostDoc` 拉回来。
- 进行中的任务在 `gen-pool.js` 的 `createJobBook`：一个节点、一种任务，只留一条。状态是 `queued`、`running`、`done`、`error`、`cancelled`。同一条记录写在节点的 `data.job` 上，所以助手摘要和节点按钮读到的是同一句 `line`。
- 听歌的流式文字仍在 `audio-drive.js` 的 `openOmniProgress`。浏览器把窗口、已用时间和「正在连接 / 仍在接收 / 等待下一段」写进任务的 `line`。没有字节时是「正在连接」，不是「正在分析完」。
- 助手每轮先看摘要里的 `job`。工具回执若是 `inProgress`，对用户说的是回执原文，不是模型自己说的「已经做好了」。`honestSay` 再对一遍：嘴上说完成，文档里却没有分析、时间轴或成片，就把这句话换成任务的那一句。

## 已经删掉的第二份

- 宿主整首再调一次全模态。听歌只剩浏览器分窗，经 `/api/audio-understand` 进 `understandFromRequest`。
- 浏览器里的并发池、`videoDeps`、`createAimd`。算法只在 `gen-pool.js`。
- `PORTS` / `PORT_TABLE`、旧类型名映射、`missingRefsForShot` 的第二份和第三份。只留 `gen-pool.js`。
- 浏览器里的 `videoConditionPlan` / `imageRefPayload`。裁切只在 `audio-drive.js`，浏览器问 `mediaFit`。

## 还各写各的，以及原因

- 各视频厂商的请求体和响应字段。轮询和退避已经共用 `vendorPoll`。每家的鉴权、URL 和字段对不上，收成一张表会把差异藏进更难核对的配置，所以请求映射仍写在各自的 runner 里。
- 图片的 `compshare` / `sanbao` 任务式和通用 `/images/generations`。协议不同，没有第二套轮询算法；`sanbao` 的查询状态函数是测试在用的那一份。
- 媒体节点外框尺寸（`NODE_HDR_H` 等）宿主和浏览器各有一组常量。改一边必须改另一边，注释里写了这条。抽走会让建点几何依赖一次网络读取，旧文档打开会闪。
- 配音没有单独节点。角色声音是视频请求里的 `audios`，来自 `@` 提到的音频资产。没有再做一个 TTS 产品。

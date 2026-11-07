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

`client.js` 不能 `import` 宿主模块。以前因此把同一段函数在浏览器里再抄一份。参考图怎么裁、图片字段叫什么，已经改成问宿主的 `mediaFit`，浏览器里的那份删掉了。并发池仍留在浏览器里，因为工人要在浏览器里拿图片字节；算法的另一份在 `gen-pool.js`，测试锁的是那一份。

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

节点类型和端口（`client.js` 的 `PORTS`，宿主 `PORT_TABLE` 同一张表）：

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
- `audio` → `genAudioNode`：本地解码、分窗、每窗 `audio-understand`，再 `audioMergeAnalyses`。进度在 `audioProgress`。
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
| 批量并发 | `gen-pool.js` 的算法；浏览器里的 `runNodePool` 调用它的同形实现，工人仍是 `runGenNode`。 |

MV 的角色锁定、分镜闸门是加在这条通用路上的规则（`mvRefBlock`），不是另一套生成器。

## 状态放哪，两边怎么对齐

- 画布正文在浏览器 `localStorage`，约 450ms 后 `projectsPut` 推到宿主。宿主 `mergeDocWrite` 合并，空的 `assetId` 不会抹掉已经生成的图。
- 浏览器每 3 秒 `projectsSync`。宿主改过文档会带 `docChanged`，浏览器 `mergeHostDoc` 拉回来。
- 进行中的任务在 `gen-pool.js` 的 `createJobBook`：一个节点、一种任务，只留一条。状态是 `queued`、`running`、`done`、`error`、`cancelled`。同一条记录写在节点的 `data.job` 上，所以助手摘要和节点按钮读到的是同一句 `line`。
- 听歌的流式文字仍在 `audio-drive.js` 的 `openOmniProgress`。浏览器把窗口、已用时间和「正在连接 / 仍在接收 / 等待下一段」写进任务的 `line`。没有字节时是「正在连接」，不是「正在分析完」。
- 助手每轮先看摘要里的 `job`。工具回执若是 `inProgress`，对用户说的是回执原文，不是模型自己说的「已经做好了」。`honestSay` 再对一遍：嘴上说完成，文档里却没有分析、时间轴或成片，就把这句话换成任务的那一句。

## 这次对上之前，重复和各说各话在哪

这些是读代码时对上的，行号按收口前的位置：

- 听歌有两条。节点走 `client.js` `genAudioNode`。助手的 `canvas_analyze_audio` 在宿主里再调 `understandFromRequest`。宿主文档上还没有分析时，时间轴工具报「先上传歌曲并分析」，即使用户节点里已经有歌、节点按钮正在听。
- 助手说「已执行」用的是模型写在动作里的 `say`，不看工具回执。所以节点还停在「正在听 1/3 · 正在连接」时，侧栏可以写「歌曲已经分析完，时间轴也铺好了」。
- `videoConditionPlan`、`imageRefPayload`、`fitVideoImages` 在 `audio-drive.js` 和 `client.js` 各有一份。
- `createAimd`、`runGenPool`、`videoDeps`、`isRateLimitError` 在 `gen-pool.js` 和 `client.js` 各有一份。浏览器不能引用宿主模块，工人循环仍留在 `client.js`。参考图裁切那一份已经删掉。
- `missingRefsForShot` 在 `audio-drive.js` 和 `client.js` 各有一份。MV 的锁定规则还在浏览器里，因为判定要看当前画面上的节点。
- `PORTS` 和 `PORT_TABLE`、`normalizeNodeType`、媒体框尺寸，两边各写一份，测试和注释要求它们一致。
- 连了参考图但上游没有成图时，以前只有 MV 分镜会拦住。别的图片节点会跳过那条线，只靠文字出图。
- 上游重新生成后，只有 MV 的分镜和视频会被标成需重生成。

## 收口以后

没有新文件。任务登记放进已有的 `gen-pool.js`。宿主的听歌、铺时间轴、`canvas_run_node` 和助手收尾都问它。浏览器的 `genAudioNode` 和 `runGenNode` 用 `jobOpen` 领取或加入。参考图的裁切只留在 `audio-drive.js`，浏览器调用 `mediaFit`。连着的图口没有成图，任何图片或视频节点都会停。上游成图更新后，下游图片、视频和成片标成需重生成。

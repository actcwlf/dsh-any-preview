# 内部实现

面向维护者。用户文档见根目录的 README。

## 工程约定

| 约定 | 位置 | 说明 |
|---|---|---|
| 所有上限集中一处 | [`src/shared/limits.ts`](src/shared/limits.ts) | 13 个文件里的 15 个常量统一为命名限额，改一处即可调整 |
| 构建产物压缩 + 带 sourcemap | `tsdown.config.ts` | 堆栈能映射回源码行；`lib/*.js.map` 只用于本地调试 |
| 启动时做契约自检 | `src/client/contracts.ts`、`src/host/self-check.ts` | 上游改名时打印一行诊断，而不是静默地什么都不渲染 |
| 类型检查 | `npm run typecheck` | `strict` + `noUncheckedIndexedAccess`；依赖类型本机缺失，用 `externals.d.ts` 声明 |

## 结构

```
dsh-any-preview/
├── package.json         # dsh.client（浏览器半）+ dsh.bundle（组合包层）
├── cordis.patch.yml     # insert 一行插件到 profile
├── tsdown.config.ts     # 双产物构建：lib/index.js（host）+ lib/client.js（browser）
├── sample.csv           # 测试用样例
├── test/                # node --test：性质测试 + 路由测试 + SSR 渲染测试
├── src/index.ts         # host 半：媒体 Range 路由
├── src/host/media-route.ts
└── src/client/
    ├── index.ts         # 遍历 PREVIEWS 统一注册，逐模块 try/catch
    ├── kernel/
    │   ├── types.ts         # PreviewModule / DocumentContent / PreviewBodyProps
    │   ├── source.ts        # 三种 content 模式 → 统一 PreviewSource
    │   ├── stream.ts        # useStreamedText：把增量文本喂给有状态消费者
    │   ├── lines.ts         # 增量行切分（CRLF、跨块）+ 行计数/跳过
    │   ├── text-pipeline.ts # 增量分隔符解析 + 有界行缓冲
    │   ├── row-numbering.ts # 文件行（0 = 表头）↔ 表体行的唯一换算
    │   ├── csv-index.ts     # 稀疏行索引：每 N 行一个锚点
    │   ├── csv-window.ts    # 从最近的锚点读一段行（文本路径）
    │   ├── row-file.ts      # 文件源：字节锚点 + 窗口读 + 后台建索引 + 扫描
    │   ├── window-state.ts  # 窗口算术：读哪段、画哪些行、比例滚动条
    │   └── useWindowedRows.ts  # 静止后读窗口的 hook（含 LRU）
    └── previews/
        ├── index.ts     # ★ PREVIEWS 数组：唯一的注册清单
        ├── csv/         # 流式表格（虚拟滚动；大文件用窗口）
        │   ├── source.ts    # 行从哪来：文本缓冲 / 文件源 / 读一窗 / 扫描
        │   ├── scroll.ts    # 视口、几何（memo）、reveal
        │   ├── scan.ts      # 全文搜索状态机 + 箭头导航
        │   ├── state.ts     # 两台小状态机的纯 reducer（可单测）
        │   ├── parse.ts     # 切片 → 单元格（唯一懂分隔符的地方）
        │   └── table.tsx    # 只负责 DOM
        ├── diff/        # 统一 diff 分类与渲染
        ├── log/         # 日志级别着色、过滤、尾部跟随
        ├── jsonl/       # 逐行 JSON：字段表格 + 坏行标出
        └── media/       # video/audio + Blob 兜底
```

## 注册机制

每个格式实现同一个 `PreviewModule`：

```ts
interface PreviewModule {
  id: string                    // 同时是渲染器 id 与 document 槽的 key
  extensions: string[]
  binary?: string[]             // 这些后缀是二进制，禁止回退到纯文本
  load: 'text-pages' | 'bytes-complete' | 'renderer'
  wrap?: boolean
  title: () => string
  Body: ComponentType<PreviewBodyProps>
}
```

`client/index.ts` 遍历 `PREVIEWS`，为每个模块注册两条：

```ts
ctx.documentPreviews.register({ id, extensions, binaryExtensions: binary,
                                priority: 'extension', loading: load })
ctx.slots.inject('sidebar.right.tab.document',
  () => ctx.slots.register({ name: 'sidebar.right.tab.document', key: id }, Body))
```

**新增格式 = 新建 `previews/<name>/` + 在 `previews/index.ts` 加一行。**

Body 不直接读 owner 的 `content`，而是经 `kernel/source.ts` 归一化，因此换加载模式
不影响组件代码。

## 大文件

`text-pages` 是**累积**文本，每来一页只解析新增的后缀（`kernel/stream.ts` +
`kernel/text-pipeline.ts`），避免整段重解析的 O(n²)。行缓冲仍以 `LIMITS.csvRows`
（20 000 行）为上限，但 CSV 表格早已越过它（见下），行数不再有上限。

CSV 的行是**虚拟滚动**的：固定行高 + overscan，只挂载视口内的行，上下用撑高的空行维持
滚动条长度。

### CSV 窗口化（`previews/csv/*`、`kernel/csv-*`、`kernel/useWindowedRows.ts`）

文本超过 2 MB、或行缓冲被行数上限截断时，表格改为「稀疏索引 + 窗口」：

| 模块 | 作用 |
|---|---|
| `csv-index.ts` | 稀疏行索引：每 10 000 行一个锚点，引号感知，只扫描新增后缀 |
| `csv-window.ts` | 按锚点读窗口：定位 → 跳过 → 解析切片；末尾没有换行的最后一行也算一行 |
| `window-state.ts` | 纯算术：`planWindow`（读哪一段）、`windowedBodyRows` / `bandRows`（画哪些行 + 上下撑高）、比例几何与 `stickyBand` |
| `useWindowedRows.ts` | T1 占位 / T2 静止 200 ms 后读；按窗口号缓存（LRU，32 窗口 / 160 000 行） |
| `row-file.ts` | 文件源：按字节取切片、后台建字节行索引、估算偏移跳转、全文扫描（含锚点）；切片怎么变成行由调用方传入的 `parse` 决定 |
| `host/text-route.ts` | `GET /api/any-preview/text`：字节区间 → 行对齐 → 解码，带 `start/end/size/eof` |
| `previews/csv/source.ts` | 行从哪来：文本缓冲 + 字符索引 + 文件源 + 读一窗 + 扫描，合成一个 `CsvSource` |
| `previews/csv/state.ts` | 两台状态机的纯 reducer：文件源的 idle→opening→ready/failed、扫描的 start→slice→done/stop |
| `previews/csv/scroll.ts` | 视口与几何：滚动位置、总行数（含"拖 3 屏才换精确总数"）、比例几何、`reveal(行)` |
| `previews/csv/scan.ts` | 全文搜索状态机：显式触发、从当前行起扫、逐片发布、可停止、并入箭头导航 |
| `previews/csv/table.tsx` | 只负责 DOM：滚动容器、钉住窗口、表头、行号、高亮 |
| `previews/csv/parse.ts` | 切片 → 单元格：全流程唯一懂分隔符的地方 |
| `kernel/row-numbering.ts` | 文件行 ↔ 表体行（`toFileRow` / `toBodyRow` / `isHeaderRow`），全流程只此一处 |
| `kernel/lines.ts` | 共用的行计数：`countNewlines` / `countRows` / `skipLines` |

组件之外的这三份（`source` / `scroll` / `scan`）各有单一职责，`index.tsx` 只剩组合与状态行；
**`geometry` 必须 `useMemo`**：揭示效果依赖它，每帧新对象会让"滚动后又被拉回命中行"（见
`handoff` §16）。

要点：

- **比例滚动条的 `visibleRows` 要减掉表头**：行从表头下面开始，`(viewportHeight - HEADER_HEIGHT) /
  rowHeight` 才是能完整放下的行数；算上表头会让 100 % 时最后一屏低一行、末行被表头切掉一截
  （720 px 视口：31 行 = 709 px 放得下，32 行 = 731 px 放不下）。表头常量与行高、滚动上限一起在
  `previews/csv/layout.ts`；
- **一屏的 DOM**：窗口是**读/缓存单位**（5 000 行），表格仍只挂视口那一屏（+8 行 overscan），
  上下用撑高的 `<tr>` 维持整文件长度——300 000 行的表也只挂四十来个 `<tr>`；
- **一次读要够长**：缓存按窗口号，所以一次读必须覆盖整个窗口**和**视口可能越过的下沿带
  （`windowSize + 视口行数 + overscan`）。只按视口大小读会把"短窗口"缓存下来，之后在同一
  窗口里滚动就是一片空白——这是第一版 `planWindow` 的 bug；
- **行号 = 文件行号**：文件 row 0 是表头（表格自己画一次），所以 body 行 `i` 是文件行 `i+1`；
  `windowedBodyRows` 负责这个 +1 换算，并保证「上撑高 + 所画行 + 下撑高 = (总行数-1) × 行高」；
- **超过约 727 000 行**（22 px × 727 000 ≈ 16 777 216 px 的浏览器上限）时不再压行：
  表格行永远 22 px，滚动内容换成**固定高度的 spacer**（正好 16 777 216 px），滚动位置按比例
  映射到行（`proportionalGeometry` / `logicalRow`）；表格用 `position: sticky` 钉在视口顶部，
  `<tbody>` 用 `translateY` 对齐小数行（`stickyBand`）。因此内容位移是滚动位移的 `22 / pitch` 倍
  （2M 行约 2.6 倍）——这是比例滚动条的唯一代价，换来字始终可读、行号始终精确、文件末尾可达。
  内容高度是常量，所以**估错总行数也顶不破上限**，只是行映射整体按比例偏一点；
- **表头层级**：表头在 sticky 块内，`z-index` 高于被平移的 `<tbody>`，行从表头下方滑过；
  `overflow-anchor: none` 防止浏览器的滚动锚定改掉我们的 offset；行号列 `position: sticky; left`
  在 tbody 被 transform 后仍然生效（无头 Chromium 实测 `scrollLeft=120` 时列仍在原位）；
- **行距不参与排版缩放**：表格行 `height` 是下限，会把行撑到「行框 + 边框」，所以一旦压缩行距
  就必须连字号一起缩（`handoff` §14 记了那次 8.39 px 计划 / 11 px 实测）。改成比例滚动条后行距
  恒为 22 px，这个问题不存在了；
- **窗口化时没有过滤**（`SearchBar filterable={false}`）：一屏的行代表不了整份文件，藏起控件
  比"只过滤看得见的部分"诚实；搜索仍高亮，>2 MB 时状态行给全文扫描进度与命中总数；
- **翻页由 owner 驱动**：没有文件源时，表格自己的滚动条滚到底，owner 通过 `scrollportRef` 认为
  正文到底，请求下一页文本；新页到达后 `index.push` 只扫新增后缀，窗口缓存因文本变长而失效并重读。
- **缓存的失效条件**：缓存里放的是**行**，所以只有「行变了」或「编号变了」才清——文本路径是
  `text.length`，文件路径只在后台索引**走完**的那一下。别按索引进度递增 revision：每片都清缓存
  会让表格在索引期间闪成空白（踩过，见 `docs/handoff-csv-windowed.md` §13）。
- **调度只有一个**（`useWindowedRows`）：缓存为空就立刻读，非空（拖动中换窗口）才等 200 ms
  安静；读完 bump 一次状态把缓存画出来。**不要**拆成"武装 + 读取"两个 effect 再共享一个
  `settled` 计数器——缓存被清空时武装 effect 不一定会重跑，读就再也不会开始（同一个坑）。
- **失效但同窗口**：`lastRead` 保留上一次画出的窗口，同一窗口失效重读期间继续画旧行，
  避免"打开大文件时闪一下"。

已知边界：行缓冲的「已截断」提示因此不再出现（截断必然切换到窗口化）；`csv.truncated`
只作为非窗口路径的兜底文案保留。

### CSV 文件源（按位置跳转）

owner 的 `text-pages` 是**顺序累积**的：它只会 `loadPage(loadedThrough + 1)`，并把页拼成
「从第 1 行起的连续前缀」，所以正文里没有"第 20 万行"这个位置。要让滚动条表示整个文件、
拖到任意位置就地取数，CSV 自己读文件：

1. **探测**：`useResource` 给出绝对路径 → 用媒体路由的 `Range: bytes=0-0` 取文件大小；
   超过 2 MB 才走文件源，小文件保持文本路径（首屏零等待）。
2. **建索引**：`GET /api/any-preview/text?path&offset&length&rowStart=1` 每次读 1 MB 的行对齐
   切片，`requestIdleCallback` 一次一片地走完整个文件；锚点记 `{ row, byte }`。
   文件头 1 MB 的行密度和整份文件差得远（id、备注会变长），所以开档时额外在 1/3、2/3、5/6
   处各探 32 KB，用**平均行密度**估总行数——22 MB 夹具上估算 301 356 行（实际 300 001，+0.45%）。
3. **读窗口**：目标行落在已索引区 → 从最近锚点按 `rowStart=1` 读，行号精确；否则按
   `行号 ÷ 平均密度` 估字节偏移，`rowStart=0` 让服务端丢掉被截断的半行，行号标 `~`（估计）。
   视口在文件末尾时直接读尾部切片并取最后 N 行，所以"拖到底"看到的是文件真正的结尾。
4. **换总行数**：索引完成不代表滚动条立刻变——总量在"下一次超过约 3 屏的拖动"时才替换，
   免得滚动条在用户手底下变长。行号本身不等这一下：索引覆盖到的窗口立即变成精确值。
5. **搜索**：文件源在时，全文扫描按切片读整个文件（`file.scan`），与文本路径的进度/终止
   交互一致。扫描是**显式**的（回车或"全文查找"），**从读者所在行起扫**（就近找锚点，走到尾再
   回绕到起点，总数仍是整份文件），并且**每片发布一次**结果（`onSlice`）：第一个命中立刻可跳，
   状态行先写"已找到 N 处"，扫完才定格成总数。扫描顺手在每片起点留锚点，所以跳到命中是精确的。
   "终止扫描"只中止请求，已找到的命中保留。
6. **跳转到命中**：命中行 → 滚动位置用与滚动条同一套映射（比例模式下 `(行 - 视口行数/2) ×
   pitch`，按**行**取半屏，不能按像素取半屏——一个像素在比例模式下是 `1/pitch` 行）。
   索引没覆盖的行靠扫描留下的锚点精确读；没有锚点时才退回字节估算。

已知边界：文件模式下，owner 仍会在表格滚到底时按自己的规则加载下一页文本（一页一次），
我们不用那段文本，但它会留在 store 里；换成不绑定 `scrollportRef` 可以避免，代价是分页
记忆丢失，暂不改。


## 搜索

每个文本类预览（CSV / diff / log / JSONL）的头部都有一条同样的搜索栏：

- **命中高亮**：匹配片段就地标黄，所有行都显示（默认不隐藏上下文）
- **上一个/下一个**（↑ ↓）：循环跳转，并把目标行滚到视口中央；CSV 用固定行高定位，
  其余用 `data-row-index` + `scrollIntoView`
- **计数**：`当前/匹配总数`，空查询时显示总行数
- **`Aa`** 区分大小写、**`.*`** 正则模式；正则写了一半不合法时按「无查询」处理，不报错
- **「仅匹配」** 勾选后才过滤（等价于原来的行为），行号始终是原始行号

实现：`kernel/search.ts`（编译/区间/选择，纯函数可单测）、`kernel/useSearch.ts`
（匹配 + 导航状态）、`kernel/marks.tsx`（高亮渲染）、`kernel/SearchBar.tsx`（共用控件）。

## 启动与懒加载

体积不是约束，**体感延迟**才是：three.js 约 600 KB，只在打开 3D 文件时才需要。

| 产物 | 体积 |
|---|---|
| `lib/client.js` | 109 KB（gzip 33 KB） |
| `lib/three-chunk.js` | 752 KB（gzip 189 KB） |

- 启动只解析主包（约 8 ms，原来是 ~27 ms）；
- 插件激活后用 `requestIdleCallback` 预热 chunk（3 秒兜底），打开 3D 时通常已在内存里；
- `kernel/three-loader.ts` 只用**一个共享 promise**，预热与打开预览不会重复下载；
- chunk 由回环路由 `/any-preview/asset/three-chunk.js` 提供（`text/javascript` + CORS），
  `import()` 的说明符在运行时生成，打包器不会内联它；
- 没有 `webServer` 的 profile 取不到 chunk，3D 预览会显示错误，其它格式不受影响。

## 构建

用 checkout 里的 tsdown（本包自身没有 node_modules）：

```sh
node "D:\DSH\deepseek-harness\node_modules\tsdown\dist\run.mjs"
```

产物：

- `lib/index.js` —— ESM，给 Loader 的 host 半
- `lib/client.js` —— CJS 闭包工厂，首行是 `window.__ModuleLoader__.load({ id, factory })`，
  只 `require('react')` 和 `require('react/jsx-runtime')`（都是平台模块表里的外部依赖）

⚠️ 客户端 bundle 不能打包 React 或 `@deepseek-ai/*`——它们必须留在模块表里，否则会出现
第二份运行时实例。

## 测试

```sh
npm test
```

- `test/pipeline.test.mjs`：在所有可能的切分点上比对「分块解析」与「整串解析」，
  覆盖引号跨块、CRLF 跨块、行预算与 `finish` 幂等
- `test/lines.test.mjs`：增量行切分，同样在每一个切分点上比对
- `test/diff.test.mjs` / `test/log.test.mjs` / `test/jsonl.test.mjs`：diff 分类与计数、
  日志级别与预算、JSONL 解析与列发现
- `test/route.test.mjs`：假文件系统上跑 `serveMedia`，覆盖 200/206/416/HEAD/404/422
- `test/media-decision.test.mjs`：Blob 兜底的触发条件与上限
- `test/csv-index.test.mjs` / `test/csv-window.test.mjs` / `test/window-state.test.mjs` / `test/csv-state.test.mjs`：
  稀疏索引的锚点与估算、窗口读取与整串解析逐行一致、窗口算术（读哪一段、画哪些行、撑高、
  行高缩放）
- `test/csv-window-dom.test.mjs`：用 jsdom 真正挂载 CSV 正文，验证「首屏出首窗、拖动出占位、
  拖回来命中缓存、撑高精确」；文件源用假 Host（同一个 `alignTextSlice`）验证「按字节跳转、
  行号带 `~`、拖到底看到文件尾部、后台走完后换精确值」；机器上有 `samples/huge.csv` 时还会
  用 22 MB 夹具跑第 20 万行
- `test/text-route.test.mjs`：文本切片路由的行对齐、UTF-8 边界、越界与错误码
- `test/render.test.mjs`：按浏览器方式加载 `lib/client.js`，用真实 React 做 SSR，
  校验每个格式的注册元数据与渲染输出（含 >2 MB 文件的首屏行数与占位）

渲染测试需要 DSH checkout 提供 React，可用 `DSH_REPO` 覆盖默认路径。

## 歧义后缀的判别

渲染器选择**只看路径**（`matchingDocumentPreviews` 不读内容），所以一旦认领扩展名，
就会收到所有带这个后缀的文件。少数扩展名确实对应两种格式，这时用前 1 KB 判定。

`src/client/previews/dispatch.ts`：

```ts
claimsFile(extension, head)   // 表里没有该后缀 → 直接信任，不探测
```

| 后缀 | 判别器 | 依据 |
|---|---|---|
| `obj` | `looksLikeWavefront` | 文本且含 `v/vt/vn/f/o/g/s/mtllib/usemtl` 语句；带 NUL 直接否 |
| `ts` / `m2ts` | `looksLikeTransportStream` | `0x47` 同步字节：0/188/376（TS）或 4/196/388（M2TS） |

约定：

- **只在真有歧义时登记**——不登记就不会多一次读取；
- 判别器是纯函数（不碰 React），便于单测；
- body 拿到 `false` 时应给明确提示，而不是让它解析失败；
- `ts` 目前**故意不认领**：多数 `.ts` 是 TypeScript，内置高亮代码预览比自绘纯文本更好。
  判别器已就绪，等平台支持按内容选渲染器时接上即可。

## chunk 加载策略

chunk 的划分是构建期决定；**何时下载**是运行期策略，集中在
`src/client/kernel/chunk-policy.ts`：

| 值 | 行为 | 当前默认 |
|---|---|---|
| `warm` | 激活后空闲预热（`requestIdleCallback`，3 s 兜底） | `three` |
| `click` | 只在该类文件被打开时加载 | `mux` |
| `never` | 完全不加载，预览显示"已被禁用" | — |

```ts
chunkStrategy(id)       // 当前策略
isChunkEnabled(id)      // never → false，body 据此降级
setChunkStrategy(id, s) // 未来的配置入口；现在没有调用者
warmableChunks()        // 需要预热的 id 列表
```

`client/index.ts` 按 `warmableChunks()` 遍历预热，`model` 与 `ts-player` 在加载前查
`isChunkEnabled`，因此接入配置时只需循环调用 `setChunkStrategy`，不必改预览组件。

## 向对话注册 agent 工具

插件可以注册模型可调用的工具，已验证可行（探针 `preview_probe` 在新会话里成功调用）。
要点全部是踩出来的：

```ts
ctx.inject(['tools'], (toolsCtx) => {
  toolsCtx.effect(() => toolsCtx.tools.register({
    name: 'preview_probe',
    description: '…',
    parameters: {                       // 必须是「已编译」的 JSON Schema
      type: 'object',
      properties: { echo: { type: 'string' } },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) { return { ok: true } },
  }), 'label')
})
```

四条硬规则：

1. **`parameters` 不是作者侧 DSL**。`tools.register` 不再帮你编译；直接给 `{ echo: {…} }`
   会让上游收到 `type: null` 并**拒绝整份工具列表**（表现为该 profile 的对话全部失败）。
   要么用 `defineTool`（`@deepseek-ai/dsh-tools`，插件里不可解析，需内联），
   要么手写编译后的产物：`{ type: 'object', properties: {…} }`（隐式参数根是**开放**的，
   不加 `additionalProperties`）；
2. **输出 schema 的标量不能写 `required`**，只有参数映射的每个属性可以；
3. **注册要包在注入作用域的 `effect` 里**（`toolsCtx.effect(() => register(...), label)`）；
4. **验证必须在新会话里做**。工具列表在会话创建时组装，旧会话不会刷新——
   否则会把"没刷新"误判成"注册失败"。

排查手段：把注册结果记进模块状态，并挂到一条已认证的 HTTP 路由上（我们挂在
`/api/any-preview/asset-base` 的 `probe` 字段），在控制台一行 `fetch` 就能区分
"没注册"与"不可见"。
## `preview_inspect`：把解析能力交给模型

工具名 `preview_inspect({ path })`，返回 `{ kind, summary, truncated }`——**给形状，不给内容**。
`read` 负责按行给内容，二者互补；不要再用工具重复 `read` 的能力。

当前支持 `.gguf`（版本 / KV / 张量表）与 `.csv/.tsv/.tab`（方言 / 列 / 行数估算）。
只读窗口：二进制 4 MB、文本 1 MB；输出有界（各 ≤ 20 项）。非支持格式直接报错。

### 大 CSV 报什么

一个 150 MB 的 CSV 用 1 MB 只能描述它自己的 1 %，所以 `.csv` 还会读**三个 32 KB 的窗口**
（1/3、2/3、5/6 处）和末尾 1 KB，从整份文件回答：

| 字段 | 从哪来 |
|---|---|
| `rows: ~2,032,730` | 头 + 3 个窗口的行密度（`shared/inspect/density.ts`，与面板共用同一套算术）|
| `× bytes/row`（如 72–81） | 每个窗口自己的 bytes/row，写作区间 |
| `row length varies 1.12×`（note） | 窗口之间的密度差：字节位置映射行号只能到 ±12 %，这也是"估算行数 ≠ 精确行数"的原因 |
| `delimiter:` + `same in all N windows` | 每个窗口各跑一次 `detectDelimiter`；不一致就在 note 里点名 |
| `line endings` / `ends with a newline` | 头 + 末尾 1 KB（末行没有换行时行数会差一）|
| `encoding` / BOM | 严格 UTF-8 解码失败 → "invalid bytes replaced"；BOM 单独说明（会污染第一列列名）|
| `header:` | 数据列是数字/布尔、而第 0 行对应单元格是文本 → 确认有表头；两者同型 → "none detected"；全文本列无法确认 → "assumed" |
| `name: integer (1, 2) · ascending in samples` | 每列在头 + 各窗口的前 20 行里取值：类型、两个样例、空值比例、在样本里是否单调；**头里是 integer 而样本里有 `N/A` 会写 `also string`** |

`truncated` 只表示**schema 被截到 20 列**，不再表示"只读了 1 MB"（那是 `notes` 里的一句，
写得清楚得多）。不做事：列统计、更多样本行，那是查询工具的活。

### 相对路径怎么解析（踩坑记录）

`ctx.fs` **不知道**会话工作区在哪：`processPathFromHostPath('samples/x.csv')` 会拼到应用 cwd
（profile 目录），`fs.resolve(relative)` 同样如此，契约里也没有 root 访问器。

正解是接 `sandboxPolicy`（`workspace-write` 所指的那个根）：

```ts
ctx.inject?.(['sandboxPolicy'], scope => { sandbox = scope.sandboxPolicy })
const policy = sandbox?.resolve(exec?.agent ? { session: exec.agent.session } : {})
const cwd = policy?.workspaceRoot ?? policy?.root
target = await ctx.fs.resolve(path, { cwd, signal })
```

`resolve` 的 `opts.cwd` 是官方支持的相对基准（`fs/fs/src/index.ts:128`）。

### 验证方式

**必须在新会话里测**：工具列表在会话创建时组装，旧会话不刷新。这条已经坑过一次。
## 预览外壳（`PreviewChrome`）

13 个文本/结构化预览共用 `src/client/kernel/chrome.tsx`，只有四块：

### 视觉一律走宿主的 token

颜色只用 `--dsw-alias-*`（`bg-document-preview`、`label-*`、`border-l1..l4`、`state-*`），
不许出现 `rgb()`：深色主题由宿主在 `body[data-ds-dark-theme]` 上翻转这些别名，硬编码就翻不过来。
分隔线统一 **0.5px**（宿主文档面是 hairline，1px 会把表格画成"网格"），圆角取 `--dsw-radius-xs/sm`，
代码字体是 `--ds-font-family-code`（`--dsw-font-markdown-code-block` 是**简写**，不能当 font-family 用）。
搜索框的焦点环画在外层 field 上（2px `state-business-primary`），因为 field 才是控件。

详情与前后对照见 `handoff` §18。

```tsx
<PreviewChrome
  title={…}     // 摘要：3 行 × 5 列、GGUF v3、+8 −4
  toolbar={…}   // 搜索等控件；也接受 (compact: boolean) => ReactNode
  status={…}    // 一行状态：截断、上限、错误
  tone="normal" | "critical"
>
  {body}
</PreviewChrome>
```

### 四条约定

1. **根节点必须用 `PANE_ROOT`**（`position: absolute; inset: 0`）。文档容器的 `.body` 可能**自己就是滚动容器**，用 `height: 100%` 会让整个外壳跟着内容滚走——顶栏消失就是因为这个。别自创等价样式。
2. **文件名不进 `title`**：文档 tab 已经显示它，重复一遍等于在最窄的维度上放两份信息。`title` 只放"摘要"。
3. **状态行固定在底部**，`white-space: nowrap` + 省略号：长文案不能折行顶起正文。
4. **`toolbar` 传函数时拿到 `compact`**，由 chrome 按实测宽度决定。

### 响应式：一个阈值

```ts
const COMPACT_WIDTH = 420   // chrome 自身宽度（ResizeObserver 实测）
```

| 宽度 | 标题 | 工具栏 |
|---|---|---|
| ≥ 420px | 显示 | 完整（搜索 + 计数 + 仅匹配） |
| < 420px | 隐藏 | 精简（计数与"仅匹配"隐藏） |

阈值**不是拍的**：完整搜索行的固定部分（输入框 150 + 两个开关 60 + 计数 48 + 箭头 60 + 标签 60）约 380px，取 420 留余量。最初设 260，结果紧凑模式永远触发不到，是死代码——**阈值要从实际布局反推**。

为什么用实测而不是固定断点：侧栏最小宽度是壳层决定的（`ui-dockkit` 的 `MIN_PANE_FRACTION = 0.12`，即停靠区宽度的 12%），窗口 1024px 时只有约 123px，任何写死的像素数都对不上。

### 搜索框

`src/client/kernel/SearchBar.tsx`：

- `Aa`、`.*` **内嵌在输入框里**（编辑器风格），不额外占顶栏宽度；
- `Enter` 下一个命中、`Shift+Enter` 上一个、`Esc` 清空并失焦；
- 不再显示"共 N 行"——表格里已能看到，属于冗余；
- `compact` 时隐藏计数与"仅匹配"，搜索框与箭头保留。

### 迁移方法（下次照做）

不要用"整段 JSX 字面替换"——缩进稍差就静默失败或改坏。用行号：

1. `grep` 出 `<div style={PANE_ROOT}>` 与末尾 `</div>`（4 空格缩进 + 下一行 `  )`）的精确行号；
2. **从文件尾部往前改**，避免索引位移；
3. 一个文件有多个返回分支时（`archive` 有两个），逐个 open 配对各自的 close；
4. 改完立刻 `typecheck` + 全量测试，再提交。
## 压缩包：一个 UI，两种容器

zip/tar 与 7z 的差别只在"字节从哪来、怎么写盘"，交互必须完全一致。为此抽出两个
共享组件，**新增容器格式不得另写界面**：

```
previews/archive/EntryView.tsx   条目页：富渲染 / 解压面板 / 自动打开 / 重新解压
previews/archive/ArchiveList.tsx 列表页：摘要 / 提示 / 重新解压 / 清理解压 / 表头
kernel/content-modules.ts        按扩展名挑"能只靠内容渲染"的预览（csv/md/jsonl/…）
```

### 容器要提供的三件事

| 能力 | zip | 7z |
|---|---|---|
| `loadBytes()` | 范围读 + `DecompressionStream` | wasm 解码 + 按 `folder.sizes` 切片 |
| `write(bytes, force)` | Host 路由 `extract` | Host 路由 `write`（base64，浏览器已解码） |
| `check()` / `addressOf()` | 路由 `check` + `extractedAddress` | 同左 |

列表额外需要 `onReextract` / `onClean` 两个回调——**不要**在组件内部假设解压由谁执行。

### 为什么"重新解压"必须在列表栏

解压成功后文件在主预览打开，侧栏的压缩包面板回到列表页；条目页的「重新解压」只存在于
"无法内嵌渲染"的分支，文本条目根本看不到。列表栏因此是唯一能强制重写的入口。

### 条目内容的取舍

- 有对应 `CONTENT_MODULES` → 交给该预览渲染（csv 出表格、md 出 markdown）；
- 否则按可读性判断：像文本就给 `<pre>`，否则给前 4 KB 的十六进制并提示"解压后用主预览查看"。

判定用 `looksTextual()`（控制字符比例 < 5%），避免把二进制当作文本渲染成乱码。
### 流式解码（超大 solid 文件夹）

一次性解码要整个文件夹进内存，受 wasm 堆上限（512 MB）约束。超过阈值时改走流式：

```
dec_open → 循环(读 1 MB packed → dec_push → 只留目标区间 → append 到 .part) → dec_finish → rename
```

- 句柄表：`wasm/shim.c` 的 `dec_open/dec_push/dec_finish/dec_close`，8 个槽位，
  每槽持有一个 `CLzmaDec`/`CLzma2Dec` 词典，**跨调用保留状态**；
- 区间裁剪：`stream.ts` 按 `folder.sizes` 前缀和算出成员区间，只把落在区间的字节
  交给 sink，达到 `range.end` 立即停止；
- 落盘：路由 `begin/append/end/abort`，先写 `.<name>.part`，最后 `rename`；
  失败即删，不留半成品；
- 阈值：`STREAM_THRESHOLD_BYTES = 64 MB`，`shouldStream(size, threshold)` 可注入，
  测试用小夹具 + 小阈值即可覆盖同一条路径；
- 边界：只有**单 coder**（LZMA/LZMA2/Copy）能流式；BCJ/BCJ2 需要整块缓冲，
  仍走一次性路径。

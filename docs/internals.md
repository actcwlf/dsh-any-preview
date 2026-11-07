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
  比"只过滤看得见的部分"诚实；搜索仍高亮，>2 MB 时由搜索行显示全文扫描进度与已找到数；
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
- **计数**：已提交搜索的 `当前/总数`；CSV 大文件在输入阶段只显示 `Enter 搜索全文`，
  不把已加载行的局部命中当作总数
- **`Aa`** 区分大小写、**`.*`** 正则模式；正则写了一半不合法时按「无查询」处理，不报错
- **「仅匹配」** 勾选后才过滤（等价于原来的行为），行号始终是原始行号
- **全文扫描**：完整内容输入即全文；windowed CSV 由 Enter 提交，扫描中显示已找到数和
  进度，可停止；扫描完成后显示全量匹配数，但可跳转匹配仍受 5,000 条上限约束，
  状态栏会说明

实现：`kernel/search.ts`（编译/区间/选择，纯函数可单测）、`kernel/useSearch.ts`
（匹配 + 导航状态）、`kernel/marks.tsx`（高亮渲染）、`kernel/SearchBar.tsx`（共用控件）。

本地搜索（按行/record）与全文扫描（原始文本、出现次数）目前仍不是同一套匹配语义；
详细差异、候选方案和后续块索引前提记录在
[`search-semantics.md`](search-semantics.md)。

## 启动与懒加载

体积不是约束，**体感延迟**才是：three.js 约 600 KB，只在打开 3D 文件时才需要。

| 产物 | 体积 |
|---|---|
| `lib/client.js` | 167 KB（gzip 52 KB） |
| `lib/three-chunk.js` | 776 KB（gzip 196 KB） |
| `lib/model-extras-chunk.js` | 190 KB（gzip 61 KB，按需） |
| 解码器 wasm/js（`lib/draco_*`、`lib/basis_*`） | 836 KB（按需 fetch） |

- 启动只解析主包（约 8 ms，原来是 ~27 ms）；
- 插件激活后用 `requestIdleCallback` 预热 `three` chunk（3 秒兜底），打开 3D 时通常已在内存里；
- `kernel/three-loader.ts` / `model-extras-loader.ts` 共用一个按资产名缓存的 promise 表
  （`kernel/chunk-loader.ts`），预热与打开预览不会重复下载；
- chunk 由回环路由 `/any-preview/asset/<name>` 提供（`text/javascript` + CORS + 正确 MIME），
  `import()` 的说明符在运行时生成，打包器不会内联它；
- 没有 `webServer` 的 profile 取不到 chunk，3D 预览会显示错误，其它格式不受影响。

## 3D 模型预览

`previews/model/` 是唯一需要 WebGL 的预览：`loading: 'renderer'`，字节从
`/api/any-preview/media` 整取（不走 base64 管道），解码在懒加载的 chunk 里完成。

- **状态按文件归属**：视图状态、下载进度、`.obj` 判别结果都以 `url#revision` 为 key；
  换文件或工具栏重载（`content.revision` 变化）时整体失效，不会把上一个模型的
  三角形数、错误文案或场景留在新文件下。
- **可恢复**：加载/解析失败在面板内显示并给出「重试」（`attempt` 让 effect 重跑）。
  WebGL 创建失败只在本面板报错——若让异常冒泡，宿主的 slot 边界会把该 entry 退役，
  本次会话后续所有模型都会变成空白。`webglcontextlost` 会阻止默认恢复、停掉循环并在
  面板内提示重试，而不是留下一块冻结的画布。
- **可取消、分阶段**：一个 `AbortController` 同时管整文件 fetch、`.obj` 头部探测、
  glTF 外部 buffer/image 与 MTL 贴图的预取；下载进度来自流式读取，桌面代理不给
  `Content-Length` 时退化为「已读字节」。下载完成后切到「正在解码」阶段，避免
  100% 之后长时间只有静态加载文案。
- **外部资源**：`loadBinary` 先把 glTF 的 `.bin`/图片和 MTL 贴图读成 Blob，再以
  `blob:` URL 交给 three；这样请求可被 abort，也绕开了 three loader 没有 signal 的限制。
- **贴图预算**：`declaredImageBytes` 检查 glTF 内嵌/`bufferView` 图片，外部图片与 MTL 贴图
  在预取时按 Blob 大小累计；超过 `LIMITS.modelTextureBytes`（64 MB）直接报错，避免
  解码后的显存把标签页拖死。
- **错误文案**：面板里只出现 i18n 文案；three/loader 的原始错误只进 console，
  且保持它的原文与语言，不再转成中文。
- **取景**：`model/frame.ts` 是纯函数，按包围球和垂直/水平 FOV 中较小者算距离，
  near/far 跟随模型尺度（不再有 1000 的地板）；面板尺寸变化时，在用户手动操作前重新取景。
- **主题**：画布底色读 `--dsw-alias-bg-base`；网格与线框取主题对应的固定对比色
  （不再由底色推导，浅色主题下也不会淡到看不见）。宿主把主题投影为
  `body[data-ds-dark-theme]` 与 body/html 上的 token 变量，`useModelViewer` 用
  `MutationObserver` 监听这些属性：切换浅/深色时重算画布底色、重建网格、更新线框材质，
  不用重开文件。
- **释放**：`disposeObject` 遍历所有带 geometry/material 的节点（不止 `Mesh`），
  网格也一并释放。
- **STL 法线**：STL 的 facet normal 经常是全 0 或与绕序不一致（工作区的
  `samples/tetra.stl` 就是 12 个全 0，直接渲染会因零向量归一化成 NaN 而全黑）；
  解析后用 `computeVertexNormals()` 从绕序重算。STL 是非索引几何，得到的正是每个面的
  平面法线，符合格式的 faceted 外观。
- **面朝向**：OBJ 与 STL 默认 `DoubleSide`。OBJ 没有 side 约定，不同导出器的顺/逆时针
  不一致；工作区自带的 `samples/cube.obj` 就是全部朝内绕序，单面渲染会把近侧面当背面
  剔除、显示成一个"空房间"。glTF 仍按其 `doubleSided` 标记渲染，不替作者改 culling。
- **动画/骨骼**：glTF 的 `gltf.animations` 挂在根节点的 `userData.animations` 上；
  `AnimationMixer` 默认同时播放轨道不冲突的 clip（常见为骨骼 clip + 形态键表情
  clip），动画条右侧的多选菜单逐个开关，并同步播放/暂停/时间轴；菜单列表可滚动，
  不随 clip 数量挤占播放条。
  `SkinnedMesh` 关闭视锥剔除，避免骨骼把网格移出绑定姿态包围盒后被裁掉；销毁时
  `Skeleton.dispose()` 释放骨骼纹理。OBJ/STL 没有动画。
- **动画取景**：加载后对默认激活 clip 的起点、中点、终点采样当前姿态的包围盒
  （`SkinnedMesh.computeBoundingBox()` 走骨骼变形后的顶点；超密网格退回骨骼位置），
  用并集居中、取景和铺网格，避免动画抬手/移动根节点后镜头裁切。采样后恢复原动作时间。
- **纹理预算**：除了压缩字节上限，还限制单张最长边 4096、总解码像素 32 MP；
  超限图片在首次上传前用 `createImageBitmap` + canvas 降采样，并保持相对分辨率；
  信息条提示已降采样。KTX2/compressed texture 跳过该路径。
- **环境与工具**：`RoomEnvironment` + `PMREMGenerator` 生成环境贴图，
  `ACESFilmicToneMapping` 让 PBR 金属不再发黑；OBJ/MTL 保持原生 Phong（不吃
  `scene.environment`），另有一盏低强度下方补光（`DirectionalLight` 0.4，位置
  `(0, -4, 2)`）避免朝下表面只剩深色半球地面光。信息条显示三角形/顶点/材质数与包围盒尺寸，
  工具栏提供重置视角、背景切换、网格、线框、自动旋转，沿用宿主文档工具条的 28px 图标按钮
  （15px、1px 线宽、`--dsw-alias-interactive-bg-hover` 悬停/按下态）；背景默认跟随
  宿主主题，额外提供 跟随主题 → 浅色 → 深色 的三态循环，固定背景时主题观察者不覆盖，
  并同步切换网格/线框的对比色。线框用无光照的
  `MeshBasicMaterial({ wireframe: true, toneMapped: false })` 替换网格材质，
  线条颜色按主题取对比色（原先是让受光材质自己画线，浅色模型在浅色背景上几乎看不见）。
  渲染改为按需：`OrbitControls.update()` 返回是否变化，阻尼/自动旋转/动画都停下后即停掉
  `setAnimationLoop`，启动时只画一帧背景；动画播放时循环保持运行并按 delta 推进
  `AnimationMixer`。

实现分层：`index.tsx` 只做四个扩展名的注册；`ModelBody.tsx` 负责文件名、统计与布局；
`ModelToolbar.tsx` / `ModelAnimationBar.tsx` / `ModelOverlay.tsx` / `model-icons.tsx` 是纯展示；
`useModelViewer.ts` 只做 React 生命周期、加载编排、限制与状态发布：

- `scene-runtime.ts`：renderer、camera、OrbitControls、灯光/环境、grid、线框、主题背景、
  resize 和按需 `setAnimationLoop`；
- `animation-runtime.ts`：mixer、actions、active clip、播放/暂停/seek 与姿态包围盒采样；
- `theme.ts` / `animation.ts` / `frame.ts` / `animated-bounds.ts` / `texture-budget.ts`：纯逻辑；
- `format.ts`：格式适配器注册表，内置 glTF/OBJ/STL，后续 PMX 可独立注册；
- `decode.ts`：字节解析与资源沙箱，不再靠一个 `if` 链增长格式分支。

UI 基线在 `kernel/ui.ts`：所有预览共用 **32px** `PreviewChrome` 二级工具条（宿主
文档头仍是 38px）、28px 控件、13/20 的 chrome 字体、12/18 的元信息、`--dsw-font-family` /
`--dsw-font-mono`；模型与媒体也走同一个 `PreviewChrome`，不再自建不同高度的
顶栏。格式自身的摘要/工具栏通过 `PreviewChrome` 的 `title` / `toolbar` / `status`
传入，避免第二层 bar 和内容起点漂移。
`PreviewChrome` 的左侧统一由 `PreviewTitle` 渲染：小号格式 badge（CSV/LOG/EPUB/3D…）
加 13/20、500 字重的主标题；主标题可以是内容摘要、文件名或书名，但字号、字重和
颜色不再由各预览自行决定。格式 badge 保留 ASCII 缩写，作为文件类型标识不翻译；
本地化文案集中放在主标题/状态里。加载/错误状态用 `PreviewState` 保留同一根 32px bar；
窄宽度下 Model/Archive/EPUB 用 `ToolbarOverflow`（⋯ 菜单）收纳次要控件，不再靠
裁切；文本控件统一使用 `dsh-preview-control` 的 hover / focus-visible / disabled 状态。
bar 的间距采用宿主的 `0 6px 0 16px` / 4px gap；header 控件是 28px ghost（无描边、
secondary ink），内容区动作另用 `dsh-preview-action`（`bg-layer-2` + 细边框 + 13/20）。
根节点正文行高与宿主一致为 1.6。CSV / JSONL / Archive / Inspect 的列头共用
`DATA_TABLE_HEADER`：28px、4% ink tint、12/18、600、16px 左右内边距；Model 动画条
降为 28px 的内容 transport，不再和 32px chrome 同权。
Markdown 正文用 1.6，标题 700，代码 11/18 + radius-sm，表格用 10/16 padding 和
横向分隔；Archive EntryView 的路径输入、面板和正文统一到 28px 控件与 13/1.6。
元数据检查器的 `Summary` 现在位于内容滚动区顶部，不再是一条独立的 32px chrome
strip；空间不足时 chip 换行并随内容滚走，内容起点仍由同一个 32px bar 决定。
`PreviewChrome.status` 只在 `tone` 为 `warning` / `critical` 时渲染；正常信息不再
额外占用一条 28px 底栏。搜索框沿用宿主 search-field 语法：28px、l3 细边框、
`:focus-within` 只改边框颜色，不再叠加 2px 外环；`Aa` / `.*` 是字段内的 ghost
切换，查询非空时显示 20px 清除按钮。
搜索语义按 `fullSearch` 状态区分：完整内容输入即全文；windowed CSV 输入只做本地
高亮、不显示总数，Enter 启动全文扫描；扫描中显示“已找到 N · 进度”，停止后保留
部分结果但不算完成。扫描完成后计数显示**全量匹配数**；可跳转匹配的 5,000 条上限
只由状态栏说明，不再用截断后的行数冒充总数。

### 解码器与外部资源

- Draco / KTX2 / meshopt 的加载器在 `lib/model-extras-chunk.js`（`model-extras` 策略默认
  `click`）；只有 glTF 的 `extensionsUsed` / `extensionsRequired` 声明了对应扩展时才加载，
  解码器 wasm 再按需从资产路由取。OBJ 的 `MTLLoader` 随基础 chunk 一起加载。
- 解码器二进制来自 three 自带的 `examples/jsm/libs/{draco/gltf,basis}`，
  由 `scripts/sync-decoders.mjs` 在构建时拷进 `lib/`：不新增 npm 依赖，运行时也不走 CDN。
  `ASSET_MIME` 同时是回环路由的白名单，wasm 声明为 `application/wasm`。
  构建脚本校验四个文件的 SHA-256 与字节数；three 升级换掉 decoder 时会直接失败，
  不会静默混用不同版本的 Draco/Basis。
- `.gltf` 的外部 `.bin`/贴图与 `.mtl` 里的贴图都经过 `previews/model/resources.ts` 的同目录
  沙箱：拒绝绝对 URL、盘符、`//host`、`..` 以及百分号编码的穿越。glTF 的越界引用在解析前
  就报错；OBJ 的材质库读取失败则降级为无材质并在信息条提示。
- 外部资源不进入宿主的 `addResource` 依赖跟踪：改 `.mtl`/贴图不会自动刷新，重开文件即可。

测试：`test/model-frame.test.mjs`（取景与网格算术）、`test/model-decode.test.mjs`
（glb/obj/stl 解码、MTL、外部 buffer 走签名路由、三角形/顶点/材质统计、解码器装配、
动画 clip 挂载与 `AnimationMixer` 推进、释放、流式读取）、`test/model-resources.test.mjs`
（沙箱、扩展识别）、`test/model-extras-loader.test.mjs`（解码 chunk 的共享与重试）、
`test/model-animation-runtime.test.mjs`（多 clip 默认叠加/播放/seek）、
`test/model-format.test.mjs`（格式适配器注册）、`test/model-texture-budget.test.mjs`
（降采样计划）、`test/model-animated-bounds.test.mjs`（动画包围盒），夹具在 `samples/`。

已知限制：KTX2 的转码器跑在 `blob:` Worker 里（当前页面无 CSP，桌面 `dsh-app://` 下需实测）；
动画只支持 glTF clip，默认循环播放，不提供单次播放/倍速/根运动特判；多个
clip 同时播放时按轨道名去重，默认只叠加互不冲突的 clip，手动叠加冲突 clip 的
覆盖顺序由 `AnimationMixer` 决定；动画包围盒只在加载时按默认 clip 采样三次，
不会随播放实时重算；超密网格的包围盒退回骨骼位置，可能略小于真实蒙皮范围；
`preview_inspect` 还不认识 3D。

## 构建

`tsdown` 是 devDependency；安装依赖后一次构建即可：

```sh
npm install
npm run build
```

`sync-decoders.mjs` 把 three 自带的 Draco（glTF 构建）与 Basis 转码器从
`node_modules/three/examples/jsm/libs/` 拷到 `lib/`，名字与 `ASSET_MIME` 对应；
`npm run build` 会依次执行这两步。

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
搜索框的焦点颜色画在外层 field 的边框上（`state-business-primary`），不再叠加 2px 外环。

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
- `Enter` 在完整内容上跳下一个命中；在 windowed CSV 尚未全文扫描时提交全文扫描，
  扫描完成后再次 `Enter` 才跳下一个；
- `Shift+Enter` 上一个命中、`Esc` 清空并失焦；
- 查询非空时显示 20px 清除按钮；字段内 toggle 是 ghost，不再画描边；
- 上一个/下一个用 15px chevron，清除用 12px cross，停止扫描用 10px stop；
- 不再显示"共 N 行"——表格里已能看到，属于冗余；
- `compact` 时隐藏计数与"仅匹配"，搜索框、箭头和停止扫描保留。

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
previews/archive/ArchiveList.tsx 列表页：摘要 / 动作 / 列头 / 行 / 通知
kernel/content-modules.ts        按扩展名挑"能只靠内容渲染"的预览（csv/md/jsonl/…）
```

列表页保持和 CSV 相同的第一行起点：`38px` 宿主 header + `32px` chrome +
`28px` 列头 = `98px`。列头使用 4% ink tint 和 caption 字重；文件行动作使用
28px 固定行高和 hover，操作结果用底部 toast（成功 4s、失败 6s 自动消失），
不再把提示文字塞进工具栏；7z unsupported 是持久状态，走 bottom status 而不是 toast。
条目页不再套第二层 Archive chrome：模块 Body 由 `PreviewEmbedContext` 提供 back/label，
`PreviewChrome` 在左侧渲染返回按钮并把条目名拼进标题；`.txt` / hex / 解压 /
loading/error 用单层 Entry shell（`TEXT` 或 `ARCHIVE`），因此压缩包成员不会再出现
两层 32px bar。

### 容器要提供的三件事

| 能力 | zip | 7z |
|---|---|---|
| `loadBytes()` | 范围读 + `DecompressionStream` | wasm 解码 + 按 `folder.sizes` 切片 |
| `write(bytes, force)` | Host 路由 `extract` | Host 路由 `write`（base64，浏览器已解码） |
| `check()` / `addressOf()` | 路由 `check` + `extractedAddress` | 同左 |

列表额外需要 `onReextract` / `onClean` 两个回调——**不要**在组件内部假设解压由谁执行。

解压布局由 `shared/archive-paths.ts` 统一：

```text
<archive-parent>/.dsh-any-preview/<archive-name>/<entry-relative-path>
```

每个压缩包一个子目录，条目保留相对路径；Host 写入、`check`、流式 part 文件、
`extractedAddress` 和 clean 都使用同一套 `safeEntryPath`，避免两个压缩包或同包两个
目录的同名条目落到同一个文件。clean 只允许删除 `.dsh-any-preview/<archive-name>/`
这一层，不再删除共享根目录。

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

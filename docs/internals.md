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
    │   ├── lines.ts         # 增量行切分（CRLF、跨块）
    │   └── text-pipeline.ts # 增量分隔符解析 + 有界行缓冲
    └── previews/
        ├── index.ts     # ★ PREVIEWS 数组：唯一的注册清单
        ├── csv/         # 流式表格（虚拟滚动）
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
`kernel/text-pipeline.ts`），避免整段重解析的 O(n²)；行缓冲有上限（默认 20 000 行），
到顶后停止累积并提示「已截断」。

CSV 的行是**虚拟滚动**的：固定行高 + overscan，只挂载视口内的行，上下用撑高的空行维持
滚动条长度。

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
- `test/render.test.mjs`：按浏览器方式加载 `lib/client.js`，用真实 React 做 SSR，
  校验每个格式的注册元数据与渲染输出

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

当前支持 `.gguf`（版本 / KV / 张量表）与 `.csv/.tsv/.tab`（分隔符 / 列 / 前 10 行）。
只读窗口：二进制 4 MB、文本 1 MB；输出有界（各 ≤ 20 项）。非支持格式直接报错。

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
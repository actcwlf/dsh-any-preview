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

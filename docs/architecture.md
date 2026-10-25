# dsh-any-preview 架构设计

> 基线 `dsh-v0.2.0-rc.2` / 桌面版 `0.2.1-rc.1`。状态：设计稿。
>
> 三条已定决策：
> 1. **CSV 保留**，且必须能看超大文件（流式，不依赖整文件入内存）
> 2. **媒体并入主包**，不做 `dsh-any-preview-media` 这类独立包
> 3. **面向「未来大量预览类型」设计**，新增一种格式的成本要压到最小

---

## 1. 目标与非目标

**目标**

- 一个包承载任意数量的文件预览类型，新增格式只需加一个目录 + 一行注册
- 大文件是第一等公民：CSV/日志不随文件增长而涨内存
- 音视频可播可拖，不吃整文件内存
- 单个类型崩掉不影响其它类型、不影响侧边栏

**非目标**

- 不重做 DSH 已内置的渲染器（office/excel/pdf/image/html/markdown/code）
- 不做编辑器，一律只读
- 不接管 `text` tab（那是「魔数嗅探 + 未知格式兜底」的另一档工程，见 §11）

---

## 2. 三条硬约束（决定了架构形状）

| 约束 | 含义 | 架构后果 |
|---|---|---|
| **一个包 = 一个客户端 bundle** | `exports["./client"]` 只有一个入口；bundle 是闭包工厂（`window.__ModuleLoader__.load({factory})`），没有模块 URL 基准 | **不能用动态 `import()` 分包**。所有类型同处一个文件 → 必须靠「内核共享 + 每类型极薄」控制体积 |
| **注册按后缀匹配** | `documentPreviews` 只认 `extensions`，没有内容判定钩子 | 分发只能基于后缀；后缀必须先声明、且不得重复 |
| **加载模式注册时定死** | `text-pages` / `bytes-complete` / `renderer` 三选一，不能按文件大小切换 | 同一后缀只能选一种策略。超大文件必须走 `text-pages`（分页文本）或 `renderer`（自取流），**绝不能选 `bytes-complete`** |

---

## 3. 核心抽象：`PreviewModule`

每个预览类型实现同一个接口，内核只认这个接口、不认识具体格式：

```ts
interface PreviewModule {
  /** 全包唯一；同时是 documentPreviews 的 id 和 document 槽的 key。 */
  readonly id: string
  readonly extensions: readonly string[]
  /** 这些后缀是二进制，禁止回退到纯文本（必须是 extensions 子集）。 */
  readonly binary?: readonly string[]
  readonly load: 'text-pages' | 'bytes-complete' | 'renderer'
  readonly wrap?: boolean
  /** i18n 标题，取 `anyPreview.<id>.title`。 */
  readonly titleKey: string
  /** 正文。 */
  readonly Body: React.ComponentType<PreviewBodyProps>
  /** 可选：工具栏动作，注册进 sidebar.right.tab.document.actions。 */
  readonly Actions?: React.ComponentType<PreviewActionsProps>
  /** 可选：无法渲染时展示的替代动作，注册进 .unpreviewable。 */
  readonly Fallback?: React.ComponentType<PreviewUnpreviewableProps>
}
```

**新增一种格式 = 新建一个目录实现这个接口 + 在 `previews/index.ts` 数组里加一行。** 不需要碰内核、不需要改注册逻辑。

---

## 4. 目录结构

```
src/
├── index.ts                  # Host 半：只挂媒体路由（未来再加 Host 服务）
├── host/
│   └── media-route.ts        # /api/any-preview/media：Range + 分块流
└── client/
    ├── index.ts              # 客户端入口：遍历 PREVIEWS，统一注册
    ├── kernel/
    │   ├── types.ts          # PreviewModule / PreviewBodyProps 等
    │   ├── source.ts         # 三种 content 模式 → 统一 usePreviewSource()
    │   ├── text-pipeline.ts  # 增量文本管线（防 O(n²)）
    │   ├── virtual-rows.ts   # 行虚拟滚动（大表格/日志共用）
    │   ├── boundary.tsx      # 每个 Body 的 error boundary
    │   ├── chrome.tsx        # 共享外壳：头部信息条、空态、失败卡
    │   └── locale.ts         # 统一字典命名空间 anyPreview
    └── previews/
        ├── index.ts          # ★ PREVIEWS 数组：唯一的注册清单
        ├── csv/              # 流式表格（大文件主线）
        ├── json/             # 树 + 源码
        ├── yaml/
        ├── log/              # 尾部跟随、级别着色
        ├── media/            # video + audio 两个模块，共用播放器
        └── …                 # 未来在这里加
```

---

## 5. 注册与分发流程

```
client/index.ts
  ├─ locale.register('anyPreview', dict)
  ├─ for each module of PREVIEWS:
  │    ├─ documentPreviews.register({ id, extensions, binaryExtensions: binary,
  │    │                                priority: 'extension', loading: load })
  │    └─ slots.inject('sidebar.right.tab.document',
  │          () => slots.register({ name, key: id, locale: 'anyPreview' },
  │                               <Boundary><Body/></Boundary>))
  │    ├─ 若 module.Actions  → slots.inject('sidebar.right.tab.document.actions', …)
  │    └─ 若 module.Fallback → slots.inject('sidebar.right.tab.document.unpreviewable', …)
  └─ 每个注册单独 try/catch：一个模块声明有误，只丢它自己，不拖垮整包
```

**启动期自检**（开发期断言，生产期静默）：`id` 唯一、`extensions` 非空、`binary ⊆ extensions`、后缀无跨模块重复。

---

## 6. 内容适配层：抹平三种模式

Body 不直接读 `content`，统一走：

```ts
usePreviewSource(content) →
  | { kind: 'text';  text; eof; revision }        // 来自 text-pages
  | { kind: 'bytes'; data }                       // 来自 bytes-complete
  | { kind: 'stream'; url(): string; loaded(); failed(); }  // 来自 renderer
```

好处：换加载策略只改模块的 `load` 字段，Body 代码基本不动；三种模式的生命周期
（`loaded` / `failed` / `reload`、`revision` 变化重建）集中在一处处理。

---

## 7. 大文件策略（CSV 为主）

内置 excel 是 `bytes-complete` + 16 MiB 上限，超大 CSV 打不开——这正是我们保留 CSV 的理由。

我们的做法（全部基于 `text-pages` 的累积文本）：

1. **增量解析**：`text-pipeline` 保留解析器状态，每来一页只消费新增文本，**绝不从头重解析**（现版本的真实隐患，P0 必修）。
2. **有界内存**：只保留「行偏移索引 + 当前视口窗口的单元格」，不保留全量二维数组。解析到第 N 页时，把已消费文本的长度记下来并释放。
3. **虚拟滚动**：只渲染可见行 + 上下缓冲，滚动用行偏移按需切片。
4. **跳转**：支持「跳到行号」「跳到末尾」；末尾需要读取尾部时，走 `renderer` 模式的旁路路由做 Range 读取，或用 Host 的 `readBytes` 读末 N 字节。
5. **阈值行为**：超过约 5 万行时关闭「全量排序/筛选」，改为显式的流式筛选，并在信息条上明示。
6. **明确上限**：超过某个行数（可配）后停止累积，提示「已截断，可下载查看」。

> 验收判据：打开 200 MB / 500 万行 CSV，内存增长不得超过约 30 MB，滚动仍流畅。

---

## 8. 媒体车道（并入主包）

media 只是两个 `PreviewModule`（`video` / `audio`），特殊之处在 Host 半：

- `load: 'renderer'`，Body 用 `usePreviewSource()` 拿到 `stream` 分支
- URL：`new URL('api/any-preview/media?path=…', document.baseURI)`（不写死前导斜杠）
- Host 路由：`ctx.connection.fetch.register({ path: '/api/any-preview/media', methods: ['GET','HEAD'], requestBody: 'buffered' })`
  - 路径经 `fs.processPathFromHostPath` + `processPath` 比对（官方 `present-open.ts` 模式），只放行 Host 真正映射的路径
  - `readByteRange` 1 MiB 分块进 `ReadableStream`，`signal` 中止即关流
  - `206` / `416` / `HEAD` / `Accept-Ranges` / `no-store` / `nosniff` / `download=1`
- 解码失败 → `Fallback`，走 `unpreviewable` 槽

主包因此多一条 Host 路由，但没有新增依赖：播放器是原生 `<video>` / `<audio>`。

---

## 9. 失败与降级（三层）

| 层 | 手段 |
|---|---|
| 模块注册 | 每模块 try/catch，坏模块只缺席自己 |
| 组件渲染 | 每 Body 包 error boundary，渲染失败显示失败卡 + 「用本机程序打开」 |
| 内容加载 | `content.failed()` + 失败卡；文件变更时 `revision` 变化触发重建 |

---

## 10. 体积与性能预算

单 bundle 是硬约束，所以设预算：

| 项 | 预算 |
|---|---|
| 内核（kernel/） | ≤ 15 KB gz |
| 单个文本类预览（csv/json/log） | ≤ 8 KB gz |
| 媒体模块 | ≤ 6 KB gz（无依赖） |
| 全包 | ≤ 60 KB gz 时可直接进主包；超过则重新评估 |

**准入规则**：新增类型若需要 > 30 KB gz 的解析库，先问「内置是否已覆盖」；确需的（如 3D 模型解码器）单独评审，不在本文默认允许范围内。

---

## 11. 「未知格式」这一档（暂不做，留好接口）

DSH 的渲染器注册**只能按后缀**，没有 mime/魔数钩子，所以「打开任何未知文件都有体面呈现」
无法靠 `documentPreviews` 实现，只能接管 `text` tab 类型（`sidebarRightTabs` 的 extension 档）。

本设计**不接管** `text` tab，但保留升级路径：`PreviewModule` 预留可选的
`detect?(head: Uint8Array, name: string): number`，未来若接管 `text`，只需在内核里加一层
「读头部 → 打分 → 选模块」，各预览模块无需改动。

---

## 12. 分期

| 期 | 交付 | 验收 |
|---|---|---|
| **P0** | 内核抽取：csv 迁到 `PreviewModule` + `usePreviewSource` + 增量解析（行为不变） | 现有 CSV 用例全绿；大文件不再 O(n²) |
| **P1** | 媒体车道：Host 路由 + video/audio 模块 + Fallback | 30 MB MP4 可播可拖；`Range` 单测通过 |
| **P2** | 第二波格式：json / yaml / log（验证扩展性） | 新增每种格式 ≤ 1 个目录 + 1 行注册 |
| **P3** | 大文件增强：虚拟滚动、跳转、截断提示 | 200 MB CSV 内存 ≤ 30 MB |
| **P4** | 分发增强：`detect` 预留、unpreviewable 文案统一 | — |

---

## 13. 风险

| 风险 | 缓解 |
|---|---|
| 单 bundle 体积随类型线性上涨 | 每类型预算 + 不准入重依赖 + P2 后实测体积再决定是否破例拆包 |
| 后缀在模块间重复声明 | 启动期断言，构建期也可加检查 |
| 大文件阈值调参困难 | 全部走配置（行数、字节、页大小），不硬编码 |
| Host 路由成为攻击面 | 挂 `/api` 下复用认证 + 严格路径映射校验 + `no-store` + `nosniff` |
| 与内置 excel 抢 csv | 保持 `priority: 'extension'`（我们默认），工具栏仍可切到内置表格视图 |

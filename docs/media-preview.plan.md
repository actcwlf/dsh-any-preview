# dsh-any-preview 音视频预览 实施规划

> 基线：本地 repo `dsh-v0.2.0-rc.2`（HEAD `639ed01`），桌面版 `0.2.1-rc.1`。
> 两个版本都具备本文依赖的契约（`binaryExtensions`、`loading: 'renderer'`、
> `content.kind === 'renderer'`、`ctx.connection.fetch.register`、`ctx.fs.readByteRange`，
> 已在 `app.asar` 中逐项验证）。
> 状态：规划稿，尚未动代码。

---

## 1. 结论先行

音视频预览的难点**不是播放器，是字节流**。

`<video>` / `<audio>` 要拖动进度，浏览器必须发 `Range` 请求并收到 `206 Partial Content`。
DSH 现有的 `/api/file`（`packages/api/session-controller/src/media-references.ts`）：

- 用 `fs.readBytes(target, signal, maxBytes)` **整文件读入**；
- `maxBytes = attachments.imageLimits.maxImageBytes`（默认约 20 MB），超了直接 `413`；
- **完全不解析 `Range`**，永远回 `200` 全量。

所以无论播放器怎么放，几十 MB 的视频要么 `413`，要么整段下完才能拖。

**因此方案定调：新增一条支持 Range 的旁路 HTTP 路由，客户端用 `loading: 'renderer'`
自己拉流。** 这也是 `dsh-media-web-preview` 已经验证过的路线，我们沿用其骨架、换掉
它的两处弱约束（见第 5 节差异）。

---

## 2. 契约基线（0.2.0-rc.2，已逐条核对源码）

### 2.1 文档渲染器

```ts
type DocumentLoadMode = 'text-pages' | 'bytes-complete' | 'renderer'

interface DocumentPreviewDefinition {
  id: string
  extensions: readonly string[]
  binaryExtensions?: readonly string[]   // 必须是 extensions 的子集，否则 register 抛错
  priority?: 'builtin' | 'extension'
  title: () => string
  loading: DocumentLoadMode
  wrap?: boolean
}
```

`content` 是三态联合：

| kind | 载荷 |
|---|---|
| `text` | `{ text, pages, eof }`，累计文本 |
| `bytes` | `{ data: Uint8Array }`，整块 |
| `renderer` | `{ revision, loaded(version), failed(), reload() }` —— owner 不喂内容，渲染器自取 |

`renderer` 模式的收尾动作：加载成功调 `content.loaded(version)`，失败调 `content.failed()`，
文件变更后 owner 会给新的 `revision`。

### 2.2 新增的 slot（0.2.0 起）

| slot | 基数 | 用途 |
|---|---|---|
| `sidebar.right.tab.document.actions` | list | 工具栏动作，owner 给 `absolutePath` |
| `sidebar.right.tab.document.unpreviewable` | list | 「无法预览」空态的替代动作 |
| `sidebar.right.tab.document.action` | keyed（按渲染器 id） | 渲染器自己的控件，排在刷新按钮前 |

> 相比旧版，这三个槽让「下载 / 用本机程序打开 / 播放器倍速」有了正规位置，
> 不必像 media 插件那样把下载链接塞在播放器下面。

### 2.3 Host 侧

```ts
ctx.connection.fetch.register({
  path: '/api/<...>',        // 必须在 /api 之下，才能复用认证与 Host/Origin 校验
  methods: ['GET', 'HEAD'],
  requestBody: 'buffered',
  fetch: request => Response,
})

ctx.fs.resolve(path, { signal })      // → FsTarget（含 displayPath）
ctx.fs.stat(target, signal)           // → { type, size }
ctx.fs.readByteRange(target, { offset, length }, signal)  // → Uint8Array
```

`FsError.code`：`FS_NOT_FOUND` / `FS_NOT_REGULAR_FILE` / `FS_PERMISSION_DENIED` /
`FS_SANDBOX_DENIED` / `FS_TOO_LARGE` / `FS_ABORTED`。

官方已有同款路由的成熟范例：
`packages/client/ui-deliverables/src/present-open.ts`（注册方式 + 路径校验 + `no-store`）。

---

## 3. 内置覆盖盘点：我们现在还剩哪些空白

0.2.0-rc.2 的内置渲染器（`ui-sidebar-documentpreview/src/client/*`）：

| 渲染器 | 后缀 | 模式 |
|---|---|---|
| `text` | 全部（fallback） | text-pages |
| `code` | 代码后缀 | text-pages |
| `markdown` | md / markdown | text-pages |
| `html` | html / htm | — |
| `image` | png jpg gif webp bmp ico svg | bytes-complete |
| `pdf` | pdf | bytes-complete |
| **`excel`** | **xlsx / xls / csv / tsv** | bytes-complete |
| **`office`** | **doc / docx / ppt / pptx** | renderer（Host 转 PDF 后复用 PDF 体） |

两条重要结论：

1. **`csv` 已被内置 `excel` 覆盖**。我们现有的 `dsh-any-preview` CSV 渲染器靠
   `priority: 'extension'` 仍会压过它，但价值主张大幅缩水——用户装了新版就有表格视图。
2. **音视频仍然是空白**，也没有字体、压缩包、3D、超大日志的专用渲染器。

> 因此 `dsh-any-preview` 的定位应从「重做内置已有的格式」调整为
> **「补内置空白 + 做内置不擅长的规模」**。

---

## 4. 三条技术路线与选型

| | A. 旁路 Range 路由（选定） | B. RPC `readBytes` + Blob URL | C. MSE 分片 |
|---|---|---|---|
| 通话方式 | `<video src="/api/...">` | 拉全量字节 → `Blob` → `URL.createObjectURL` | 拉分片 → `MediaSource` |
| 拖动进度 | **立即** | 下载完才能 | 可以 |
| 内存 | O(1 MiB) | **O(文件大小)** | O(缓冲窗口) |
| 大文件 | 任意 | >20 MB 受限 / 易崩 | 可以 |
| 复杂度 | 中（约 200 行 Host） | 低 | 高（需 fMP4/WebM 分片、codec 适配） |
| 结论 | **采用** | 仅作小音频兜底 | 不做 |

B 的硬伤：`readBytes` 会整段进内存再 base64 过 Remote，几十 MB 的音频尚可，视频不行。
C 的硬伤：要为每种容器做分片封装，远超「预览器」的合理投入。

---

## 5. 选定架构

### 5.1 Host 半：`/api/any-preview/media`

```
GET/HEAD /api/any-preview/media?path=<绝对路径>[&download=1]
```

流程：

1. `path` 必须非空、不含 `\0`、`isAbsolute`；
2. `fs.resolve` → `fs.stat`，确认 `type === 'file'`；
3. 解析 `Range: bytes=a-b` / `bytes=-N`（单段；多段与不可解析一律退回 `200` 全量）；
4. 头：`Accept-Ranges: bytes`、`Content-Type`（后缀映射）、`Content-Length`、
   `Content-Range`（206/416 时）、`Cache-Control: private, no-store`、
   `X-Content-Type-Options: nosniff`；
5. body：`ReadableStream` 按 1 MiB 调 `readByteRange`，`request.signal` 中止即关流；
6. `HEAD` 只回头；越界回 `416` + `bytes */<size>`；`download=1` 加 `Content-Disposition`。

**与 `dsh-media-web-preview` 的三处差异**：

| 点 | media 插件 | 本方案 |
|---|---|---|
| 路径校验 | 仅 `isAbsolute` | 走 `fs.processPathFromHostPath` + `processPath` 比对（官方 `present-open.ts` 模式），只放行 Host 真正映射的路径 |
| 下载入口 | 播放器下方链接 | 注册 `sidebar.right.tab.document.actions`，进工具栏 |
| 解码失败 | 播放器位置替换为文案 | 用 `document.unpreviewable` 槽给正式空态动作 |
| 路由命名 | `/api/media` | `/api/any-preview/media`（避免与其他插件撞名） |

### 5.2 Client 半：两个自取内容的渲染器

```ts
// video
{ id: 'dsh-any-preview/video', extensions: [...], binaryExtensions: [...],
  priority: 'extension', loading: 'renderer', wrap: false }
// audio：同构，id 后缀 /audio
```

组件要点：

- `useResource(resourceAddress)` 拿 `absolutePath` / `size` / `version`；
- URL 用 `new URL('api/any-preview/media?...', document.baseURI)`，**不写死前导斜杠**
  （loopback / LAN / MagicDNS / `tailscale serve` 子路径 / 桌面 App 内嵌都靠这一条）；
- `content.revision` 变化 → 重新挂载播放器（用 `key={remote + version}` 强制重建）；
- 挂载即 `content.loaded(version)`（只在 version 变化时调一次，避免循环）；
- `onError` → `content.failed()` 并渲染降级卡片（说明 + 下载 + 新标签页打开）；
- 音频用卡片式布局（文件名 + 大小 + 原生 `controls`），视频用黑底居中 + `maxHeight: 72vh`。

### 5.3 编解码预期（写进 README，别让用户猜）

| 容器 | Chromium 预期 |
|---|---|
| mp4 (H.264/AAC)、m4a、webm、ogg、mp3、wav、flac、opus | 可播 |
| mkv、avi、wmv、部分 mov 编码 | 多半解不了 → 走 `unpreviewable` 降级 |
| midi | 基本不可播 |

---

## 6. 分期

### P0 — 打通最小闭环（1 个路由 + 2 个渲染器）

- Host：`/api/any-preview/media`，支持 GET/HEAD/Range/416/`download=1`
- Client：video + audio 两个定义与两个 body
- 验收：30 MB MP4 能播、能拖到任意位置；`curl -H 'Range: bytes=0-1023'` 回 `206` 且
  `Content-Length: 1024`

### P1 — 体验对齐内置

- `document.actions` 注册「下载」
- 解码失败走 `unpreviewable`
- 中英文案（`ctx.locale.register`）
- 音频卡片：文件名 + 大小 + 时长
- 验收：控制台无异常；切换文件不残留播放状态

### P2 — 健壮性

- 并发请求与 abort（关 tab 不泄漏 fd）
- 文件被外部修改 → `version` 变化 → 播放器重建
- 空文件 / 非普通文件 / 无权限的三种错误码
- 验收：错误路径全部有明确状态码与文案

### P3 — 车道模板化

把「旁路路由 + `loading: 'renderer'`」抽成可复用骨架，后续字体、zip 内浏览、GLB、
超大数据切片都套同一套 Host/Client 约定。

---

## 7. 测试计划

**单元（node --test）**

- `parseRange`：`bytes=0-1023`、`bytes=-500`、`bytes=100-`、`start >= size`（416）、
  `end < start`（416）、空文件（size 0）、多段（退回全量）
- MIME 映射：已知后缀 / 未知后缀（`application/octet-stream`）

**集成（起一个临时 profile）**

- 未认证 → `401`；不受信 Host → `403`
- `Range` → `206` + `Content-Range`
- 越界 → `416` + `bytes */<size>`
- `HEAD` → 无 body、头齐全
- `download=1` → `Content-Disposition: attachment`

**手动 e2e**

- `<video>.readyState === 4`、拖动后 `currentTime` 跟随
- 远程地址（非 loopback）下同样可拖

---

## 8. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 新增攻击面 | 多一条能读文件的 HTTP 路由 | 挂 `/api` 下复用认证；路径必须经 Host 映射校验；`no-store` + `nosniff` |
| 与内置抢后缀 | `csv`/`tsv` 已被内置 excel 认领 | 我们仍用 `extension` 档压过；需决定是否放手（见开放问题） |
| 版本差异 | repo 0.2.0-rc.2 vs App 0.2.1-rc.1 | 按 0.2.0 契约写，App 是超集；`binaryExtensions` 等已在 asar 验证 |
| 编解码不可控 | 浏览器解不了 mkv/avi | 降级卡片 + 下载，不静默失败 |
| `binaryExtensions` 写错 | 必须是 `extensions` 子集 | 注册单元测试里断言不抛错 |

---

## 9. 决策记录（已定）

1. **csv 保留**，且必须支持超大文件 → 继续走 `text-pages` 流式 + 增量解析，保持
   `priority: 'extension'`（默认用我们的流式表格，工具栏仍可切到内置表格视图）。
2. **媒体并入主包**，不做 `dsh-any-preview-media` 独立包。
3. **播放器以原生 `controls` 为准**；倍速/字幕/播放列表不在本期范围。

面向「未来大量预览类型」的包内架构（内核抽象、目录约定、体积预算、扩展步骤）
已单独成文，见 [architecture.md](./architecture.md)。本文的媒体部分按该架构的
`PreviewModule` 契约实现。


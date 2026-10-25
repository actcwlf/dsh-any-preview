# dsh-any-preview

给 DSH 右侧栏的文件预览加渲染器。**当前实现见下表**；包内按「一个接口 + 一个注册数组」
组织，新增格式只需加一个目录和一行注册。

> ⚠️ **体积**：3D 采用 three.js 全家桶并打进客户端 bundle。构建开启 `minify` 后为
> **约 672 KB 未压缩 / 172 KB gzip**（此前 1.57 MB / 297 KB）。这是「大一统」路线的代价——
> 所有安装者都承担，即使从不打开模型。若要进一步减重，唯一的办法是把 3D 拆成独立包。

## 工程约定

| 约定 | 位置 | 说明 |
|---|---|---|
| 所有上限集中一处 | [`src/shared/limits.ts`](src/shared/limits.ts) | 13 个文件里的 15 个常量统一为命名限额，改一处即可调整 |
| 构建产物压缩 + 带 sourcemap | `tsdown.config.ts` | 堆栈能映射回源码行；`lib/*.js.map` 只用于本地调试 |
| 启动时做契约自检 | `src/client/contracts.ts`、`src/host/self-check.ts` | 上游改名时打印一行诊断，而不是静默地什么都不渲染 |
| 类型检查 | `npm run typecheck` | `strict` + `noUncheckedIndexedAccess`；依赖类型本机缺失，用 `externals.d.ts` 声明 |

## 支持的格式

| 类别 | 后缀 | 能力 |
|---|---|---|
| 表格 | `csv` `tsv` | 增量解析、虚拟滚动、搜索 |
| 差异 | `diff` `patch` | hunk 分类、增删计数、搜索 |
| 日志 | `log` | 级别着色、搜索、尾部跟随 |
| 结构化 | `jsonl` `ndjson` | 字段表格、坏行标出 |
| 媒体 | `mp4/mkv/…` `mp3/wav/…` | 原生播放；桌面版 Blob 兜底；时长/分辨率 |
| 3D | `glb` `gltf` `obj` `stl` | three.js、轨道控制、包围盒取景 |
| 字体 | `ttf` `otf` `woff` `woff2` | FontFace + 字形表 |
| 压缩包 | `zip` `tar` `tar.gz` `tgz` | 中央目录 / 顺序头解析；zip 条目按扩展名复用本插件渲染器，其余可一键解压后在主预览打开 |
| 邮件 | `eml` | 头部、正文、附件名（不提取附件） |
| 电子书 | `epub` | 容器 → OPF 书脊 → 分章渲染；图片转 data URI、书籍 CSS 按白名单作用域化、目录下拉 |
| Notebook | `ipynb` | markdown 单元格渲染；代码单元格与文本/图片/HTML（消毒）/异常输出 |
| reST | `rst` | 标题、列表、字面块、简单表与网格表、脚注、替换定义、`code-block`/`note`/`toctree` |
| 模型权重 | `safetensors` | 头部张量表：dtype、形状、参数量，`__metadata__` 键值 |
| 模型权重 | `gguf` | 版本、架构、量化分布、元数据与张量表（只读头部窗口） |
| 数据库 | `sqlite` `sqlite3` `db` `db3` | **只读结构**：表 / 索引 / 视图 / 触发器及其 CREATE 语句 |

> 最后三行是「元数据检查器」而不是内容渲染：文件可能有几十 GB，所以只读头部（权重）或
> `sqlite_master` 所在的 b-tree 页（数据库），从不整包读取，也从不写入。
> SQLite **不浏览表数据**——那会把它变成一个数据库浏览器，并且要处理溢出页、`WITHOUT ROWID`
> 与 UTF-16 编码，出错方式是静默给出错误数据。

> `.bib`、`.tex`、`.sty`、`.cls` 不接管：它们已由内置 Code 渲染器按 BibTeX / LaTeX 语法高亮。
> EPUB 的 CSS 只保留元素选择器与安全属性（字号/行高/对齐/颜色等），`url()` 与类选择器一律丢弃，
> 因此书籍样式不会污染应用界面；`ipynb` 的 HTML 输出经消毒后渲染（去脚本、事件属性与 `javascript:`）。

zip 条目在面板内直接预览：按扩展名复用本插件的 csv / diff / log / jsonl / 字体 / 邮件渲染器，
不需要落盘。其余类型（图片、PDF、Office、音视频、3D）显示「此类型需解压后用主预览查看」，
可一键解压到压缩包旁的 `.dsh-any-preview/`——路径可改，也支持系统目录选择器。

> 解压目标需位于会话工作区内，否则无法生成可预览的资源地址，只会给出实际路径。
> 解压结果**不会自动删除**：同一条目再次打开会**直接跳到主预览**（不再显示说明面板），
> 列表右上角的「重新解压 <名称>」重写最近打开的那一个，「清理解压」删除该压缩包对应的
> `.dsh-any-preview/`（其他目录名一律拒绝）。
> 顶栏属于各个 tab：跳到系统预览后，路径由预览页自己显示，插件不再另加工具栏。

内置渲染器已覆盖 office / excel / pdf / image / html / markdown / code，本包专注它没覆盖
或不擅长的部分：**流式大文件**、**结构明确却只能看源码的格式**，以及音视频。详见
[架构设计](./docs/architecture.md) 与 [格式规划](./docs/formats-plan.md)。

打开 `.csv` / `.tsv` 时 `priority: 'extension'` 压过内置的纯文本兜底，默认呈现流式表格；
`.diff` / `.patch` / `.log` 内置完全不认领，直接落到本包。

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

## 安装 / 卸载

```sh
cd F:\DSH\workspace\ext_preview
dsh plugin --profile desktop add    ./dsh-any-preview
dsh plugin --profile desktop remove dsh-any-preview
```

`remove` 会同时删掉依赖和 `dsh.profile.bundles` 里的那一层，但 **pnpm 可能留下
`node_modules/<包名>` 的目录链接**，需要手工删掉链接本身（不要 `-Recurse`，否则会连同
源码一起清空）。然后重启应用。

⚠️ 目录名必须和 `package.json` 的 `name` 一致。`dsh plugin add <相对目录>` 走 pnpm，
目录名不一致时 pnpm 会用**目录名**做依赖别名，导致 `cannot resolve profile bundle` 报错。

## 桌面版的媒体播放

桌面版把界面跑在 `dsh-app://app/`，`/api` 请求经 `forwardWebRequest` 转发，而该转发会
移除 `Content-Length`。Chromium 因此把媒体当作「长度未知的流」，`video.seekable` 恒为
`[0, 0]`，进度条拖不动。

实测排除了两个错误猜测：给代理路径回 `206 + Content-Range` **无效**（头确实到达页面——
手动 `fetch` 能看到 `content-range`——但媒体加载器不采用它）；把同一份字节放到
`http://127.0.0.1` 上则正常（`seekable == duration`）。差别在**传输载体**，不在响应头。

因此桌面端走三层阶梯：

1. **回环 HTTP（默认）**：已认证的 `/api` 路由铸造一条**签名 URL**
   （`HMAC(进程密钥, 路径)`，不过期），页面用它作为 `<video src>`。
   - 不设过期：播放会持续发出 Range 请求，任何短 TTL 都会把长视频截断；
   - 签名只对**它命名的那个文件**有效，进程重启即全部失效；
   - 页面在 `dsh-app://` 上，跨站媒体请求带不上会话 cookie（`/api` 实测 401），
     所以 URL 自身就是凭证；路由只回环、只服务媒体后缀、CORS 只授予壳层 origin。
2. **代理 URL + Blob 兜底**：回环不可用（无 `webServer` / 403 / 加载失败）时先退回代理，
   若 `seekable` 仍为空则整段取成 Blob 再播，上限 `MAX_BUFFER_BYTES`（64 MB）。
3. **浏览器直连**不做任何特殊处理——原生就能拖。

`TRUST_CONTENT_LENGTH`（`src/client/previews/media/index.tsx`）是一个**代码开关**：
上游一旦保留 `Content-Length`，改成 `true` 即可让代理路径成为首选、完全绕开回环路由，
其余代码无需改动。Blob 兜底在两种模式下都仍然可用。

根治仍在上游：`apps/desktop/src/web-document.ts` 只应在响应被解码（存在
`Content-Encoding`）时丢弃 `content-length`，未压缩的响应应保留。

## 已知限制

- 只读渲染，不支持编辑或写回
- 表格类预览按格式各自分页/虚拟滚动，行缓冲上限 20 000 行
- 列宽自动，不记忆用户拖拽
- i18n：界面文案已中英双语；解析层内部诊断（ZIP 守卫、邮件头标签等）仍为中文
- 回环媒体路由依赖 `webServer`，缺失该服务的 profile 会退回代理路径（受 Blob 上限约束）
- 加密压缩包、ZIP64、7z / rar 仍未支持
- `.ts` 按源码处理（由内置代码预览接管）：多数 `.ts` 文件是 TypeScript，而渲染器选择只看路径；MPEG-TS 请用 `.m2ts` 或改扩展名


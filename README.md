# dsh-any-preview

给 DSH 右侧栏补充文件预览：内置渲染器没覆盖的格式，以及它不擅长的大型文本文件。

## 支持的格式

| 类别 | 后缀 | 能力 |
|---|---|---|
| 表格 | `csv` `tsv` | 增量解析、虚拟滚动、搜索 |
| 差异 | `diff` `patch` | hunk 分类、增删计数、搜索 |
| 日志 | `log` | 级别着色、搜索、尾部跟随；大文件走文件源、行索引与窗口加载 |
| 结构化 | `jsonl` `ndjson` | 字段表格、坏行标出 |
| 媒体 | `mp4/mkv/…` `mp3/wav/…` | 播放器 + 进度条；桌面版走回环 HTTP，可拖动、大文件不受内存上限约束 |
| 3D | `glb` `gltf` `obj` `stl` | three.js、轨道控制、包围盒取景；Draco/KTX2/meshopt、MTL 与外部资源、环境光、glTF 动画/骨骼、信息条与查看工具 |
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
当前版本固定解压到压缩包旁的 `.dsh-any-preview/<压缩包名>/<条目相对路径>`。

> 当前版本冻结了解压目录：输入框只读、目录选择按钮禁用，避免写出不可被主预览引用的路径。
> 解压目标需位于会话工作区内，否则无法生成可预览的资源地址，只会给出实际路径。
> 解压结果**不会自动删除**：同一条目再次打开会**直接跳到主预览**（不再显示说明面板），
> 列表右上角的「重新解压 <名称>」重写最近打开的那一个，「清理解压」删除该压缩包对应的
> `.dsh-any-preview/<压缩包名>/` 子目录（其他目录一律拒绝）；若清理后
> `.dsh-any-preview/` 已为空，这个父目录也会自动删除。
> 每个压缩包有独立子目录，条目也保留相对路径，因此不同压缩包或同包不同目录的同名文件不会互相覆盖。
> 顶栏属于各个 tab：跳到系统预览后，路径由预览页自己显示，插件不再另加工具栏。

内置渲染器已覆盖 office / excel / pdf / image / html / markdown / code，本包专注它没覆盖
或不擅长的部分：**流式大文件**、**结构明确却只能看源码的格式**，以及音视频。详见
[架构设计](./docs/architecture.md) 与 [格式规划](./docs/formats-plan.md)。

打开 `.csv` / `.tsv` 时 `priority: 'extension'` 压过内置的纯文本兜底，默认呈现流式表格；
`.diff` / `.patch` / `.log` 内置完全不认领，直接落到本包。

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
- 3D：Draco/KTX2/meshopt 的解码器随包分发（构建时从 three 拷贝）；KTX2 依赖 `blob:` Worker，
  极端 CSP 环境会显示本地化解码失败；外部 `.mtl`/贴图不参与自动刷新；
  压缩贴图总量超过 64 MB 会被拒绝，单张最长边超过 4096 或解码总像素超过 32 MP 会在上传前降采样
- 加密压缩包、ZIP64、7z / rar 仍未支持
- `.ts` 按源码处理（由内置代码预览接管）：多数 `.ts` 文件是 TypeScript，而渲染器选择只看路径；MPEG-TS 请用 `.m2ts` 或改扩展名

## 分支

- `master`：正式版本，只接受发布合并
- `dev`：集成分支，日常功能开发以它为基线
- `feature/*`、`fix/*`：从 `dev` 分叉，完成后合并回 `dev`
- 发布：`dev` 验证通过后合并到 `master`

## 文档

面向用户的内容就是上面这些。实现细节在文档里：

- [架构与内部实现](./docs/internals.md)：注册机制、目录结构、大文件策略、懒加载、构建与测试
- [架构设计](./docs/architecture.md)、[格式规划](./docs/formats-plan.md)
- [第三方许可](./licenses/README.md)：随包分发的组件与义务
- [安全边界记录](./docs/security-notes.md)：读不受限、插件 fs 不受沙箱约束（已知问题，暂不修复）

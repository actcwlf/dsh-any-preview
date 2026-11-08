# Changelog

## 0.1.0-test.2 — 2026-11-08

### Fixed

- `preview_inspect` 在打包后的 `lib/index.js` 中按错误层级查找 `lib/lzma.wasm`，导致 7z 的
  `ENOENT .../node_modules/lib/lzma.wasm`；现在同时兼容源码 `src/host/` 和打包后的 `lib/`，
  7z 头部解码恢复正常。
- 新增回归测试，覆盖源码路径和打包后 host 路径都能解析到同一个 wasm。

## 0.1.0-test.1 — 2026-11-08

第一个内部测试版。重点是 CSV / log / JSONL 的大文件浏览、全文搜索和分页导航。

### Added

- CSV A2 搜索：单元格内 occurrence 计数、occurrence 导航、当前 occurrence 强调。
- CSV 全文扫描分页：每 5,000 个 occurrence 一页，支持上一页/下一页、首尾回绕和邻近页缓存。
- log 文件源：大日志使用字节锚点、后台行索引、窗口读取和固定行高比例滚动。
- log 全文行搜索：一行一个结果，支持停止、进度和分页导航。
- JSONL 文件源与窗口表格：小文件内存切片，大文件走文件源；移除 2,000 行硬截断。
- JSONL 记录级全文搜索：原始行匹配、坏行按 raw 参与、新字段自动参与。
- 超过文本模型预算时自动切换文件源；无绝对路径时保留截断提示。
- 搜索分页通用层 `usePagedResults`，CSV / log / JSONL 共用全局 index、页缓存、错误状态和 `goToPage` API。
- 下一页预取；文本路径解析结果缓存。
- 页加载失败状态和防重复翻页保护。

### Changed

- 包管理统一为 pnpm：删除 `package-lock.json`，提交 `pnpm-lock.yaml` 和
  `pnpm-workspace.yaml`；pnpm store 固定在项目内 `.pnpm-store`。
- `packageManager` 固定为 `pnpm@11.28.5`，Node `>=20.9.0`。
- `sharp` 未被运行时代码引用，从 `dependencies` 移到 `devDependencies`；用户安装不再下载原生 sharp。
- log / JSONL 的共享扫描和固定行高滚动移入 kernel：
  `useLineScan`、`useFixedRowScroll`、`useLineFileSource`。
- RowFile 的全文/分页扫描统一到共享 slice walker。
- README 更新大文件、分页和搜索能力边界。
- `docs/security-notes.md` 更新 `preview_inspect` 当前的工作区路径限制与剩余风险。

### Fixed

- 大文件在文本模型截断后仍停留在前 20,000 行的空档。
- JSONL 小文件仍被 2,000 行显示上限截断。
- 搜索分页在 5,000 个结果后无法继续导航。
- 页尾/页首加载、加载失败和快速重复翻页的状态问题。
- 最终页/首尾回绕需要重新从文件头扫描的问题。

### Testing

- `pnpm typecheck`
- `pnpm build`
- `pnpm test`：436 个测试通过。
- 大文件 DOM / archive 测试依赖本地 `samples/`；该目录不提交，缺失时测试会跳过并显示原因。

### Known limitations

- JSONL 只有 raw 记录级搜索，没有字段查询（如 `level=error`）。
- JSONL 表格列按前 200 条记录采样固定，后续新字段只在 raw 搜索中出现。
- diff / patch 仍没有全文搜索和游标分页。
- 大文件窗口模式禁用「仅匹配」。
- `goToPage` 只有 API，没有页码输入 UI。
- 文本路径分页会缓存解析后的完整行/记录；超大文本仍受文本模型上限约束。
- 无绝对路径的大文件无法切换文件源，仍会显示截断提示。
- 用户正则仍可能触发灾难性回溯。

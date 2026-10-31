# 交接：CSV 大文件窗口化渲染

> 分支 `feature/csv-stream-search`，共 6 个提交，238 项测试全绿。
> 剩余工作只有一步：把已有的窗口模块接进 `src/client/previews/csv/index.tsx`。

## 1. 背景与目标

CSV 预览当前的两个限制：

| 限制 | 现状 | 目标 |
|---|---|---|
| 行数 | `LIMITS.csvRows = 20_000`，超出截断 | 去掉上限，改为**窗口缓存**上限 |
| 内存 | 文档层累积全文，行数组是唯一闸门 | 索引 + 窗口，与文件大小解耦 |
| 搜索 | 只搜已加载的 2 万行 | ✅ 已改为全文切片扫描（带进度与终止） |

用户确认的产品决策：

| 决策 | 取值 |
|---|---|
| 索引建立时机 | **空闲时后台推进**，同时支持按需前进 |
| 拖动后加载延迟 | **200 ms** |
| 精确/估算切换 | 索引完成后**不立即**改；**下一次超过可感知距离（约 3 屏）的拖动**才落到精确位置 |
| 窗口大小 | 5,000 行 |
| 缓存 | LRU，常驻上限 160,000 行 |
| 滚动条 | 索引完成后按真实行数比例；超过约 76 万行改用缩放滚动条（浏览器元素高度上限约 1677 万像素） |

## 2. 已完成（分支上的 6 个提交）

| 提交 | 内容 | 位置 |
|---|---|---|
| `bd2e200` | 全文切片扫描：256 KB 分片、跨片 `lastIndex`、进度回调、`AbortSignal` | `src/client/kernel/search-scan.ts` |
| `2b5ab4a` | 稀疏行索引：每 N 行一个锚点、引号感知、密度估算 | `src/client/kernel/csv-index.ts` |
| `8045b7d` | 按锚点读窗口：`anchorBefore` → 跳过 → 解析切片 | `src/client/kernel/csv-window.ts` |
| `cc9992b` | 窗口算术：`planWindow` / `placeholderRows` / `cacheCapacity` | `src/client/kernel/csv-window-state.ts` |
| `ea856a7` | 延迟读窗口的 hook：T1 占位、T2 静止后读、代次令牌、LRU | `src/client/kernel/useWindowedRows.ts` |
| `5675cb6` | CSV 渲染安全网测试 | `test/render.test.mjs` |

另外，CSV 预览已接入：

- **单行上限** `LIMITS.csvLineChars = 8 MB`（`23fba90`，master）：超长行停止解析，状态行提示；
- **大文件搜索**：>2 MB 时状态行显示 `全文扫描 N% · 已匹配 M`，工具栏有「终止扫描」。

## 3. 现有 API（接线时直接用）

```ts
// csv-index.ts
const index = createCsvIndex(10_000)   // stride 行
index.push(text)                        // 传「累积文本」，只扫描新增后缀
index.anchors / index.rows / index.scanned
index.anchorBefore(row) / index.estimateRows(totalChars)

// csv-window.ts
readWindow(text, index, fromRow, count, delimiter): { startRow, rows }

// csv-window-state.ts
planWindow(scrollTop, viewportHeight, rowHeight, windowSize, totalRows, overscan)
  → { start, count, window, alignedStart }
placeholderRows(count) / cacheCapacity(windowSize)

// useWindowedRows.ts
useWindowedRows({ text, index, delimiter, scrollTop, viewportHeight, totalRows, rowHeight,
                  windowSize?, settleMs? }): { startRow, rows, loading }
```

## 4. 剩余工作：接线（预计 40 行改动）

文件：`src/client/previews/csv/index.tsx`（当前约 300 行）。

现状要点：

- 解析：渲染期用 `bufferRef` + `createRowBuffer` 增量解析，`view.body` 是不含表头的行数组；
- 虚拟滚动：`windowRange(...)` 得到 `first/last`，`windowIndices.map(...)` 渲染，首尾用空 `<tr>` 占位；
- 过滤：`visibleIndices` 为 `filter` 时的行子集；
- 搜索：`useSearch(texts, options)` 基于 `view.body` 的字符串。

接线步骤：

1. **索引**：新增 `indexRef`，渲染期增量 `indexRef.current.push(text)`（与 `bufferRef` 同模式）；
2. **判定**：`const windowed = source.kind === 'text' && text.length > LARGE_TEXT_CHARS`（已存在该常量，2 MB）；
3. **调 hook**（必须无条件调用，遵守 hooks 规则；非 windowed 时传 `index: null`，hook 会原样返回占位而不读）；
4. **行来源**：`const rows = windowed ? window.rows : view.body`；
5. **行号**：windowed 时 `window.startRow + i`；注意窗口 **row 0 是表头**，当 `startRow === 0` 时首行需跳过（`view.body` 不含表头）；
6. **占位行高度**：首部高度 `(windowed ? window.startRow : first) * ROW_HEIGHT`；尾部用 `totalRows - (startRow + rows.length)`；
7. **总行数**：`totalRows = index 完成 ? index.rows : Math.max(view.body.length + 1, index.estimateRows(text.length))`；
8. **精确/估算切换**：记录"上次精确化时的滚动位置"，仅当本次滚动位移 > 3 × viewportHeight 时，用精确值替换估算值；
9. **过滤与窗口的交互**：windowed 模式下**先不要支持 filter**（保持搜索高亮即可），或过滤时回退到非窗口模式——两者都要写注释说明；
10. **删除 20,000 上限**：接线完成且验证通过后，把 `MAX_ROWS` 改为只用于非窗口模式的兜底，并更新 `csv.truncated` 文案语义。

## 5. 必须验证的点

| 场景 | 期望 |
|---|---|
| 小文件（< 2 MB） | 行为与现在完全一致（安全网测试 `5675cb6` 覆盖） |
| 22 MB `samples/huge.csv` | 首屏快速出现；拖动时占位行不跳动；静止 200 ms 后内容出现 |
| 滚到第 20 万行 | 行号正确、列对齐、表头固定 |
| 快速拖动 | 不发起窗口读取（debounce 生效），停止后只读最终窗口 |
| 往回拖 | 命中 LRU，无读取延迟 |
| 越过 76 万行 | 滚动条按比例，位置可到文件末尾 |

## 6. 已知坑（本轮踩过）

| 坑 | 说明 |
|---|---|
| **`continue` 跳过偏移自增** | `csv-index.ts` 的扫描循环里 `offset += 1` 放在 `continue` 之后，导致所有引号内字符不计偏移，锚点全错。已修复：用字符索引本身作为偏移 |
| **`rows` 含表头** | `index.rows` 与窗口行都包含 header（row 0），而 `view.body` 不含。接线时必须减 1 |
| **Windows 行尾解析不同** | 窗口切片后再解析，^\r 处理依赖 `createRowParser`，不要在接线时另写解析 |
| **hooks 顺序** | `useWindowedRows` 必须无条件调用，不能用 `if (large)` 包裹 |
| **PowerShell 补丁** | 本项目历史上有大量"`.Replace` 未命中但静默通过类型检查"的事故。改完必须 `grep` 确认目标文本存在，再跑 `tsc` + 全量测试 |

## 7. 命令

```powershell
cd F:\DSH\workspace\ext_preview\dsh-any-preview
node D:\DSH\deepseek-harness\node_modules\typescript\bin\tsc --noEmit
node --test --test-isolation=none "test/*.test.mjs"
node "D:\DSH\deepseek-harness\node_modules\tsdown\dist\run.mjs"
```

client-only 改动刷新页面即可；**Host 改动需重启桌面版**；工具列表改动需新会话。

## 8. 分支与合并

```powershell
git switch feature/csv-stream-search
git log --oneline master..HEAD
```

6 个提交均已通过全量测试。接线完成、`huge.csv` 验证通过后再合并回 master。

## 9. 相关但独立的事项

- `samples/huge.csv`（21.8 MB，300,001 行）是本地验证夹具，**未提交**；需要时用 `tmp-7z/gen-csv.mjs` 重新生成；
- 7z 相关能力（BCJ/BCJ2/流式解压）已在 master，与本分支无关；
- `docs/internals.md` 已有"预览外壳""7z""压缩包 UI"三节，CSV 窗口化完成后建议补一节。

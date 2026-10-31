# 交接：CSV 大文件窗口化渲染

> 分支 `feature/csv-stream-search`。窗口模块 6 个提交 + **接线（§10）** + **文件源（§12）**；
> 全量测试 274 项全绿，其中新增 jsdom 挂载测试（含 22 MB `huge.csv` 夹具）与文本切片路由测试。

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

## 3. API（接线后的实际形态）

```ts
// csv-index.ts
const index = createCsvIndex(10_000)   // stride 行
index.push(text)                        // 传「累积文本」，只扫描新增后缀
index.anchors / index.rows / index.scanned
index.anchorBefore(row) / index.estimateRows(totalChars)

// csv-window.ts
readWindow(text, index, fromRow, count, delimiter, maxLineChars?)
  → { startRow, rows, overlong }

// csv-window-state.ts
planWindow(scrollTop, viewportHeight, rowHeight, windowSize, totalRows, overscan)
  → { start, count, window, alignedStart }   // count = 整个窗口 + 下沿带
windowedBodyRows(read, startRow, totalRows, slice, rowHeight, loading, columns)
  → { rows, topPad, bottomPad }              // 画 slice 这一段，算出上下撑高
scaledRowHeight(rows, rowHeight, limitPx, minHeight) / cacheCapacity(windowSize)

// useWindowedRows.ts
useWindowedRows({ text, index, delimiter, scrollTop, viewportHeight, totalRows, rowHeight,
                  windowSize?, settleMs?, maxLineChars? })
  → { startRow, rows, loading, overlong }    // loading 时 rows 为空，由调用方画占位
```

## 4. 接线（已完成，实际差异见 §10）

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

## 5. 验证结果（已完成，明细见 §10）

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

接线已完成、`huge.csv` 验证通过（§10），可以合并回 master。

## 9. 相关但独立的事项

- `samples/huge.csv`（22.8 MB，300,001 行）是本地验证夹具，**未提交**；需要时用 `tmp-7z/gen-csv.mjs` 重新生成。
  `test/csv-window-dom.test.mjs` 在文件存在时会跑第 20 万行的用例，否则跳过（`DSH_HUGE_CSV` 可指定别的路径）；
- 7z 相关能力（BCJ/BCJ2/流式解压）已在 master，与本分支无关；
- `docs/internals.md` 已补「CSV 窗口化」一节。

## 10. 接线完成（本次）

### 改了哪些文件

| 文件 | 改动 |
|---|---|
| `previews/csv/index.tsx` | 索引累积、窗口化判定、调 hook、按文件行号画行、上下撑高、共享一套渲染 |
| `kernel/csv-window-state.ts` | `planWindow` 修正覆盖范围；新增 `windowedBodyRows`、`scaledRowHeight` |
| `kernel/csv-window.ts` | 末尾无换行的最后一行算一行；可选行宽上限；返回 `overlong` |
| `kernel/useWindowedRows.ts` | 文本变长时缓存失效；读窗口带行宽上限；加载态不再生成 5 000 个占位数组 |
| `kernel/csv-index.ts` | `scanned` 之前返回永远为 0 的 `offset`，改为已消费的字符数 |
| `kernel/SearchBar.tsx` | 新增 `filterable?`，窗口化时隐藏「仅匹配」 |
| `test/*` | 新增/扩充 `csv-index`、`csv-window`、`csv-window-state`、`render`、`csv-window-dom` |
| `docs/internals.md` | 新增「CSV 窗口化」 |

### 与 §4 的差异（都是刻意的）

1. **判定不只按 2 MB**：`text.length > 2MB || buffer.truncated`。行缓冲被行数上限截断时也是
   "大文件"，否则 1.9 MB / 10 万行的文件仍会被 20 000 行上限截断——那正是要取消的限制。
2. **不实现 §4.8 的「精确/估算切换」**：`index.push()` 同步扫描每一页，所以
   `estimateRows(text.length)` 对已到文本**已经是精确值**；EOF 时唯一的差别是末行没有换行符
   时的 +1 行。没有"估算 → 精确"的跳变，就无需等 3 屏拖动再切换。若将来把索引改成空闲增量扫描，
   这段规则要按原样补回来（`index.tsx` 里留了注释）。
3. **窗口化时不支持过滤**（保留搜索高亮），并直接隐藏「仅匹配」控件。
4. **一次读整个窗口 + 下沿带**：原 `planWindow` 按视口大小给 `count`，而缓存以窗口号为键，
   于是"短窗口"被缓存后，在同一窗口内滚动会是一片空白（§5 的"拖动后内容出现"根本过不了）。
   现在 `count = 窗口大小 + 视口行数 + overscan`，缓存命中即可覆盖整个窗口。
5. **只画视口那一屏**：窗口是读/缓存单位，DOM 仍只有约 40 个 `<tr>`；`placeholderRows` 因此删除。

### 验证结果（`test/csv-window-dom.test.mjs`，真实 DOM 挂载）

| 场景 | 结果 |
|---|---|
| 小文件（3 行） | 首帧即出行，不过窗口路径，过滤控件仍在 |
| 12 万行 | 首帧只有表头 + 占位；200 ms 后出行；拖动时立刻退回占位；拖回来命中缓存立即出内容 |
| 行号 | body 行 `i` 显示 `i+1`，表头不重复出现 |
| 撑高 | 上撑高 + 所画行 + 下撑高 = `(总行数-1) × 行高`（12 万行 / 30 万行都验过） |
| 22.8 MB `huge.csv` | 摘要 300,000 行；跳到第 20 万行后显示 `200001`、`user_200001`；总高 6 600 000 px |

未验的部分（需要真浏览器）：滚动条外观、>76 万行时行高缩放的观感、拖动手感。
`scaledRowHeight` 只有单测覆盖。

### 翻页机制（重要，之前没写进文档）

插件正文拿不到 `loadPage`，翻页靠 owner：`TextPreview` 在 `.body` 上挂 `onScrollCapture`，
当**自定义滚动容器**（`scrollportRef`）滚到底时请求下一页。所以：

- 表格高度必须精确等于已加载行数 × 行高（§「撑高」那条），否则滚不到底、翻不了页；
- 每加载一页 5 000 行，滚动条变长，用户要再拖到底才会加载下一页；
- 页面仍只在需要时加载，不会因为窗口化就一次性把 22 MB 读进内存。

## 11. 尚未做（可选项）

- `LIMITS.csvRows` 仍叫"行数上限"，现在只是缓冲预算；改名要同步 `internals.md`；
- 深搜在文本变长时会重头扫描（`text.length` 是依赖），翻页 + 搜索同时进行会反复重置进度；
- 文件重新加载（`reload`）时 `consumedRef` / 索引按"只增不减"处理，依赖 owner 卸载组件来复位。

## 12. 第二阶段：文件源（按位置跳转）

第一阶段的窗口仍以 owner 交付的文本为源，所以"第 20 万行"要先把前面的页都加载出来。按讨论确认的
设计改成**按文件大小估总行数、按估计偏移取数、索引完成后修正**：

| 部分 | 实现 |
|---|---|
| Host 路由 | `GET /api/any-preview/text?path&offset&length&rowStart` → `{ text, start, end, size, eof }`，按字节找行边界再解码（不切断多字节字符）；路径校验抽到 `host/file-target.ts`，与媒体路由共用 |
| 文件源 | `kernel/csv-file.ts`：`openCsvFile`（首片 + 三处密度采样）→ `advance()`（后台逐片走完）→ `read(row, count)`（已索引走锚点，否则按密度估偏移） |
| 行号 | 索引覆盖到的窗口精确；没覆盖的标 `~`；改成精确不需要等拖动 |
| 总行数 | 开档即按 `文件字节 ÷ 平均行密度` 估；索引完成后**不立即**换，超过约 3 屏的拖动才换（§1 的产品规则） |
| 探测 | 先用 `Range: bytes=0-0` 取大小；≤2 MB 保持纯文本路径（首屏零等待） |
| 搜索 | 文件源在时 `scanCsvFile` 按切片扫整份文件，进度/终止交互不变 |

### 验证（同一套 jsdom 挂载，假 Host 复用 `alignTextSlice`）

| 场景 | 结果 |
|---|---|
| 22 MB 夹具，只交付第一页 | 估算 301 356 行（实际 300 001，+0.45%）；一次拖到第 20 万行，落在 `user_200552`（−0.28%） |
| 拖到估算的底部 | 显示文件真正的最后一行 `user_300000`，不是尾切片的开头 |
| 后台走完 + 一次 3 屏拖动 | 摘要变 `300,000 行`；第 20 万行行号不带 `~`、内容精确 |
| 没有绝对路径 / 路由不可用 | 自动回落文本路径（小文件、测试、无 webServer 的 profile 都走这条） |
| 12 万行文件 | 首屏即出首窗（hook 的首窗不再等 200 ms，拖动才开始去抖） |

### 已知取舍

- 文件模式下 owner 仍会在表格滚到底时按自己的规则加载下一页（每次一页），那段文本我们不使用，
  但它会留在 store 里；不绑定 `scrollportRef` 可以避免，代价是分页记忆丢失，暂不改；
- 估算偏移依赖整份文件的行长均匀度；夹具上误差 0.3%，表格列宽变化剧烈的文件会更大，索引走完后
  行号与总量仍会精确；
- 切片扫描是行对齐的，跨行书写的正则（如包含 `\n` 的模式）在切片边界处可能漏一处，行内模式不受影响。

## 13. 修一个只有真机能撞见的 bug：打开大文件后整表变空白

真机现象：打开 `huge.csv` 先闪出几行，然后整张表变空白，只有表头，**不滚动就再也不出内容**。

### 原因（用假 Host + 真实时间线跑出来的）

1. 打开时先走文本路径（owner 交来第一页 5 000 行）——这就是那一下"闪烁"；
2. 探测到 22 MB 后切到文件源，缓存被换源清空，表格改画占位；
3. 后台索引每读 1 MB 就 `setFileState({revision: n})`，而**当时把 `revision` 直接喂给了窗口缓存**：
   每片都清缓存 → 表格退回占位；
4. `useWindowedRows` 当时是「武装 effect + 读取 effect」两个 effect 共享一个 `settled` 计数器：
   读完 `settled` 归 0，而**缓存刚被同一批渲染清空时武装 effect 不会重跑**（它的依赖没变化），
   `settled` 永远留在 0 → 读取 effect 每次都早退 → **再也不发请求**；
5. 于是索引期间每次清缓存都是一次空白，最后停在空白上；用户一拖滚动条，`scrollTop` 变化又
   重新武装，才会突然恢复。

跟踪日志（修复前，真机同构的假 Host）：

```
[diag] read? en=true cached=false settled=1 ... rev=1
[diag] done ... rows=5074            ← 第一窗读到
[diag] read? en=true cached=false settled=0 ... rev=2   ← 清缓存后 settled 已是 0
[diag] read? ... settled=0 ... rev=3                    ← 之后再没开始过读取
...（rev 到 22 全是 settled=0，没有一次 done）
```

### 修法

- `useWindowedRows` 改成**一个调度 effect**：缓存为空立即读、非空（拖动中换窗口）等 200 ms；
  读完 bump 一次状态把缓存画出来。失败不写状态，因此不会自旋，下一次滚动/换源/换编号再试。
- `lastRead` 记住上一帧画出的窗口：同一窗口被失效重读时继续画旧行，不再闪一下。
- **失效条件收窄到真正变的东西**：文本路径用 `text.length`；文件路径只在索引**走完**时清一次
  （行没变、编号没变就没有理由清）。进度照样每片更新，只是不再牵动缓存。
- 文件源读失败（路由没了、文件变了）→ `setFileState(FAILED_FILE)` 落回文本路径，而不是留一张空表。
- 窗口读还没回来、但 owner 已经交来的文本里有这几行时，先用文本行填上：打开大文件不再有空帧。

### 回归测试

`test/csv-window-dom.test.mjs` 的「the table never goes blank while the file is being indexed」：
慢速后台索引（20 ms 一片）期间每 20 ms 采样一次 `tr[data-row-index]`，**首行出现之后不允许再出现 0 行**。




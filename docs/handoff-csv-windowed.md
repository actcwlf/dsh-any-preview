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

- 本地验证夹具（都在 `F:\DSH\workspace\ext_preview\samples\`，**未提交**），用
  `node tmp-7z/gen-csv.mjs <rows> <path>` 生成（默认 300 000 行 → `samples/huge.csv`）：

  | 文件 | 规模 | 用来验 |
  |---|---|---|
  | `huge.csv` | 22.8 MB / 300 000 行 | 普通大文件，精确逐行定位（<727 000 行） |
  | `huge-1m.csv` | 73.4 MB / 1 000 000 行 | 比例滚动条（内容位移 ≈ 1.4× 滚动位移） |
  | `huge-2m.csv` | 150 MB / 2 000 000 行 | 比例滚动条（≈ 2.6×），索引约 4 s |

  三份的最底部都核对过：行号 `300000`/`1000000`/`2000000`，内容就是文件最后一行；
  2M 那份的滚动内容高度正好 16 777 216 px（浏览器元素高度上限）。
  `test/csv-window-dom.test.mjs` 在 `samples/huge.csv` 存在时会跑第 20 万行的用例，否则跳过
  （`DSH_HUGE_CSV` 可指定别的路径）；
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

## 14. 超过约 727 000 行：比例滚动条（不再压缩行）

2 000 000 行 × 22 px = 44M px，超过浏览器 16 777 216 px 的滚动内容上限。第一版的做法是把行距压到
`上限 ÷ 行数`（2M 行 → 8.39 px），结果是"样式变了"：字被裁、行号与滚动位置对不上。**现在的做法是
行距恒为 22 px，让滚动条变成比例的**：

- 滚动内容是一个固定 16 777 216 px 的 spacer，`logical = 滚动比例 × (总行数 − 视口行数)`；
- 表格 `position: sticky` 钉在视口顶部，`<tbody>` 用 `translateY(-(整数行×22 + 小数行×22))` 对齐，
  所以拖动时内容连续移动，速度是滚动位移的 `22 / pitch` 倍（2M 行约 2.6×、1M 行约 1.4×）；
- 行号仍然精确、跳转仍然精确、末尾仍然可达；内容高度是常量，估错总行数也顶不破上限；
- 为什么不能"压缩行距 + 22 px 行"混着来：滚动内容的空间是 `行数 × pitch`，而画出来的行是 22 px，
  每个窗口的起点都会和上一窗口的终点重叠，窗口一换就整屏跳；两者必须是同一个 pitch。

无头 Chromium 实测（2 000 000 行、500 px 视口、内容 16 000 000 px、行 22 px）：

| 位置 | 期望 | 实测 |
|---|---|---|
| 中段 | 顶端行 = 999,989 | 999,989 ✓ |
| 底部 | 最后绘制的行 = 1,999,998、表头仍在 y=0 | ✓（上一版这里会被 sticky 夹住，表头被顶走） |
| 横向 | `scrollLeft=120` 时行号列不动 | x=1 ✓（tbody 被 transform 后 `sticky left` 仍生效） |
| 表头层级 | 行从表头下方滑过 | 截图确认无重叠 |

真机夹具（150 MB / 2 000 000 行，索引走完后拖一次）：

```
行样式      height 22px · line-height 20px · font 12px          ← 与普通文件完全一致
spacer      16,777,216 px
50%         第 999,976 行 → user_999977（无 ~ 前缀）
滚到底      2,000,000 / user_2000000（文件最后一行）
```

代价（已确认接受）：滚动"变快"，内容位移是拇指位移的 `22 / pitch` 倍；owner 记住的滚动位置
（像素）在总行数变化后只能当比例用，切回 tab 时落点会比以前粗。

### 之前那版为什么必须改

- 行距被压到 8.39 px，而 `<tr>` 的 `height` 是下限（浏览器取「行框 + 边框」）→ 实测排出 11 px，
  行号与滚动位置差 31%；字号还得跟着缩到 7 px；
- 6 px 行距下限意味着 ~280 万行以上内容超上限、末尾拖不到；比例滚动条没有这个问题（内容高度是
  常量）；
- 顺带删掉了"首帧先按 22 px 画一帧再压扁"的 loading 特判——行距不再变化，就没有可闪的东西。


## 15. 大文件搜索：命中的行要能跳过去

现象：大文件"全文扫描完成 · 共 N 处匹配"了，上/下箭头却点不动，或者点了不动。原因是两条线
只接了一半：

1. **导航原来只走内存里的前 20 000 行**（`useSearch` 的命中表），而文件源下 owner 只交了第一页
   （5 000 行）。命中在第 100 000 行时，内存里根本没有这个命中 → 箭头禁用。全文扫描只回了
   一个**总数**，没有回**位置**。
2. **就算知道行号也读不准**：后台索引还没走到那一行时，读窗口按"行号 × 平均行密度"估字节偏移，
   ≈0.3–2 % 的误差意味着"第 100 000 行"的内容可能是第 102 760 行。

修法（两条一起，缺一条都不够）：

- 扫描**返回命中行**：`scanText` / `CsvFile.scan` 在数匹配的同时记下每个命中所在的行（默认前
  5 000 个，总数仍完整）。跳转后箭头在扫描结果里循环；命中过多时状态行写
  "共 {count} 处匹配（可跳转前 {shown} 处）"。
- 扫描**顺手留锚点**：它本来就是从头按切片顺序读整个文件，所以每片起点记一个 `{行, 字节}`
  （`file.scan` 里 `scanAnchors`，与索引的锚点并列，取"≤ 目标行的最大者"）。于是"跳到第 150
  万行的命中"在索引没走到时**也是精确的**，行号不带 `~`。扫描是 1 MB 一片、片间让出事件循环，
  150 MB 约 6 s，带进度和"终止扫描"。
- 比例模式下跳转要**按行**取半屏：`(行 − 视口行数/2) × pitch`。按像素取 `clientHeight/2` 在
  那里是 43 行而不是 16 行，会把命中推到屏幕下面（实测：命中行不在绘制带里）。

真机验证（150 MB / 2 000 000 行，`requestIdleCallback` 关掉 = 后台索引一行没走）：

```
搜索 user_1500000      → 全文扫描完成 · 共 1 处匹配
点"下一个匹配"          → 绘制带 1,499,974 .. 1,500,022
命中行 1,499,999        → 行号 1500000（无 ~）· 内容 user_1500000     ✓
```

### 15.1 全扫改成"按需、从当前位置、边扫边出、可中断"

上面的扫描仍是"一按就全扫 150 MB、扫完才给结果"，而且每敲一个字符都会重开一次。按"定位优先"
的模型改成：

- **显式触发**：打字只搜内存里已加载的行（`useSearch`，瞬时）；**回车**（`SearchBar` 新增
  `onSubmit`）或工具条的"全文查找"才开始扫全文件。回车在有命中之后就是"下一个"，和编辑器一致。
- **从读者所在的行起扫，回绕一圈**：`file.scan({ from })` 用最近的锚点定位起点（没有锚点就退回
  0），走到文件尾再从 0 扫到起点，所以"总数"仍然是整份文件的。实测（2M 行、已索引、视口在
  1 300 000）：回车后第一批切片是 **96/97/98/99 MB**，不是 0 MB——起点确实是读者那一行。
- **逐片发布**：每扫完一片就把"已找到几处 + 命中行"交给界面（`onSlice`），第一个命中立刻可跳，
  不必等最后一片。状态行在扫描期间写"全文扫描 x% · 已找到 N 处"，扫完才定格成"共 N 处"。
- **可中断**：扫描期间工具条显示"终止扫描"；点它只中止请求，**已找到的命中保留且仍可跳转**，
  状态行变成"已停止扫描 · 已找到 N 处"。改查询会丢弃旧查询的命中（否则高亮和跳转会对不上）。
- 扫描仍是 1 MB 一片、片间让出事件循环；文本路径（非文件源）从头扫（数据已在内存里），同样逐片
  发布。

DOM 用例覆盖这三点：打字后**不得**出现"全文扫描"、回车后才开始、扫描中能点到"终止扫描"且状态
变成"已停止扫描"。

### 15.2 顺带修了测试夹具的坑

`react-dom` 必须在 jsdom 全局就位**之后**才 require，否则它在导入时把 `canUseDOM` 定为 false，
React 的**委托**事件（input/click）永远不触发——只有挂在元素上的 scroll 能用。之前没有测试点过
按钮或按过回车，所以一直没暴露；现在"输入查询 → 回车 → 点箭头 → 点终止"都是真被测到的。


## 16. 架构整理：拆开那个 749 行的组件

做格式通用化之前先梳理了一遍（问题清单见讨论记录），落地的是这几项：

### 16.1 修一个交互死锁：比例模式下"有命中就滚不动"

```
800 000 行（比例模式）→ 搜到第 400 000 行：揭示到 8 388 227
手动滚到 90%（应为 15 098 846）→ 实际仍停在 8 388 227，绘制带仍在 399 975..400 023
```

根因：`geometry` 每帧新建对象，而揭示效果把它当依赖 → 效果每帧重跑 → 任何重渲染都把
`scrollTop` 写回命中行。精确模式（≤727 000 行）里 `geometry` 恒为 `undefined`，所以之前的
用例没撞上。修法：`geometry` 用 `useMemo`（依赖 `windowed / bodyRows / rowHeight / scrollLimit /
viewportHeight`），并把揭示挪进 `scroll.ts` 的 `reveal()`，`index.tsx` 只在 `activeRow` 变化时调它。

回归用例「an active search hit does not pin the view in the proportional mode」：搜到命中 →
滚到 90% → 断言绘制带跟到 600 000 之后、且不再停在命中行。**故意去掉 `useMemo` 验证过它会失败**
（painted 399 980），所以这条用例是有效的。

### 16.2 拆成四块（行为不变，12 条 DOM 用例全绿）

| 文件 | 职责 | 状态 |
|---|---|---|
| `previews/csv/source.ts` | 文本缓冲 + 字符索引 + 分隔符 + 文件打开/后台建索引 + 读一窗 + 扫描 | `fileState` + 4 个 ref |
| `previews/csv/scroll.ts` | 滚动位置、总行数（拖 3 屏才换精确值）、`geometry`（memo）、`currentRow`、`reveal` | 2 个 state |
| `previews/csv/scan.ts` | 全文搜索状态机：显式触发 / 从当前行起扫 / 逐片发布 / 停止 / 并入箭头导航 | 3 个 state |
| `previews/csv/table.tsx` | 只画 DOM：滚动容器、钉住窗口、表头、行号、高亮 | 无 |
| `previews/csv/index.tsx` | 组合 + 过滤 + 状态行（749 → 约 300 行） | 2 个 state |

对外契约：`CsvSource`（行从哪来）、`RowScroll`（视口与几何）、`WholeFileScan`（扫描 + 导航）。
这三份都是纯函数式的钩子，只有需要浏览器的部分（measure、scroll）才碰 DOM。

### 16.3 收掉重复与死代码

- 新增 `kernel/lines.ts` 的 `countNewlines` / `countRows` / `skipLines`，`csv-file.ts` 不再自带
  一份；`search-scan.ts` 的 `LineCounter` 保留（它额外算"命中的行号"）。
- 删除从未被调用的 `csv-index.rowOffsetsIn`（只有它自己的测试在用）及其测试。
- 删掉 `fileState` 的惰性初值：没有任何地方读 `opening`，那段注释还在解释"行距会被压缩"（行距
  已恒为 22 px）。`OPENING_FILE` 常量保留（打开时确实会置这个状态）。
- `csv/window.ts` 顶部"以后把 text 换成 ranged read"的注释改成现在时。

### 16.4 这一轮又做了四件（原清单 1/2/3/5）

1. **两台状态机收进 reducer**（`previews/csv/state.ts`）：`fileState(state, event)` 与
   `scanState(state, event)` 是纯函数，事件是 `open / ready / fail` 与 `clear / start / slice /
   done / stop`。`useReducer` 只负责把它们接到组件里。单测（`test/csv-state.test.mjs`）覆盖了
   "ready 之前先失败就不会被迟到的切片救活""命中的行号要减 1 且丢掉表头""停止后命中仍可跳转"
   这些之前只能靠 DOM 集成测试才碰得到的规则。
2. **改名 + 参数化**：`csv-file.ts` → **`row-file.ts`**，`openCsvFile(path, delimiter)` →
   `openRowFile(path, { parse })`——切片怎么变成行由调用方给（CSV 传
   `previews/csv/parse.ts` 的 `parseCsvSlice`，log 将来传"一行一格"），文件源本身只认换行；
   `csv-window-state.ts` → **`window-state.ts`**（它本来就与列无关）。文件名与测试文件一起改
   （`test/window-state.test.mjs`）。
3. **行号换算收口**：新增 `kernel/row-numbering.ts`（`toFileRow` / `toBodyRow` /
   `isHeaderRow`），`bandRows`、扫描的 `line → row`、`~` 标签、扫描起点全部改用它。
4. **后台建索引的进度节流**：每片只更新一次状态 → 改成"每 2 % 或完成时"才 dispatch，
   150 MB 文件的整组件渲染从 150 次降到约 50 次。

### 16.5 表头高度进几何（本轮）

比例模式的 `visibleRows` 原来是 `viewportHeight / rowHeight`，把 27 px 的表头也算进了"能放多少行"，
于是 100 % 时最后一屏低了一行：最后一行被表头压掉一截（720 px 视口：`27 + 32 × 22 = 731 > 720`）。

修法：`proportionalGeometry(..., headerHeight)` 用 `viewportHeight - headerHeight` 算 `visibleRows`
（720 px → 31 行），表格常量收进 `previews/csv/layout.ts`（`ROW_HEIGHT` / `HEADER_HEIGHT` /
`SCROLL_LIMIT_PX` / `OVERSCAN` / `WINDOW_ROWS` / `SETTLE_MS`），body、scroll、view 共用一份。

无头 Chromium 实测真实表头：**26.5 px**（行 22 px ✓），常量取 27 更保守——`27 + 31 × 22 = 709 ≤ 720`
成立，`27 + 32 × 22 = 731 > 720` 不成立。单测 `the header is not part of the row area` 钉住了这两条。

### 16.6 还留着的

1. **文本路径的 `csv-index` / `csv-window` 仍是 CSV 专用**（引号感知的跳过）；log 走"一行一格"
   时不需要引号，但两个函数目前把引号写死。等真的移植 log 时再加 `quoted` 参数比现在预埋更稳；
2. **格式移植本身**（log → jsonl → diff），见上一轮讨论的方案：壳已经抽好，每个格式只需
   换 `parse`、`renderRow` 和表头。


## 17. `preview_inspect` 对 150 MB 的 CSV 说什么

改之前它只读前 1 MB：能报列名、分隔符、用前 20 行推的类型、前 50 行里的列数不齐，**行数一个字都没有**，
还因为"只读了 1 MB"把 `truncated` 置成 true。对一个 150 MB 的表，这描述的是"它的开头"，不是"它"。

现在读 1 MB 头 + 三个 32 KB 窗口（1/3、2/3、5/6）+ 末尾 1 KB，从整份文件回答：

```
delimited text · 8 columns · delimiter "," · ~2,032,730 rows
  size: 150.00 MB (157,283,875 bytes)
  rows: ~2,032,730 (est. from the head + 3 windows, 72–81 bytes/row)
  columns: 8
  delimiter: "," (same in all 4 windows)
  line endings: LF · ends with a newline
  encoding: UTF-8
  header: id | name | city | amount | status | created_at | note | tag
  id: integer · (1, 2) · ascending in samples
  amount: number · (0.13, 0.26) · also integer (68) in samples
  created_at: date · (2026-02-02, 2026-03-03)
! only the first 1 MB was parsed; the row count and row length come from the head and 3 sampled windows
! row length varies 1.12× across the file: an offset in bytes infers row numbers to ±12%
→ 在面板里打开：按行随机访问，不必读全文件（精确行数在索引完成后可见）
→ grep(pattern="…") 扫描整份文件；read 只适合小片段
```

设计上的几条取舍：

- **行数只给估算，不给假误差**：estimate 本身是"头 + 3 窗口"的密度平均（这份文件 **+1.6 %**，
  与面板报的同一个数，因为两边现在共用 `shared/inspect/density.ts`）；窗口间的 **1.12×** 是
  "字节位置 ↔ 行号"的误差（note），不是行数的误差，所以不写进 summary 的 `±`。
- **表头要"确认"而不是"假定"**：数据列是数字/布尔、第 0 行同列是文本 → 确认；两者同型 →
  `header: none detected — the first row looks like data`；全文本列没法判断 → `(assumed; …)`。
- **类型跨窗口**：头里是 `boolean`、样本里出现 `N/A` → `also string (N/A) in samples`。这正是
  "前 20 行推 dtype"最容易翻车的地方。顺带加了 `date`（`2026-02-02` 读成日期比读成字符串有用）。
- **`truncated` 语义改正**：只表示 schema 被截到 20 列，不再表示"只读了 1 MB"。
- **不做事**：列统计（min/max/distinct）、更多样本行——inspect 的价值在"便宜且稳定"，精确定稿
  归面板（打开后后台建索引，行号与总行数都会变精确）。

跨窗口的方言检查也修掉了一个隐患：拼接出来的 CSV 可能在中途换成分号，旧实现只看第一行。






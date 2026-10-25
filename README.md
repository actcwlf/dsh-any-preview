# dsh-any-preview

给 DSH 右侧栏的文件预览加渲染器。**当前只实现了 CSV / TSV 表格**，包名与扩展点结构按
「通用文件预览器」来命名，后续可以按同样的模式挂载更多格式。

官方内置的 `text` 预览把 CSV 当纯文本显示；本插件通过公开扩展点登记一个新的渲染器，
`priority: 'extension'` 会压过内置的纯文本兜底，打开 `.csv` / `.tsv` 时默认呈现表格，
同时仍可在预览工具栏切回纯文本。

## 结构

```
dsh-any-preview/
├── package.json        # dsh.client（浏览器半）+ dsh.bundle（组合包层）
├── cordis.patch.yml    # insert 一行插件到 profile
├── tsdown.config.ts    # 双产物构建：lib/index.js（host）+ lib/client.js（browser）
├── sample.csv          # 测试用样例
├── src/index.ts        # host 半：空实现，只为让 Loader 有 entry
└── src/client/
    ├── index.ts        # 登记 documentPreviews 元数据 + keyed slot 组件
    ├── CsvBody.tsx     # 表格组件（表头吸顶、行号、分页加载）
    └── parse.ts        # 分隔符探测 + RFC 4180 解析（引号、转义、跨行）
```

## 两个注册点

```ts
ctx.documentPreviews.register({
  id: 'dsh-any-preview',
  extensions: ['csv', 'tsv'],
  priority: 'extension',      // 压过内置 builtin
  title: () => 'CSV 表格',
  loading: 'text-pages',      // owner 按行分页喂文本
})

ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
  { name: 'sidebar.right.tab.document', key: 'dsh-any-preview' },
  CsvBody,
))
```

渲染器只消费 `content`（`{ kind: 'text', text, eof }`），不碰 Sidebar 的 store、pane
或布局——所以它会自动出现在文件树、会话里的文件链接、以及 `read` 工具行打开的同一个
`text` tab 里。

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

## 已知限制

- 只读渲染，不支持编辑或写回
- 分页按行数（默认 500，可点按钮继续加载），不是虚拟滚动；超大文件请配合内置分页
- 列宽自动，不记忆用户拖拽

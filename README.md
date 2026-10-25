# dsh-any-preview

给 DSH 右侧栏的文件预览加渲染器。**当前实现了 CSV / TSV 表格**；包内按「一个接口 +
一个注册数组」组织，新增格式只需加一个目录和一行注册。

内置渲染器已覆盖 office / excel / pdf / image / html / markdown / code，本包专注它没覆盖
或不擅长的部分：**流式大文件**，以及后续的音视频等重格式。详见
[架构设计](./docs/architecture.md) 与 [媒体规划](./docs/media-preview.plan.md)。

打开 `.csv` / `.tsv` 时，`priority: 'extension'` 压过内置的纯文本兜底，默认呈现流式表格；
工具栏仍可切回内置的纯文本或表格视图。

## 结构

```
dsh-any-preview/
├── package.json         # dsh.client（浏览器半）+ dsh.bundle（组合包层）
├── cordis.patch.yml     # insert 一行插件到 profile
├── tsdown.config.ts     # 双产物构建：lib/index.js（host）+ lib/client.js（browser）
├── sample.csv           # 测试用样例
├── test/                # node --test：分块性质测试 + SSR 渲染测试
├── src/index.ts         # host 半：空实现（媒体路由在 P1 加入）
└── src/client/
    ├── index.ts         # 遍历 PREVIEWS 统一注册，逐模块 try/catch
    ├── kernel/
    │   ├── types.ts         # PreviewModule / DocumentContent / PreviewBodyProps
    │   ├── source.ts        # 三种 content 模式 → 统一 PreviewSource
    │   └── text-pipeline.ts # 增量行解析 + 有界行缓冲
    └── previews/
        ├── index.ts     # ★ PREVIEWS 数组：唯一的注册清单
        └── csv/
            ├── index.tsx  # 模块声明 + 表格主体
            └── detect.ts  # 分隔符探测
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

`text-pages` 是**累积**文本，每来一页只解析新增的后缀（`kernel/text-pipeline.ts`），
避免整段重解析的 O(n²)；行缓冲有上限（默认 20 000 行），到顶后停止累积并提示「已截断」。
虚拟滚动与按需切片在 P3 补上。

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
- `test/render.test.mjs`：按浏览器方式加载 `lib/client.js`，用真实 React 做 SSR，
  校验注册元数据与表格输出

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

## 已知限制

- 只读渲染，不支持编辑或写回
- 分页渲染（默认 500 行/页），尚未做到虚拟滚动；行缓冲上限 20 000 行
- 列宽自动，不记忆用户拖拽
- 未做 i18n，标题为中文常量

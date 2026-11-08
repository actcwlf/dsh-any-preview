# 安全边界记录（暂不修复）

记录日期：2026-10-27，2026-11-08 更新。这些主要是**平台层**的事实；本仓库只在
`preview_inspect` 工具内部做有限缓解。

## 1. 文件沙箱只约束写，不约束读

当前会话策略是 `workspace-write`。实测结论：

| 操作 | 结果 |
|---|---|
| `read` / `pwsh` 读工作区外文件（如 `C:\Users\<user>\.dsh\profiles\desktop\cordis.yml`） | ✅ 成功 |
| `pwsh` 写工作区外文件（同目录 `package.json`） | ❌ 被拒（`sandbox: file access denied`） |
| 写 `D:\DSH\deepseek-harness\*.mjs` | ❌ 被拒 |

即：**读不受限（整台机器，受 OS 用户权限约束），写仅限会话工作区**。审批策略（`ask`）不针对"读"触发。

含义：任何读取能力——包括模型自己读到的内容——都具备把工作区内外的文件送入模型上下文的可能。

## 2. 插件 Host 代码完全绕过该边界

`ctx.fs` 不是沙箱接口，而是"宿主路径 → 资源地址"的便利封装：

- `ctx.fs.processPathFromHostPath(absolutePath)` 把 Host 路径映射成资源地址；
- `ctx.fs.resolve` + `readByteRange` 直接按 App 进程权限读文件；
- 插件代码可以绕过 `preview_inspect`，直接调用 `ctx.fs` 读取任意文件。

`preview_inspect` 当前会拒绝 `processPathFromHostPath` 返回 `undefined` 的绝对路径；
这限制的是**这个工具**，不是插件的 Host 权限。

也就是说：**安装插件 = 授予其代码以用户身份读全部文件**。文件沙箱保护的是"模型通过工具能做什么"，保护不了"插件代码自己做什么"。

## 3. 插件工具的执行未观察到审批

本次注册的 `preview_inspect` 在会话中直接执行，未弹出审批。结合第 2 点，意味着：模型可以借插件工具读任意文件，而工具自身是唯一的边界。

## 4. 当前仓库内的缓解

`src/host/inspect-tool.ts` 当前做了这些限制：

- 绝对路径必须通过 `ctx.fs.processPathFromHostPath`；映射失败直接报
  `path is outside the workspace`；
- 相对路径优先按 `sandboxPolicy.resolve(...).workspaceRoot` 解析；
- 读取有 10 秒 AbortSignal 超时；
- 各格式头部读取有上限（例如文本/二进制 4 MB），归档成员也有大小上限；
- 输出字段、列表和坏行数量都有界。

**仍然存在的边界**：

- `realpath` / symlink escape 没有单独测试；路径映射成功不代表目标真实路径仍在工作区内；
- 拿不到 `sandboxPolicy` 时，相对路径会退回 `ctx.fs.resolve` 的服务默认目录，而不是默认拒绝；
- 工具之外的插件 Host 代码仍可直接使用 `ctx.fs` 读任意文件。

因此这里只是**降低误用面**，不是完整的工作区沙箱。

## 5. 将来可选的处理方向

| 方向 | 归属 | 说明 |
|---|---|---|
| 工具内自建边界 | 本仓库 | `realpath` + 工作区根比较 + 默认拒绝；有测试覆盖 |
| 平台提供"按会话裁剪的 fs 句柄" | 上游 | 根治：插件拿到的手柄本身就该受限 |
| 可配置的读策略（如 `workspace-read`） | 上游 | 让"读"也能被策略约束 |
| 插件安装时的能力声明 | 上游 | 类似权限清单，安装时明示"可读全部文件" |

在上述任一落地前，**不要把"读不受限"当成可控风险**：它需要用户在授权 agent 与安装插件时知情。
# 未来自有解码 wasm 的基建

这里**没有**任何 7z 代码。这个目录只是为"将来自己构建一个只做解码的 wasm"
预留位置与契约，避免届时重新设计交付方式。

## 为什么不是整包 7z wasm

现有 `7z-wasm` / `libarchive.js` 都把压缩包整个复制进 wasm 的虚拟文件系统
（MEMFS）再执行命令行。7z 格式本身支持随机读取（尾部 32 字节指针 + 头部目录 +
按 `PackInfo` 精确取段），真正无法回避的只有 **solid 块**：最小解码单位是一个块。

因此目标形态是：

```
JS（有 Range、能异步）              wasm（同步、纯计算）
  读尾部 32 字节 → Start Header
  读 Next Header → 条目 / 文件夹 / PackInfo
  只取需要的那几段字节  ──────►   LZMA/LZMA2 解码（+ BCJ 过滤）
        ◄──────────────────────  输出缓冲区
```

wasm **没有文件系统、没有 I/O**：它只接收"已经取好的字节"。内存峰值因此是
"一个块 + 输出缓冲"，而不是整个压缩包。

## 交付通道（已就绪）

- 产物放在 `lib/<name>.wasm`，并加入 `package.json` 的 `files`；
- Host 只服务 `src/shared/assets.ts` 白名单里的名字（`lzma.wasm` 已列名），
  通过回环路由 `/any-preview/asset/<name>` 提供，`Content-Type: application/wasm`；
- 客户端用 `kernel/assets.ts` 的 `loadWasm(name, imports)` 取用：
  优先 `instantiateStreaming`，MIME 不对时退回 `arrayBuffer` + `instantiate`；
- 文件不存在 → 404 → `loadWasm` 抛错 → 调用方关闭该能力，不影响其它格式。

## 模块契约

导出名固定为 `dsh_any_preview_lzma`（多实例无副作用），至少提供：

| 导出 | 说明 |
|---|---|
| `memory` | 导出的线性内存 |
| `alloc(size) -> ptr` | 分配输入/输出缓冲 |
| `free(ptr)` | 释放 |
| `decode(filtersPtr, filtersLen, inPtr, inLen, outPtr, outCap) -> written` | 解码一个块；返回写入字节数，负数表示错误码 |
| `last_error() -> ptr` | 可选：错误文本 |

错误码至少区分：数据损坏、需要密码、输出缓冲不足。

## 构建

```sh
# 需要 emscripten；本仓库当前不包含工具链
node scripts/build-wasm.mjs        # 打印契约与建议的命令，未安装时直接退出
```

建议命令（LZMA SDK 单文件解码器）：

```sh
emcc lzma/C/LzmaDec.c -O3 -flto \
  -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_alloc,_free,_decode,_last_error \
  -Wl,--no-entry -o lib/lzma.wasm
```

产物体积预期：**200–400 KB**（只含解码器，不含打包/命令行/文件系统）。

## 许可证

本仓库随包分发的第三方代码与候选组件的许可说明，统一放在 `licenses/`；
引入解码器时请先阅读 `licenses/README.md` 的流程。

- 若基于 LZMA SDK：公有领域（7-Zip 的 LZMA SDK 明确 public domain）；
- 若基于 libarchive：BSD-2-Clause；
- **不要**直接把 LGPL 的 `7zz` 整体编译进来——那会把分发义务带进插件。

## 启用步骤（届时）

1. 构建出 `lib/lzma.wasm`；
2. 在 `src/shared/assets.ts` 已有 `lzma.wasm` 一项，无需改动；
3. 客户端调用 `loadWasm('lzma.wasm')`，实现 7z 目录解析 + 按块解码；
4. 加一条测试：`loadWasm` 在 404 时抛出，能力关闭。

## 实现现状（本仓库已构建）

`lib/lzma.wasm` 已存在，**16.6 KB**，由 `node scripts/build-wasm.mjs` 生成：

```
clang --target=wasm32-unknown-unknown -nostdlib -O3 -I wasm/include -I wasm/lzma -c …
wasm-ld --no-entry --export-memory --initial-memory=134217728 --max-memory=402653184 …
```

**不使用 emscripten 运行时**，原因有两条：

1. 体积——emscripten 版本 200–400 KB，freestanding 版本 16.6 KB；
2. 工程——emcc 在 Windows 上跨盘（emsdk 在 D:、仓库在 F:）会抛
   `ValueError: path is on mount 'D:'`，且其临时目录在沙箱内无法写入。

### 实际导出（与上文契约的差异）

| 导出 | 说明 |
|---|---|
| `memory` | 线性内存 |
| `malloc(size)` / `free(ptr)` | **自带的 bump 分配器**（96 MB 静态 arena），`free` 是空操作 |
| `reset_heap()` | 把分配器指针归零；一次解码结束后调用即可复用内存 |
| `lzma_decode(props, propsLen, in, inLen, out, outCap)` | LZMA1；返回写入字节数，`-1` 分配失败、`-2` 数据损坏 |
| `lzma2_decode(props, propsLen, in, inLen, out, outCap)` | LZMA2（`props` 为 1 字节字典码） |
| `crc32_buf(data, len)` | IEEE CRC32，用于校验条目 |

`wasm/include/` 提供三个最小头文件（`stdlib.h`、`string.h`、`errno.h`），
`wasm/shim.c` 提供 `memcpy`/`memset`/`memmove`/`memcmp` 与分配器。

### 已验证

`test/wasm-decode.test.mjs`（3 项，未构建时自动跳过）：

- 导出齐全；
- 用 Python `lzma` 生成的 raw LZMA1 夹具（`test/fixtures/lzma1.json`）解码后与原文逐字节一致；
- 篡改一个字节后返回负错误码，而不是错误数据。
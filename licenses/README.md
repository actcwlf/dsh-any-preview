# 许可证说明

这个目录保存**随插件分发**的第三方代码的许可与说明。它的作用是：

1. 用户与下游能一处查到"这个包里有哪些第三方代码、各自什么许可、我们承担什么义务"；
2. 将来引入解码 wasm（LZMA SDK / libarchive / unRAR）时，有确定的落位与模板，不必临时补。

## 当前随包分发的第三方代码

| 组件 | 位置 | 许可 | 义务 | 说明 |
|---|---|---|---|---|
| three.js | `lib/three-chunk.js` | MIT | 保留版权与许可声明 | 3D 预览，懒加载 chunk |
| Draco（glTF 构建） | `lib/draco_wasm_wrapper.js`、`lib/draco_decoder.wasm` | Apache-2.0 | 附许可全文与来源声明，见 `draco.md` | glTF 压缩网格解码 |
| Basis Universal | `lib/basis_transcoder.js`、`lib/basis_transcoder.wasm` | Apache-2.0 | 附许可全文与来源声明，见 `basis-universal.md` | KTX2/Basis 贴图转码 |
| meshoptimizer | `lib/model-extras-chunk.js` | MIT | 保留版权与许可声明，见 `meshoptimizer.md` | meshopt 压缩解码 |
| mux.js | `lib/mux-chunk.js` | Apache-2.0 | 附许可全文（第 4 条） | TS/M2TS 重封装，懒加载 chunk |
| React / `@deepseek-ai/*` | 不随包分发 | — | — | 由 DSH 平台提供（模块表外部依赖） |

Draco 与 Basis Universal 同属 Apache-2.0，全文统一放在 `apache-2.0.txt`（逐字同步），
两个组件的说明文件引用它。

其余代码为本项目自有。

## 计划中（尚未包含）

| 组件 | 计划用途 | 许可性质 | 结论 |
|---|---|---|---|
| LZMA SDK 解码器（`LzmaDec.c` 等） | 7z 块解码 | **公有领域** | 无义务，见 `lzma-sdk.md` |
| libarchive（RAR5 reader） | RAR 只读解压 | BSD-2-Clause | 保留声明，见 `libarchive.md` |
| unRAR | RAR 解压（备选） | 带使用限制（非自由） | 仅解压可用、需声明，见 `unrar.md` |

## 新增一个第三方组件的流程

1. 在本目录新建 `<组件>.md`，写清：来源、版本、许可类型、我们承担的义务、以及**许可证全文或官方链接**；
2. 若该许可证要求保留声明，把**逐字原文**放进该文件，不要改写；
3. 更新上表的"当前随包分发"部分；
4. 若代码进入 `lib/`，确认 `package.json` 的 `files` 已包含本目录；
5. 若许可证非自由（如 unRAR），在 `NOTICE.md` 与 README 的已知限制里同时标注。

## 规则

- **不复述、不概括有法律效力的条款**：摘要可以写，但原文必须逐字保留；
- 只包含"真的随包分发"的代码；开发期依赖（emscripten、tsdown、TypeScript）不进入本目录，但可在 `README.md` 注明；
- 第三方代码的许可证**不得**比本项目更严格地限制下游使用——若出现冲突（例如非自由许可），必须在 `NOTICE.md` 明示，并重新评估是否引入。

# 第三方声明（NOTICE）

本插件随包分发以下第三方代码。

## three.js

- 版本：见 `package.json` 的 `devDependencies`
- 位置：`lib/three-chunk.js`（懒加载的 3D chunk）
- 许可：MIT（`licenses/three.md`）
- 义务：保留版权声明与许可全文

## Draco（glTF 构建）

- 版本：three@0.180.0 内置（`examples/jsm/libs/draco/gltf/`）
- 位置：`lib/draco_wasm_wrapper.js`、`lib/draco_decoder.wasm`（构建时原样拷贝）
- 许可：Apache-2.0（`licenses/apache-2.0.txt`、`licenses/draco.md`）
- 用途：`KHR_draco_mesh_compression` 网格解码
- 义务：随分发附许可全文与来源声明

## Basis Universal

- 版本：three@0.180.0 内置（`examples/jsm/libs/basis/`）
- 位置：`lib/basis_transcoder.js`、`lib/basis_transcoder.wasm`（构建时原样拷贝）
- 许可：Apache-2.0（`licenses/apache-2.0.txt`、`licenses/basis-universal.md`）
- 用途：`KHR_texture_basisu`（KTX2/Basis）贴图转码
- 义务：随分发附许可全文与来源声明

## meshoptimizer

- 版本：0.22（three@0.180.0 内置的 `meshopt_decoder.module.js`）
- 位置：`lib/model-extras-chunk.js`（懒加载的 ESM）
- 许可：MIT（`licenses/meshoptimizer.md`）
- 用途：`EXT_meshopt_compression` 解码
- 义务：保留版权声明与许可全文

## mux.js

- 版本：见 `package.json` 的 `devDependencies`（构建期依赖）
- 位置：`lib/mux-chunk.js`（懒加载的 ESM）
- 许可：Apache-2.0（`licenses/mux-js.md`）
- 用途：把 MPEG-TS 重封装为 fMP4，供 MediaSource 播放；不含转码
- 义务：随分发附许可全文

## 其余

React 与 `@deepseek-ai/*` 由 DSH 平台在运行时提供，不随本包分发。

---

新增第三方代码时，请同时更新本文件与 `README.md` 的表格，并按 `README.md` 的流程补充对应的 `<组件>.md`。

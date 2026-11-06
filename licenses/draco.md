# Draco (glTF)

- 上游：https://github.com/google/draco
- 许可：Apache-2.0；全文见 `licenses/apache-2.0.txt`（逐字同步自 Apache 官方文本）
- 版本：three@0.180.0 内置的 glTF 构建（`examples/jsm/libs/draco/gltf/`）
- 分发形式：`lib/draco_wasm_wrapper.js`、`lib/draco_decoder.wasm`
  —— 构建时由 `scripts/sync-decoders.mjs` 从 `node_modules/three/...` 拷贝，未修改上游文件
- 用途：解码 `KHR_draco_mesh_compression` 压缩的 glTF 网格；只在模型声明该扩展时按需下载
- 载体：`lib/model-extras-chunk.js` 中的 `DRACOLoader`

## 义务

Apache-2.0 第 4 条要求随二进制品分发时附许可全文，并保留来源声明。本项目未修改
Draco 源码/二进制，仅原样分发 three.js 内置的构建，因此沿用上游的版权与许可信息。

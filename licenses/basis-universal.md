# Basis Universal

- 上游：https://github.com/BinomialLLC/basis_universal
- 许可：Apache-2.0；全文见 `licenses/apache-2.0.txt`（逐字同步自 Apache 官方文本）
- 版本：three@0.180.0 内置的转码器（`examples/jsm/libs/basis/`）
- 分发形式：`lib/basis_transcoder.js`、`lib/basis_transcoder.wasm`
  —— 构建时由 `scripts/sync-decoders.mjs` 从 `node_modules/three/...` 拷贝，未修改上游文件
- 用途：把 `KHR_texture_basisu`（KTX2/Basis）贴图转码成 GPU 可直接采样的格式；
  只在模型声明该扩展时按需下载
- 载体：`lib/model-extras-chunk.js` 中的 `KTX2Loader`

## 义务

Apache-2.0 第 4 条要求随二进制品分发时附许可全文，并保留来源声明。本项目未修改
Basis Universal 源码/二进制，仅原样分发 three.js 内置的转码器。

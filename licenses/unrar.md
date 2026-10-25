# unRAR（备选，尚未随包分发）

- 上游：https://www.rarlab.com/rar_add.htm（unRAR 源码）
- 许可：**带使用限制的源码许可（非自由）**，不是 OSI 认可的开源许可
- 备选用途：RAR 解压（RAR4/RAR5、多卷、加密）

## 许可证允许什么

| 行为 | 是否允许 |
|---|---|
| 用 unRAR 代码解压 RAR | ✅ 允许 |
| 修改后随软件分发 | ✅ 允许（需保留声明） |
| 用于实现 RAR 压缩 | ❌ 禁止 |
| 用于开发 RAR 兼容压缩器 | ❌ 禁止 |

## 我们承担的额外义务

1. 必须在**文档与源码注释**中写明：本代码不得用于开发 RAR（WinRAR）兼容的压缩器；
2. 分发时保留原始许可全文；
3. 由于该许可**非自由**，必须在 `NOTICE.md` 中明示本包含有非自由许可组件；
4. 若本项目对外声明为 MIT，需说明这是"MITT + 非自由组件"的组合，且不得删除该限制。

## 必须随包保留的声明（逐字）

```
The unRAR sources may be used in any software to handle RAR archives
without limitations free of charge, but cannot be used to re-create the
RAR (WinRAR) compression algorithm, which is proprietary. Distribution
of modified unRAR sources in separate form or as a part of other
software is permitted, provided that it is clearly stated in the
documentation and source comments that the code may not be used to
develop a RAR (WinRAR) compatible archiver.
```

> 引入前必须从上游 `LICENSE` 逐字核对。

## 引入前的判断清单

- [ ] 是否真的需要 RAR？若只是"顺带支持"，优先评估 `libarchive.md`（BSD）；
- [ ] 是否只做解压？本项目不做压缩，符合限制；
- [ ] `NOTICE.md` 是否已标注非自由组件；
- [ ] README 的已知限制是否说明"仅解压、不压缩"；
- [ ] 是否接受由此带来的发行政策摩擦（部分企业/发行版禁止非自由组件）。

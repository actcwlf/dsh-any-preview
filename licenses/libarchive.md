# libarchive（候选，尚未随包分发）

- 上游：https://github.com/libarchive/libarchive
- 许可：**BSD-2-Clause**
- 候选用途：RAR5 只读解压（其 RAR5 reader 为独立实现），或作为 7z/zip 的统一后端

## 为什么它是候选

- BSD-2 与本项目许可兼容，不引入使用限制；
- 比 unRAR 的许可更干净，企业/发行版政策通常接受；
- 代价：体积较大，裁剪到"只保留需要的 reader"需要改构建。

## 义务

保留版权声明、许可条件与免责声明（逐字）。

## 许可全文

```
Copyright (c) 2003-2025, The libarchive project
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR(S) ``AS IS'' AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE AUTHOR(S) BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

> 引入前必须从上游仓库的 `COPYING` 逐字核对，不要沿用本文件的排版。

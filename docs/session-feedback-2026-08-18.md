# dsh-headroom 干扰开发流程的会话反馈文档

- **日期**：2026-08-18
- **会话**：测试手机与电脑消息互通（im:feishu:oc_94a93d8c496b0b364f03904daa848a26:1786984757588）
- **headroom 版本**：dsh-headroom v0.2.0（lib/kompress.js 等）
- **用途**：记录 headroom 在真实开发会话中对工具输出/数据读取/编辑链路的干扰现象、触发条件与影响，供后续优化。

---

## 1. 问题概述

在本次 im-gateway 双向链路修复会话中，dsh-headroom 对**工具结果展示层**进行了大量压缩折叠（log-fold / kompress / search-fold / text-head/tail）。虽然 headroom 的本意是节省上下文，但它对**文件读取类工具**（read / str_replace_editor / pwsh / node 输出）的压缩导致模型看到的文件内容与磁盘真实内容不一致，进而引发编辑工具状态异常、反复重试、被迫使用 base64 绕过等效率损失，并存在误改文件的风险。

---

## 2. 具体现象与证据

### 2.1 read 工具输出被折叠，导致 edit 工具判定文件已变化

- 多次 `read F:\tmp\dsh-im-gateway\lib\channels\feishu.js` 时，输出被 headroom 压缩为无运算符版本（`const appId config.appId process.env...` 丢掉了 `= ??` 等符号）。
- 随即调用 `edit` 修改该文件时报错：
  - `Error: cannot edit "...feishu.js": file changed since it was read — re-read the file, then retry`
  - 重读后仍报 `edit requires reading "...gateway.js" first`
- 结果：`edit` 工具无法可靠工作，最终改用 `write` 重写整个文件或 `str_replace_editor` 才绕过。

**关键危害**：headroom 折叠改变了 read 工具返回的内容，但磁盘文件未变。edit 工具基于"read 后的文件快照"做一致性校验，折叠后的展示内容与磁盘真实内容不一致，导致工具链状态错乱。

### 2.2 pwsh / node 输出被压缩

- `pwsh Get-Content ... -Raw` 输出 feishu.js 时出现乱码 + headroom 压缩混合，无法直接使用。
- 用 `node -e "console.log(fs.readFileSync(...))"` 打印文件内容时，输出被 headroom 折叠（`[headroom: log-fold 3332→1983 chars]`、`[headroom: text-head/tail 4229→2435 chars]`），关键行被省略。
- 用 `node -e "...JSON.stringify(line)"` 逐行输出也被压缩（`[headroom: kompress 3504→2028 chars]`）。
- 最终只能通过 `Buffer.from(content).toString('base64')` 再单独解码的方式获取原文，流程繁琐。

### 2.3 grep / Select-String 搜索结果被折叠，干扰定位

- 搜索 `question|提问` 时，headroom 的 search-fold 把结果折叠，返回的行与实际搜索意图不完全对应（如返回大量 session/event 行，真正的 question/requested 被淹没或折叠）。
- 搜索日志时 `[headroom: search-fold 2048→1730 chars]`，需要再用 node 精确 grep 才能确认关键帧是否存在。

### 2.4 str_replace_editor 的 view 输出也被折叠

- `str_replace_editor view` 显示 gateway.js 时同样丢失运算符/括号（`if (this.channels.has(channel.id))` 显示为 `(this.channels.has(channel.id))`）。
- 导致无法通过 view 直观核对代码结构，只能靠 base64 解码确认。

### 2.5 折叠标记本身干扰上下文

- 大量 `[headroom: ...]` 标记出现在工具结果中，占用上下文并造成视觉噪音，例如：
  - `[headroom: log-fold 27673→5499 chars; retrieve full original with headroom_retrieve(id="hr:...")]`
  - `[headroom: kompress 8385→6719 chars; ...]`
  - `[headroom: search-fold 2160→1656 chars; ...]`

---

## 3. 触发条件

| 触发条件 | 说明 |
|---|---|
| 读取较大文件（数百行以上） | gateway.js（953 行）、api-proxy.ts（3744 行）等被 log-fold/kompress |
| 工具输出超过 headroom 阈值 | read 整个文件、pwsh 输出长文本、node 打印多行、grep 多结果 |
| 文件包含大量运算符/符号 | JS/TS 源码最容易触发 kompress 词级压缩，丢失符号 |
| 搜索返回大量行 | search-fold 折叠后难以确认真实匹配 |
| read 后立即 edit | headroom 导致 read 快照与磁盘不一致，edit 校验失败 |

---

## 4. 影响评估

### 4.1 开发效率
- **反复重试**：同一文件需 read → edit → 报错 → base64 解码 → 绕过，多次往返。
- **工具替代**：被迫用 write 重写整个文件（有覆盖风险）、用 str_replace_editor、用 base64 手工解码，增加出错面。
- **调试成本**：定位 mux 帧问题时，日志被 search-fold 干扰，需额外写 node 精确 grep。

### 4.2 数据读取准确性
- headroom 折叠后的内容**不是磁盘原文**，若模型误以为折叠内容即原文，可能写出错误 old_string / new_string，导致：
  - edit 替换失败；
  - 更严重时 write 覆盖文件造成内容丢失（本次通过 write 重写 feishu.js 时依赖 base64 原文核对，风险高）。

### 4.3 工具链状态一致性
- read/edit 的"读取后文件快照"机制与 headroom 展示层折叠冲突，是本次最直接的 bug 级干扰。

### 4.4 上下文占用
- 折叠标记与折叠逻辑本身消耗 token；绕过流程（base64 双份内容）反而增加上下文占用，与 headroom 初衷相悖。

---

## 5. 优化建议（供 dsh-headroom 后续版本参考）

### 5.1 明确分层：展示层折叠 ≠ 文件内容层折叠
- headroom 应只对"模型上下文展示"做压缩，**不得改变 read / edit / str_replace_editor 等文件工具返回给模型的内容语义**。
- 若必须折叠 read 输出，应保证 edit 工具的 old_string 匹配仍基于磁盘原文，且 read 快照一致。

### 5.2 提供按需取原文的明确通道
- 现有 `headroom_retrieve(id=...)` 可恢复原文，但流程不透明、需手动。
- 建议：read 折叠时在结果中明确标注"已折叠，请调用 headroom_retrieve 获取原文"；编辑类工具（edit/str_replace）应自动使用磁盘原文，不受展示折叠影响。

### 5.3 对代码/配置文件禁用或降级压缩
- JS/TS 等符号密集内容应避免词级 kompress（丢符号不可接受）。
- 建议对 `*.js`、`*.ts`、`*.json`、`*.yml` 等文件默认不做符号级压缩，或只做行折叠（保留每行完整内容）。

### 5.4 搜索/日志折叠保留定位性
- search-fold 应保证返回的每条匹配行完整可读，至少保留行号与关键匹配上下文；不要将真正匹配项淹没在折叠后的相邻行中。

### 5.5 增加开关与白名单
- 提供用户/会话级开关：`headroom.disableForFileTools`、`headroom.noFoldForPatterns`（如 `*.js`、`*.ts`、`*.json`）。
- 提供 `headroom.verbose` 关闭折叠标记噪音。

### 5.6 修复 edit 一致性校验的兼容
- 若 headroom 必须在 read 展示层折叠，应让 edit 工具的"已读快照"基于磁盘原文而非展示内容，避免 `file changed since it was read` 误报。

---

## 6. 本次会话实际绕过方式（临时）

1. **base64 解码**：`node -e "console.log(Buffer.from(fs.readFileSync(f,'utf8')).toString('base64'))"` → 再解码，获取精确原文。
2. **str_replace_editor**：对 headroom 折叠免疫较好的编辑工具，但仍需 base64 确认 old_str。
3. **node --check**：改完文件后做语法校验，降低覆盖风险。
4. **精确 node grep**：写脚本过滤日志，绕过 search-fold。

这些方式虽可行，但不应成为常态。

---

## 7. 结论

dsh-headroom 在当前版本对**文件读取与编辑工具链**存在实质性干扰，主要表现为展示层折叠导致 read/edit 状态不一致、源码符号丢失、搜索定位困难。建议优先修复"文件工具内容层不受展示折叠影响"与"编辑工具一致性校验兼容"两项，其次优化搜索折叠与配置开关。

---

## 8. 压缩效率与压缩质量评估（本次会话实测数据）

### 8.1 压缩效率统计

从本次会话工具结果中收集的 headroom 折叠标记（chars 原始→压缩后），按策略分类：

| 策略 | 原始→压缩 | 压缩率 | 出现场景 |
|---|---|---|---|
| log-fold | 27673→5499 | 80.1% | dev_plugin_status 插件清单 |
| log-fold | 18463→7427 | 59.8% | fetch/client.ts 读取 |
| log-fold | 6433→3931 | 38.9% | gateway.js 段落 |
| log-fold | 4418→4192 | 5.1% | gateway.js handleSessionEvent |
| kompress | 8385→6719 | 19.9% | api-proxy.ts 读取 |
| kompress | 5980→3723 | 37.7% | router.js 读取 |
| kompress | 4648→3930 | 15.4% | gateway.js handleSessionEvent |
| kompress | 3504→2028 | 42.1% | node 打印 feishu.js |
| kompress | 3451→2192 | 36.5% | feishu.js 读取 |
| kompress | 2538→2180 | 14.1% | package.json 读取 |
| kompress | 1419→1055 | 25.7% | api-proxy provider 段 |
| search-fold | 2776→1908 | 31.3% | 日志搜索 question |
| search-fold | 2160→1656 | 23.3% | 日志搜索 question |
| search-fold | 2048→1730 | 15.5% | 日志 tail |
| search-fold | 1227→973 | 20.7% | 日志 tail |
| text-head/tail | 6017→2435 | 59.5% | node 输出 handleSessionEvent |
| text-head/tail | 4229→2435 | 42.4% | node 输出 feishu.js |
| text-head/tail | 3985→2435 | 38.9% | 搜索句柄 |

**总体判断**：
- 字符压缩率大多落在 **15%–45%**，对超长日志/清单可达 **60%–80%**。
- 作为"上下文压缩器"，字符层面效率尚可；但**省下的字符是否真正等价于省 token / 省推理成本**，需结合质量损失评估（见下）。

### 8.2 压缩质量评估

| 内容类型 | 质量 | 说明 |
|---|---|---|
| 长日志/状态清单（dev_plugin_status、gateway.log tail） | ✅ 可接受 | 冗余高，折叠后仍能提取关键信息 |
| 大段 README/文档文本 | ✅ 基本可接受 | 语义保留尚可 |
| **JS/TS 源码（read / str_replace_editor view / node 打印）** | ❌ **不可接受** | kompress 词级压缩丢失运算符（`=`、`??`、`=>`、括号等），折叠内容与磁盘原文不一致，直接破坏 read→edit 工具链 |
| JSON/YAML 配置文件 | ❌ 不可接受 | 结构化符号丢失会导致模型误解结构 |
| 搜索/日志定位输出 | ⚠️ 中低 | search-fold 常把真正匹配项淹没在折叠相邻行中，需二次精确 grep |
| base64 绕过输出 | ⚠️ 中 | text-head/tail 截断仍影响大段输出 |

**质量损失的核心问题**：
1. **不可逆**：词级 kompress 丢弃了运算符，模型无法从折叠结果还原原文，只能靠 `headroom_retrieve` 或外部 base64 二次获取。
2. **无差别应用**：对"日志"和"源码"使用同一压缩策略，源码的符号敏感性与日志完全不同。
3. **工具链撕裂**：read 返回折叠内容但 edit 仍按磁盘原文校验，造成"工具看到的内容"与"模型看到的内容"不一致。

### 8.3 效率 vs 质量的综合评估

- **纯上下文节省**：headroom 确实减少了注入上下文的字符量，对超长输出有明显收益。
- **实际开发成本**：本次会话因压缩导致的额外操作（base64 解码、write 重写、多次重读、精确 grep）**抵消甚至超过了**压缩节省的上下文收益。
- **结论**：当前"一刀切 + 词级丢符号"策略在开发/编程场景下**效率收益为负**。压缩效率只有在**不破坏信息语义**的前提下才真正有效。

---

## 9. 进一步优化建议（基于压缩效率/质量评估）

### 9.1 按内容类型分级压缩（核心）
- **日志/状态/自然语言文本**：允许高压缩（log-fold / kompress）。
- **源码/配置文件（JS/TS/JSON/YAML/Markdown 代码块）**：默认**不压缩或仅行级折叠**（保留每行完整字符）。
- 判定依据可扩展：文件扩展名、MIME、输出中代码块占比、工具类型（read/pwsh/grep）。

### 9.2 压缩保真分级
| 级别 | 策略 | 适用 |
|---|---|---|
| L0 | 不压缩 | 文件工具 read/edit/str_replace 的输入输出 |
| L1 | 行折叠（保留整行） | 源码、JSON、YAML |
| L2 | 词级 kompress + 符号白名单 | 自然语言长文本 |
| L3 | log-fold / head-tail | 超长日志、状态清单 |

### 9.3 增强 kompress 的 must-keep 符号规则
- 现有 kompress 已保留数字/hex/全大写/路径/扩展名/CLI flag/CamelCase。
- 建议增加：**JS/TS 运算符与语法符号白名单**（`= ? : => ( ) { } [ ] , ; . ! & | + - * / < >`），至少保证折叠后仍可被 JS parser 识别为合法 token 序列。
- 若无法保证，则对代码内容直接降级到 L1。

### 9.4 工具链一致性（read→edit 契约）
- headroom 的折叠应只作用于"模型上下文展示快照"，**文件工具（read/edit/str_replace）的 old_string/new_string 匹配必须始终使用磁盘原文**。
- 建议：文件工具返回内容时标记 `source: disk`（不折叠）或提供 `raw=true` 参数；编辑工具读取快照时跳过 headroom 层。

### 9.5 压缩收益可量化
- 记录每次折叠的 `原始 chars → 压缩 chars → 估算 token`，并在 `headroom_retrieve` 返回时附带。
- 对"压缩后仍被 retrieve/base64 绕过"的折叠做统计，衡量**无效压缩率**（压缩了但没人用折叠结果，仍要取原文）。
- 目标：将无效压缩率降到接近 0。

### 9.6 搜索/日志折叠保留定位锚点
- search-fold 必须保留：行号、匹配行全文（至少匹配行本身）、文件路径。
- 折叠只压缩"匹配行之外的上下文"，不得把匹配行本身丢进折叠。

### 9.7 提供会话级开关
- `headroom.mode: auto|off|code-safe`（默认 auto）。
- `headroom.noFoldForTools: ["read","str_replace_editor"]`。
- `headroom.noFoldForPatterns: ["*.js","*.ts","*.json","*.yml"]`。

### 9.8 折叠标记减噪
- 将 `[headroom: ...]` 长标记压缩为简短结构化标记（如 `⤷[headroom 80%→id]`），并统一放在结果末尾，减少对正文的视觉干扰。

---

## 10. 待办关联

- 待办 `983294a7`：优化 dsh-headroom：修复工具输出压缩对开发流程的干扰（project/q2）。
- 本文档第 8、9 章为压缩效率/质量评估与优化方向，供该待办实施时参考。


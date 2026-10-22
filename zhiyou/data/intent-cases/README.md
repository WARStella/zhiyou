# 需求理解评估样例 `intent-cases-v1`

> **先读这一段，再读其余部分。**
> 本批 100 条样例是**助手起草的草稿**，`source` 一律为 `ai_drafted`，**尚未经人工交叉标注**。
> 在完成两人独立标注与人工裁决之前，它**不能**作为「人工标注」证据出现在任何材料、答辩或报告里。
> 可以出现的表述只有一种：「已起草 N 条样例（AI 起草，待人工标注）」。

---

## 1. 用途

- 对应**计划书 §11.2「核心评测」**中"另建立 60–100 条需求与修改样例，覆盖否定、模糊表达、数值变化和多人冲突"这一条，以及**附录 C.5「AI 能力的补充评估」第 (1)、(2) 项**：
  - C.5(1) 解析与追问：建立 60–100 条中文需求与修改样例，覆盖否定、模糊表达、数值变化和多人冲突；开发集与冻结测试集分开；至少两人交叉标注；报告固定模型与提示词版本、关键字段正确率、**应追问样例的追问率**与错误类型。
  - C.5(2) 连续修改的正确性：「多停留二十分钟 + 最后一站别删」这类连续指令样例，检查修改是否落在正确的节点、是否引入未要求的变动。
- 支撑评审维度「**AI 能力融合 20%**」（计划书 §12 权重表）：其证据列为「独立解析评测、连续修改正确性、同规划器表单对照」，本批样例是其中**独立解析评测**与**连续修改正确性**两项的测试集。
- **归因纪律（照抄 C.5，不得放宽）**：本评测只能说明**解析与追问**这一层的表现。不得由它推断规划收益，也不得把整体增益单独归因于大模型或其中任一机制；要单独评价 AI 交互，仍须用**同一规划器下的自然语言／手动表单对照**。

### 报告时必须一并写明的版本信息

跑分结果离开下面三项就无法归因（附录 C.5 明确要求固定它们）：

| 项 | 从哪里取 |
|---|---|
| 模型 | 云函数环境变量 `AI_MODEL`（`intent.parse` 回传的 `model`） |
| 提示词版本 | `lib/ai/http.js` 的 `PROMPT_VERSION`（当前 `intent-v6`） |
| 解析器 | `intent.parse` 回传的 `parser`（`http` 走模型 / `rulebased` 是降级路径）与 `degraded` |

**降级样本必须单独报告，不得与模型样本混在一起算一个准确率**：规则解析是计划书 §6.5 要求的可用性兜底，它的分数不是模型的分数。

---

## 2. 文件

| 文件 | 内容 |
|---|---|
| `cases.v1.json` | 100 条样例，编号 `intent-001` … `intent-100` |
| `annotation/sheet.pilot20.json` | 前 20 条（`intent-001` … `intent-020`）**每一个 turn** 的两人标注表 |
| `README.md` | 本文件 |

顶层结构：

```json
{
  "datasetVersion": "intent-cases-v1",
  "createdAt": "2026-10-15",
  "source": "ai_drafted",
  "disclaimer": "……",
  "cases": []
}
```

---

## 3. 字段说明

### 3.1 单条 case

| 字段 | 说明 |
|---|---|
| `caseId` | 编号，`intent-001` … `intent-100`，在开发集／冻结集里都是稳定标识 |
| `type` | 六类之一（见 §4） |
| `scenarioGroupId` | **切分单位**。同一场景的改写句、同一段多轮对话共用一个组 id（见 §5） |
| `source` | 一律 `ai_drafted`。**出现 `human_authored` 即为错误** |
| `difficulty` | `easy` / `medium` / `hard`（起草时的主观判断，不是测量结果） |
| `context` | 该轮所处的行程状态：`tripId`、`currentNodeId`、`mustVisitNodeIds`、`nodes`（`nodeId` + `name`）、`endAt` |
| `turns` | 一轮或多轮：`{ text, expected }`。`text` 是**用户原话**，一字不改 |
| `needsClarification` | 该 case 是否**必须**追问。为 `true` 时，对应轮次的 `expected` 必须给出 `clarifyFields` |
| `annotationStatus` | `draft`（本批全部）→ 人工裁决后改 `reviewed` |
| `notes` | 一句话说明这条考什么 |

### 3.2 `expected` 允许出现的字段（封闭集合）

`action`、`plannerTrigger`、`strategy`、`mustVisitTexts`、`searchKeywords`、`stayMinutes`、`stayMinutesByText`、`endAt`、`pace`、`preferredMode`、`preferredModeByText`、`modeIsGlobal`、`preserveMustVisitNodeIds`、`preservePreviousChanges`、`conflict`、`clarifyFields`、`rejectReason`。

评分沿用 `lib/ai/eval.js` 的两条纪律：**只检查样例声明过的字段**；**错误类型分开统计**（漏提取 / 多提取 / 值错误 / 结构错，"少提取"与"凭空多提取"是两种毛病，后者严重得多）。因此 `expected` **不要求写全**，写进去的就是要判的。

`action` 取值（语义意图）：`plan`（首次生成）、`extend_stay`、`shorten_stay`、`skip_node`、`replace_node`、`set_end_at`、`set_pace`、`set_mode`、`set_must_visit`、`remove_must_visit`、`clarify`、`reject`。

`plannerTrigger` 取值**只有四种真实触发**：`extend_stay` / `shorten_stay` / `skip_node` / `replace_node`，结构 `{type, targetNodeId, deltaMinutes?}`。它与 `lib/planner.js` 的 `applyTrigger` 一一对应；`set_end_at` 属于约束变更，**不写进 `plannerTrigger`**。

`strategy` 只有两个值，与 `lib/planner.js` 的候选策略同名：`minimal_change`（少改原计划）、`reoptimize`（按当前需求重新优化）。

### 3.3 数值不由模型生成

`stayMinutes`、`deltaMinutes`、`endAt` 这些数只是**用户说过的量与时刻**；距离、步行时长、开放时间、可行性一律由确定性算法用真实数据算。样例里出现的任何数值都必须是"用户嘴里说出来的"，不是"系统估算的"。

---

## 4. 六类分布

| `type` | 条数 | `caseId` 区间 | 组数（`scenarioGroupId`） | 考什么 |
|---|---:|---|---:|---|
| 明确需求 | 20 | `intent-001` … `intent-020` | 20 | 时间、必去、停留时长、节奏、出行方式、排斥项等**说了就要接住**的字段 |
| 否定与纠正 | 15 | `intent-021` … `intent-035` | 15 | "不去 X""我说的是 Y""刚才说的不算"；含**凭日期猜天气**的反面样例 |
| 模糊输入与必要追问 | 15 | `intent-036` … `intent-050` | 15 | "晚一点""那个大学""随便走走"；全部 `needsClarification: true` |
| 连续修改 | 30 | `intent-051` … `intent-080` | **15** | 每条 2 轮、同一段对话两个改写版本；考**约束继承** |
| 多人需求冲突 | 10 | `intent-081` … `intent-090` | 10 | 必去地点与某个成员的结束时间／步行上限无法同时满足 |
| 超范围、缺失和异常输入 | 10 | `intent-091` … `intent-100` | 10 | 多日全城规划、无法定位的地点、缺当前行程、残缺与注入类输入 |
| **合计** | **100** | | **85** | |

其他统计（由 `cases.v1.json` 直接数出来，不是估计）：`needsClarification: true` 共 **52** 条；`turns` 总数 **130**；`source !== "ai_drafted"` 共 **0** 条；空 `turns` 或缺 `text` 的轮次 **0** 处。

一条起草纪律：**同一句话不重复出现**，只有同一个 `scenarioGroupId` 内部的改写句允许近乎同义。

---

## 5. 分组切分规则（开发集／冻结集）

**规则一句话**：同一个 `scenarioGroupId` 的样例**必须整组落在同一侧**。

为什么不能按每条切：同一场景的**改写句**与同一段**多轮对话**放在两侧，等于冻结集里考的东西在开发集里已经调过参数——**分数会偏乐观，而且看起来一切正常**。这条与本仓库 `lib/dataset-split.js` 里对"同一路线反复调用"的处置同源。

仓库里已有实现（**直接用它，不要另写一套**）：`zhiyou/cloudfunctions/api/lib/dataset-split.js`

```
intentGroupKey(item)              // 取 scenarioGroupId（缺则退回 caseId）
splitByGroup(cases, { ratio, seed, keyFn: intentGroupKey })
assertGroupIntegrity(sides, intentGroupKey)   // 独立复验：没有组跨侧
coverageByGroup(cases, { keyFn: intentGroupKey }) // 独立组数 vs 记录数
```

要点（与实现逐条对应）：

1. **按组哈希决定整组去哪一侧**：`hash32(seed + "|" + groupId) % 1000`，默认 `ratio = 0.3`、`seed = "zy-split-2026"`。哈希是 FNV-1a，**切分可复现**——换一次随机划分，"这一版比上一版好"里就混进了切分噪声。
2. **出分数之前再验一次**：用 `assertGroupIntegrity` 这条独立路径确认没有组跨侧。泄漏不会报错，只会让分数变好，所以不能只信"切分函数写对了"。
3. **算不出组键的样例进 `ungrouped`，两侧都不进**，并在报告里写明少了多少。
4. **组数与记录数分开报**：100 条样例只覆盖 **85** 个组，其中 15 组各 2 条（连续修改类的两个改写版本）。样本量的真实含义是**组数**，不是记录数。
5. **冻结集一旦切分就冻结**：切分完成后再看冻结集表现就属于调参。`ratio` 与 `seed` 必须随结果一起写进报告。
6. `zhiyou/scripts/` 下**目前没有** `dataset-split.js` 命令行入口（只有 `run-tests.js` 与 `walk-eval.js`）。需要跑切分时按上面四条规则调用 `lib/dataset-split.js` 即可；**不要为了实现它去改仓库里的其它文件**。

---

## 6. 两人交叉标注流程

1. **准备**：把 `annotation/sheet.pilot20.json` 复制成两份，分别交给标注人 A、B。
2. **独立标注**：两人**各自独立**填写自己那一列（`annotatorA` / `annotatorB`），**不许互相对照、不许讨论**。`expected` 的字段口径与 §3.2 完全一致；判断不了的情况写 `{"action":"clarify","clarifyFields":[...]}`，**不要留空**（留空无法区分"没看"与"不会"）。
3. **比对分歧**：逐条比对两列，记录**分歧条目**与**分歧类型**。分歧本身就是结论的一部分——分歧率高的字段说明该类表达本身没有稳定答案，要在报告里如实写，而不是靠裁决把它抹平。
4. **人工裁决**：对每条分歧给出裁决结果，并把最终答案写回 `cases.v1.json` 对应轮次的 `expected`；同一条里两人一致的部分不必重写。
5. **改状态**：裁决完成后，把该 case 的 `annotationStatus` 由 `draft` 改为 `reviewed`，并（建议）在 `notes` 末尾追加裁决人与日期。
6. **报告口径**：只能报告"已标注 N 条 / 待标注 M 条"。**`annotationStatus` 仍为 `draft` 的样例，一律不得计入人工标注样本量。**

**一条硬纪律：模型输出另存，不得覆盖人工答案。** 模型跑分结果写到独立文件（如 `runs/<日期>-<模型>-<promptVersion>.json`），把解析结果与人工答案**分开存**；人工列是评测的基准，任何自动流程都不许回写它。原话（`text`）同理，一字不改。

---

## 7. 这批样例**没有**证明什么

- 它是 AI 起草的草稿，**不是人工标注数据**，`source` 全部为 `ai_drafted`。
- 它没有经过两人交叉标注，因此**没有**可报告的一致性指标。
- 它**没有**跑过任何模型——本文件里不存在任何分数。任何"准确率""追问率"都必须在固定模型与提示词版本后**实测**得出，不得预填。
- 样例中的行程与地点名字是**构造的测试上下文**（`node-a` 这类占位 id），不代表真实 POI 记录；真实数据以 `places` 集合为准。
- 首版范围就是**哈尔滨单街区、1–3 个节点的短程游览**。超出该范围的输入在样例里的正确答案是 `reject` 或 `clarify`，不是"想办法排出来"。

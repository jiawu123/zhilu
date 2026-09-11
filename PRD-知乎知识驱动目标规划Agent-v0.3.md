# 知乎知识驱动目标规划 Agent — 产品需求文档（PRD）

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v0.3 |
| 文档日期 | 2026-09-10 |
| 工作名 | 知路 Agent（待定） |
| 产品阶段 | 知乎黑客松 / MVP 定义 |
| 底层计划模块 | Visual Plan Runtime（内置于产品，不是独立用户流程） |
| 演示示例 | 成为 Agent 工程师；框架本身支持任意目标 |
| 输入来源 | 用户需求、`SOUL.md`、Plan Debugger v0.3、OpenClaw 个人助手 PRD |
| 本次修订 | 将知乎知识规划产品与 Visual Plan Runtime 合并为一套产品架构 |
| 状态 | 待团队评审；黑客松官方评分细则与 API 配额仍需补充 |

---

## 0. 背景与定位

### 0.1 背景

用户向通用 AI 提出一个目标时——例如转行、学一项技能、发布产品、完成创作或改善生活习惯——通常会得到一份看似完整、实则高度通用的路线。模型往往不知道用户的起点、动机、可投入时间、成功标准和现实约束，也不会稳定区分知乎经验中的共识、个案、过时内容和相互冲突的观点。

另一方面，直接把大量知乎回答塞进上下文并不能解决问题：

- 回答数量多，Context 很快膨胀；
- 高赞不等于适合当前用户；
- 同一问题下可能存在不同前提和互相冲突的路线；
- 工具、框架和岗位要求具有明显时效性；
- 长回答中真正能影响计划的内容可能只有几句话；
- 单次生成的学习计划不会根据用户进度持续更新。

### 0.2 产品定位

**知路 Agent 是一个以可编辑 Roadmap 为核心的目标规划工具：先理解目标和用户，再检索知乎证据生成路线；用户可以直接在 Roadmap 上推进任务、修改节点和记录突发事件，系统据此持续调整计划。**

产品内部包含 Visual Plan Runtime。知乎知识层负责理解用户、检索内容、区分事实与经验并提出候选路线；Visual Plan Runtime 负责把路线保存为 Plan Bundle，并通过 Plan Engine 校验依赖、计算变化影响、应用 Patch 和记录 Commit。两者属于同一个产品：前者产生计划依据和候选方案，后者维护正式计划状态。

它不是“知乎回答总结器”，也不是普通 Todo List，而是：

> **把社区经验编译成适合一个具体人的 Roadmap，并让它随着现实持续更新。**

框架不限定目标类型。用户可以输入“成为 Agent 工程师”“发布第一个产品”“半年内完成一本书”“准备一场马拉松”等目标；系统根据目标、背景和约束，从知乎知识中筛选适用经验，生成带时间轴、任务、产出物和检查点的个性化路线。

黑客松演示仍可使用“成为 Agent 工程师”，因为它容易展示背景差异、知识检索和可验证产出，但它只是案例，不是产品边界。涉及医疗、法律、投资等高风险目标时，系统必须降低自动建议强度并提示使用专业服务。

### 0.3 一句话价值

> 目标不是聊完就结束：先把你问清楚，用知乎经验生成 Roadmap，事情变化时直接在图上改，后续路线随之更新。

---

## 1. 目标用户与核心价值

### 1.1 首批用户

首批服务具有以下共同特征、但目标类型不限的用户：

- 有一个重要但尚未被拆清楚的目标；
- 不知道从哪里开始，或已经看过很多资料但缺少结构；
- 需要利用他人的真实经验降低试错成本；
- 愿意回答关于背景、目标、时间和约束的问题；
- 希望拿到能够立刻执行的计划，而不是概念介绍；
- 愿意在执行过程中反馈进度，让计划继续调整。

### 1.2 目标类型与个体差异

同一套框架可以处理不同目标，但不能用同一套模板硬套：

| 目标示例 | 必须理解的背景 | 计划中的关键产出 |
| --- | --- | --- |
| 成为 Agent 工程师 | 编程基础、岗位方向、作品经历 | 项目、评测结果、作品集、面试准备 |
| 发布第一个产品 | 团队、技术、预算、目标用户 | 原型、用户验证、发布版本、复盘 |
| 完成一本书 | 主题、已有素材、写作习惯、截止时间 | 大纲、章节、审稿和成稿 |
| 准备马拉松 | 当前运动水平、时间、伤病和健康限制 | 周训练、恢复、阶段测试；高风险处提示专业指导 |
| 学会公开演讲 | 当前经验、使用场景、可练习机会 | 演讲稿、录像、反馈和迭代 |

即使目标相同，用户的起点、资源和成功标准也会改变路线。系统如果不先理解这些差异，知乎知识再多也只能生成泛化计划。

### 1.3 用户核心任务

1. 帮我把模糊愿望变成可检查的目标；
2. 判断我已经具备什么、缺什么；
3. 从知乎找到与我情况相似或对我有帮助的经验；
4. 解释为什么选择这些经验，而不是只给链接；
5. 把建议转成按周执行的任务和产出物；
6. 让我能在 Roadmap 上直接编辑、完成、延期或新增任务；
7. 当突发事件发生时，在 Roadmap 上看到影响并调整后续路线；
8. 让我能导出、保存或分享这份计划。

### 1.4 核心价值

- **更懂用户**：先建立 Goal Contract 和 User Context Card，再开始规划。
- **更有依据**：关键建议带知乎来源，区分事实、观点和 AI 推断。
- **更可执行**：每周都有任务、交付物、完成标准和检查点。
- **更可操作**：Roadmap 不是静态展示，用户可以直接改变节点、依赖和状态。
- **更可持续**：进度变化后只调整受影响部分，保留历史版本。
- **更节省 Context**：只把当前决策需要的证据卡送进模型，不加载整个知识库。

---

## 2. 产品原则

1. **先理解，再回答**：没有达到最低背景完整度，不生成正式计划。
2. **最多 30 问，不是固定 30 问**：先问少量高信息量问题，再按缺口追问。
3. **知乎来源不直接等于事实**：单篇回答默认按个人经验、观点或待验证事实主张处理。高赞、认证或多数观点都不能自动进入正式 Fact。
4. **Facts 与 Experience 分工**：用户确认或可靠来源支持的事实用于约束计划；知乎经验用于补充实际步骤、常见困难、风险和候选路线。
5. **保留分歧，不强行合并答案**：适用条件不同或彼此冲突的经验应形成不同 Route，供用户比较，而不是由模型压缩成一个标准答案。
6. **检索服务于决策**：每次检索必须对应一个计划问题或能力缺口。
7. **计划中的重要建议必须可追溯**：来源可以是用户事实、已验证事实、知乎经验或观点，以及明确标注的 AI 推断。
8. **Plan as Data**：正式计划存为结构化 Plan Bundle，聊天不是唯一真相源；Roadmap、Flow、Routes 和 Timeline 等视图必须读取同一份 Plan Data。
9. **Roadmap first, Chat second**：Roadmap 是正式工作区；Chat 用于澄清和解释，不能成为唯一计划载体。
10. **人可以修正 Agent 对自己的理解**：用户画像、目标和限制都必须可编辑。
11. **直接操作计划**：用户可以在 Roadmap 上增删改节点、改变状态和关系，所有修改立即成为可检查的计划变更。
12. **变化驱动更新**：用户进度或现实条件改变后，生成 Diff，不默认重写全部计划。
13. **突发事件是一等对象**：用户可以从 Roadmap 任意位置新增 Event，并看见影响传播路径。
14. **隐私最小化**：外部检索 query 不包含不必要的简历、姓名和私人背景。
15. **Agent 职责隔离**：知乎 Research Subagent 只检索和整理 Evidence，不读取完整计划或写入正式状态；Roadmapper Agent 只接收筛选后的 Evidence Pack 和相关 Plan 子图。两个 Agent 之间不传递完整聊天或知乎原文。

---

## 3. 产品形态

### 3.1 MVP 形态

MVP 是运行在用户本机的 Web 应用：

```text
用户
  ↓
浏览器前端：访谈 / Roadmap / 依据检查器 / Impact Review / History
  ↓ localhost API / SSE
本地服务
  ├── 知识与 Agent 层
  │     ├── 自适应访谈
  │     ├── 知乎检索、Claim 分类与 Evidence 筛选
  │     └── Route Candidate 与 Patch 提议
  │
  └── Visual Plan Runtime
        ├── Plan Engine：校验、影响计算、Patch 应用、Commit
        └── Bundle Repository：读写同一份 Plan Bundle
                  ↓
             用户本地 .plan/

外部 Agent（P1）
  └── CLI 或 MCP ──→ 调用同一个 Plan Engine
```

知识与 Agent 层可以调用模型进行自然语言理解和方案生成。Plan Engine 不是 Agent，而是我们编写的确定性 functions；它不负责开放式回答，只接收结构化 Event、Route 和 Patch，检查后更新 Plan Bundle。UI、CLI 和 MCP 都不能各自保存一套计划。

启动方式可以是：

```bash
npm run dev
```

或产品化后：

```bash
zhilu start
```

浏览器打开 `http://localhost:<port>`。这是一台用户电脑上的本地服务，不需要购买公网服务器。

### 3.2 核心产品界面：Roadmap Workspace

产品生成计划后，用户进入唯一的主工作区，而不是回到 Chat。

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 目标 / 当前版本 / 本周进度                              ＋新增突发事件 │
├────────────┬────────────────────────────────────┬───────────────────┤
│ Sidebar    │ Roadmap 主工作区                    │ 依据检查器         │
│ 今日与本周 │ 里程碑 → 任务 → 产出物 → 检查点      │ 来源类型与原文链接  │
│ 阻塞与待确认│ 时间轴、依赖线、状态、受影响节点      │ 适用条件与风险标签  │
│ Sources    │                                    │ 不同观点与采用原因  │
│ History    │                                    │                   │
└────────────┴────────────────────────────────────┴───────────────────┘
```

Roadmap 是面积最大的连续区域。Sidebar 只承载导航、Sources、History、设置和待确认事项；依据检查器在用户选中节点时展开，两侧面板都可以收起。P0 验收时，Roadmap 主工作区在桌面宽度下应占可用内容宽度的 70% 以上，用户执行计划时不需要切回 Chat 或离开主视图。

Roadmap 必须支持：

- 点击节点查看任务、完成标准、工时、依赖和依据检查器；
- 直接编辑标题、日期、工时、状态和完成标准；
- 拖动任务调整时间，系统同步检查依赖；
- 新增、删除、完成、跳过或延期任务；
- 在任意节点或全局工具栏新增突发事件；
- 突发事件发生后，高亮直接影响和间接影响的节点；
- 查看系统建议的调整，但由用户决定是否应用；
- 保留用户手工修改和每次正式版本历史。

P0 只实现 Roadmap 主视图，并在其中展示日期、依赖和候选路线。底层 Plan Bundle 不绑定具体视图。P1 可基于同一份 Plan Data 增加：Flow（依赖与因果）、Routes（候选路线与当前选择）、Timeline/Gantt（日期、Deadline 与时间冲突）。任何视图中的修改都必须经过同一套 Plan Engine 更新 Plan Bundle，不能分别维护四套数据。

### 3.3 辅助界面

1. **开始与了解你**：输入目标、自适应访谈、导入现有材料。
2. **依据检查器（Source Inspector）**：显示节点为何存在、来源类型、原文链接、适用条件、验证状态、风险标签、冲突观点和最终采用原因。节点没有知乎来源时，仍需标明它来自用户事实、规则或 AI 推断。
3. **Impact Review**：集中查看突发事件造成的 Before → After Diff。
4. **History**：查看 Roadmap 每个版本的修改人与修改原因。

### 3.4 后续形态

- **P1 分享页**：将脱敏后的 Plan Bundle 发布为只读网页或导出静态包。
- **P1 Agent 接入**：通过 MCP 暴露读取计划、提交进度和提出 Patch 的能力。
- **P2 桌面 App**：使用 Tauri 封装本地 Web，改善安装、文件权限、Keychain 和系统通知。

App 不是 MVP 前置条件。只有当浏览器 + 本地服务已经验证用户会持续使用计划后，再投入桌面封装。

---

## 4. 核心用户流程

### 4.1 主流程

```text
选择目标
→ 回答核心问题
→ 上传已有材料（可选）
→ Agent 判断信息缺口并追问
→ 用户确认“目标与背景摘要”
→ 系统拆出知识问题
→ 检索知乎并生成带类型和风险标签的证据卡
→ 将条件不同或冲突的经验组织为候选 Route
→ 用户通过依据检查器查看来源、适用条件和分歧
→ Plan Compiler 推荐 Current Path 并生成时间轴与任务
→ 用户确认 Baseline
→ 进入 Roadmap Workspace
→ 在 Roadmap 上执行、编辑和周期复盘
→ 新增突发事件并高亮受影响路径
→ 查看系统建议与 Plan Diff
→ 用户确认新版本
```

### 4.2 演示示例：成为 Agent 工程师

用户输入：

> 我想成为 Agent 工程师。

Agent 不立即输出路线，而是先确认：

- 目标是求职、转岗还是做独立项目；
- 当前编程与 LLM 基础；
- 截止时间和每周可投入时间；
- 是否需要作品集、面试准备或生产部署能力；
- 现有项目、课程和设备限制。

确认后的 Goal Contract 示例：

```text
目标：12 周后具备 Agent 工程师初级岗位面试与项目展示能力
当前基础：Python 中级、后端开发 1 年、无 RAG/Agent 项目
投入：每周 12 小时
成功标准：完成 2 个公开项目，其中 1 个包含 RAG、工具调用、评测和部署
限制：预算 500 元；工作日晚间学习；中文资料优先
```

系统再围绕能力缺口检索，而不是只搜索“如何成为 Agent 工程师”：

```text
Agent 工程师需要哪些生产能力
RAG 项目常见错误和评测方法
Tool Calling 与 Agent Loop 如何学习
Agent 项目作品集如何体现工程能力
Agent 工程师面试常见考察
```

最终生成 12 周路线，每周包含：

- 学习主题；
- 实践任务；
- 可提交产出物；
- 完成标准；
- 依赖关系；
- 知乎证据引用；
- 复盘问题。

### 4.3 变化与调整

第 4 周用户输入：

> 最近加班，每周只能投入 6 小时。

系统不重写整份计划，而是显示：

```diff
- 每周投入：12 小时
+ 每周投入：6 小时

- 第 5–8 周同时完成两个项目
+ 第 5–9 周只完成 RAG 项目

+ 第二个项目移动到第 10–13 周
+ 求职准备延后一周
```

用户确认后生成新版本。

### 4.4 知乎知识层与 Visual Plan Runtime 的完整例子

用户背景是“一年 Python 后端经验，每周可投入 12 小时，希望 12 周后完成 Agent 工程作品集”。系统检索后得到两组条件不同的知乎经验：

- E-04：有后端基础的人可以通过项目补齐 RAG、Tool Calling 和评测，适合项目驱动路线；
- E-07：缺少 Python 和后端基础的人应先完成基础课程，再进入 Agent 项目。

知识层把它们生成两个 Route Candidate。因为用户已经具备 Python 后端经验，Plan Compiler 推荐 Route A“直接完成两个递进项目”，同时保留 Route B“先补基础再做项目”供用户比较。用户确认 Route A 后，Plan Engine 执行 `createBaseline()`，将 Goal、用户事实、Evidence、Route、Decision、Task 和 Milestone 写入 `.plan/plan.json`，并创建 `.plan/commits/000001.json`。

第 4 周，用户告诉系统：“最近加班，每周只能投入 6 小时。”处理顺序如下：

```text
用户或 Agent 提出 Event
→ Plan Engine 校验每周投入从 12 小时变为 6 小时
→ Engine 根据依赖关系计算受影响的 Task 和 Milestone
→ Agent 提出“缩减项目范围”和“延长至 15 周”两个 Patch
→ Engine 校验 Patch，但不修改正式计划
→ UI 显示时间、任务、依据和 Before → After Diff
→ 用户选择“延长至 15 周”并确认
→ Engine 更新 plan.json，创建 commits/000002.json
→ Roadmap、PLAN.md、History 和外部 Agent 均读取版本 000002
```

这个流程中，知乎知识层负责提供适用经验和候选路线；Agent 负责理解自然语言与提出方案；Plan Engine functions 负责校验、影响计算、应用 Patch 和创建 Commit；Plan Bundle 保存正式状态；用户通过 Roadmap UI 决定采用哪条路线以及是否应用变化。

---

## 5. 自适应访谈系统

### 5.1 为什么不固定问 30 个问题

固定问 30 个问题会产生三个问题：

- 用户在看见价值前流失；
- 很多问题对当前用户无关；
- 用户的模糊回答会制造更多噪音，而不是更多信息。

因此采用“三段式访谈”：

| 阶段 | 问题数量 | 目的 |
| --- | ---: | --- |
| 核心扫描 | 6–8 | 判断目标、起点、时间、成功标准和限制 |
| 缺口追问 | 4–15 | 根据前一轮答案只追问不确定或冲突内容 |
| 最终确认 | 3–5 | 让用户确认系统理解，并处理关键取舍 |

默认问题不超过 15 个；深度模式最多 30 个。用户随时可以说“先生成草案”，但系统必须标出未确认假设。

### 5.2 背景完整度

系统内部维护 Background Completeness，不向用户显示伪精确分数。正式计划至少需要明确：

- 目标结果；
- 目标期限；
- 当前能力；
- 每周投入；
- 成功标准；
- 主要限制。

缺少任一项时继续追问，或将其标为 Assumption 并要求用户确认。

### 5.3 访谈输出

访谈结束生成两份可编辑对象：

#### User Context Card

- 当前身份与经验；
- 已掌握能力；
- 可用资源；
- 时间、预算和设备限制；
- 学习偏好；
- 隐私与分享边界。

#### Goal Contract

- 目标；
- 截止时间；
- 成功标准；
- 非目标；
- 必须包含的成果；
- 可以妥协的内容；
- 复盘周期。

用户确认这两份对象后，系统才进入正式检索和规划。

---

## 6. 知乎知识检索与 RAG 设计

### 6.1 核心判断

MVP 不应先把“知乎所有历史回答”下载并做成一个巨大向量库。更合适的是：

> **按目标拆问题 → 实时检索知乎 → 筛选少量证据 → 压缩成证据卡 → 只把证据卡送入计划生成。**

这是一种 Just-in-time RAG。它比“全库先向量化”更适合黑客松：实现更轻、来源更新、可追溯，也更容易证明知乎内容实际参与了生成。

### 6.2 检索链路

```text
Goal Contract + User Context
→ 能力缺口与决策问题
→ Query Planner 生成 1–3 个 Research Question
→ 为每个 Research Question 生成并去重知乎检索 Query（总计 6–10 个）
→ 知乎 Search API / MCP
→ 初筛候选答案
→ 去重、时效判断、质量过滤
→ 切分为候选知识块
→ 混合检索与重排
→ 多样性约束
→ 生成 6–12 张 Evidence Card
→ Plan Compiler
```

### 6.3 Query Planner

这里的 Query Planner 是 Zhihu Research Subagent 内部的研究规划能力，不是第三个 Agent。它接收已经由用户确认的 Goal Contract 和最小必要 User Context；在计划更新场景中，还接收受影响节点的知识缺口摘要。它负责生成 1–3 个可检索、可验证的 Research Question，再将每个 Research Question 改写为若干条知乎检索 Query。

Workflow Controller 不负责撰写 Research Question。它只根据状态机判断是否需要研究，检查 Query Planner 输出的数量、必填字段和隐私边界，然后为每个 Research Question 分配 ID，补充相关用户条件、时效要求和 Evidence 数量上限，组装为 `ResearchRequest`。“生成问题内容”属于 Query Planner；“组装、校验和调度请求”属于 Controller。

一个用户目标至少拆成以下查询维度：

1. **目标角色**：真实工作内容与招聘要求；
2. **前置能力**：必须先具备的基础；
3. **学习路线**：不同背景的成长路径；
4. **项目实践**：能证明能力的作品；
5. **常见失败**：容易踩坑的路线和工具；
6. **评估标准**：如何判断已经掌握；
7. **时效内容**：近期框架、工具和市场变化；
8. **反方观点**：对主流路线的质疑和替代方案。

Query 只包含完成检索所需的通用背景。例如使用“有一年 Python 后端经验的学习者”，不发送用户姓名、公司和完整简历。

### 6.4 候选内容初筛

进入排序前先确定每类知识在计划中的用途：已验证事实用于日期、资格、工具能力等硬约束；个人经验用于补充实际步骤和常见困难；观点用于比较路线；疑似推广内容只作为风险提示或被排除；AI 推断必须单独标注。LLM 负责抽取和建议分类，用户与验证规则决定哪些内容可以进入正式 Fact。

P0 的已验证事实只来自用户确认的材料，或知乎回答中可以访问和核对的官方链接；本要求不额外扩展为通用 Web 搜索。如果无法核对外部来源，内容继续保持 `fact_claim + unverified`，不能为了生成完整计划而自动升级。

每个候选知识块先标注内容类型，再进行过滤和排序。P0 内容类型为：

- **experience**：作者描述自己的经历、步骤或结果；
- **opinion**：价值判断、路线偏好或分析观点；
- **fact_claim**：可以外部验证的事实主张，但当前不代表已经验证；
- **promotion_suspected**：出现利益相关、导流或推广特征；这是风险标签，不直接断言作者在发布广告；
- **unknown**：上下文不足，暂时无法分类。

分类结果必须附带理由，并允许多标签。LLM 可以提出分类，但不能单独把 `fact_claim` 升级为正式 Fact。只有用户确认、可靠外部来源支持或多来源交叉验证后，内容才能标记为 `verified_fact`。

初筛和排序可使用：

- 标题和正文与当前子问题的相关度；
- 作者专业背景或认证信息；
- 发布时间和更新时间；
- 赞同、评论等社区信号；
- 是否包含可验证案例、数据、代码或外部来源；
- 回答是否明确说明适用前提；
- 是否包含步骤、先后顺序、避免事项或可检查结果；
- 是否存在疑似推广、单一个案、上下文不足或可能过时等风险；
- 是否与其他高质量回答高度重复。

社区热度和“先、然后、避免”等行动词都只能作为排序信号，不能单独决定保留或删除。与问题明显无关的内容可以硬过滤；高风险领域内容进入安全限制流程，不因相关度高而直接生成执行任务。

### 6.5 重排公式

每个候选知识块归一化后计算：

```text
EvidenceScore =
0.35 × 与当前子问题的语义相关度
+ 0.20 × 来源质量
+ 0.15 × 论据密度
+ 0.10 × 时效性
+ 0.10 × 对当前用户的可执行性
+ 0.10 × 对观点多样性的贡献
```

说明：

- 来源质量包含作者背景、内容完整性和可追溯性，不只看赞同数；
- 时效性按主题动态计算，框架和岗位信息衰减快，基础方法论衰减慢；
- 多样性用于避免十条证据都来自同一作者或同一种观点；
- 具体权重是 MVP 假设，必须通过人工标注集评测，不作为真理。

### 6.6 多样性与去重约束

- 最终 Context 默认保留 6–12 张 Evidence Card；
- 同一回答最多保留 2 张；
- 同一作者默认不超过 3 张；
- 至少保留 1 张反例、限制条件或不同路线；
- 高度相似的观点合并为“共识卡”，保留多个来源链接；
- 无法判断真伪但可能重要的观点标记为“待验证”，不直接生成强任务。

观点相反但各自具有明确适用条件时，不进行平均化合并。系统按“主张 + 适用条件 + 用户背景”聚类为 Route Candidate。例如，“先补基础再做项目”和“直接通过项目学习”可以形成两条路线；每条路线分别保留支持经验、反方观点、适用条件和主要风险。Plan Compiler 只能在说明选择依据后推荐 Current Path，其他路线仍可供用户比较。

### 6.7 Evidence Card

每张证据卡不是原回答全文，而是经过压缩的结构化对象：

```json
{
  "id": "E-04",
  "claim": "Agent 工程作品集应展示评测和失败处理，而不只是 Demo 界面",
  "content_type": ["experience", "opinion"],
  "verification_status": "unverified",
  "applies_when": "目标是工程岗位或生产级项目",
  "missing_context": ["目标公司的岗位级别"],
  "risk_flags": ["single_user_experience", "potentially_outdated"],
  "evidence_summary": "多位工程实践者强调可观测性、评测、状态和错误恢复",
  "counterpoint": "原型岗位或黑客松阶段可先降低生产要求",
  "source_urls": ["https://www.zhihu.com/..."],
  "published_at": "...",
  "used_as": ["route", "risk"],
  "used_by": ["milestone-03", "task-03-04"]
}
```

`verification_status` 可取 `unverified`、`corroborated`、`verified_fact` 或 `disputed`。`risk_flags` 至少支持 `single_user_experience`、`promotion_suspected`、`missing_context`、`potentially_outdated` 和 `high_risk_domain`。

只保存 API 条款允许的必要摘要、元数据和短引用；不默认复制完整回答正文。Evidence Card 进入计划时仍保留 Source、Claim 和分类结果，不能只留下模型总结。

### 6.8 Context 防爆策略

每次生成计划时执行硬限制：

- Evidence Card：最多 12 张；
- 每张摘要：建议不超过 500 个中文字符；
- 当前调用的证据总量：建议不超过 6,000 个中文字符；
- 用户画像只传与当前子目标相关的字段；
- 旧对话不整段传入，先压缩为 User Context Card 和 Goal Contract；
- 当前 Plan 只传相关里程碑和依赖子图；
- 原始知乎回答留在检索层，需要时再取，不进入每次生成 Context。

输入预算建议：

| 内容 | Context 预算占比 |
| --- | ---: |
| 工作流和输出 Schema | 15% |
| User Context + Goal Contract | 15% |
| 当前计划相关部分 | 20% |
| Evidence Cards | 40% |
| 余量与异常信息 | 10% |

### 6.9 是否需要向量数据库

#### P0

不强制使用长期向量库。使用知乎实时搜索、关键词召回、Embedding 重排和本地 Evidence Cache 即可。

#### P1

当用户产生大量历史计划和已保存证据后，再建立个人 RAG：

- SQLite 保存结构化元数据；
- FTS/BM25 做关键词检索；
- 向量索引做语义召回；
- Reranker 做最终排序；
- 引用和原始链接始终保留。

RAG 的对象是“已经筛选过的 Evidence Card、用户产出和历史计划”，不是无限复制知乎全站回答。

### 6.10 何时重新调用知乎 Research Subagent

第一次创建 Baseline 时必须进行一次目标范围内的知乎检索。计划建立后，不因每次进度或日期变化重新搜索；Workflow Controller 先执行 `shouldResearch(event, plan, evidence)`，只在出现新知识缺口时调用 Research Subagent。

需要检索的条件：

- 用户首次创建 Baseline；
- Goal、成功标准或目标领域发生实质变化；
- 当前 Route 被阻断，且 Plan Bundle 中没有可用的缓存替代路线；
- Event 引入现有 Evidence 无法回答的新问题；
- 关键 Evidence 已过期、来源失效或与新信息冲突；
- 用户明确要求查看其他人的经验或刷新依据。

不需要检索的条件：

- Task 完成、跳过或延期；
- 每周可投入时间变化；
- Milestone 日期调整；
- 用户编辑任务标题、工时或完成标准；
- 在已有 Route 之间切换；
- 仅根据现有依赖重新排期。

需要重新研究时，Workflow Controller 只向 Query Planner 传入受影响节点的知识缺口摘要和最小必要用户条件；Query Planner 据此生成 1–3 个 Research Question。默认补充 2–5 张 Evidence Card，不得重新加载整个知乎研究结果。判断结果写入 Event 的处理记录，包含 `research_needed`、触发原因和使用的 Evidence ID。

---

## 7. Plan Bundle 设计

### 7.1 目录结构

```text
我的Agent工程师路线/
├── .plan/
│   ├── manifest.json       # bundle@1、项目状态、当前 Commit ID
│   ├── plan.json           # 正式 Plan Data，机器真相源
│   ├── user-context.json   # User Context Card
│   ├── goal-contract.json  # Goal Contract
│   ├── evidence/           # Source、Claim 与 Evidence Cards
│   ├── sources/            # 用户材料和允许保存的来源内容
│   ├── pending/            # Agent 或知识层提出、尚未批准的 Event/Patch
│   └── commits/            # 每次正式计划版本
│       ├── 000001.json     # Baseline
│       └── 000002.json     # 一次已批准的变化
├── PLAN.md                 # 从 plan.json 生成的人读 Roadmap
├── 本周任务.md              # 从当前计划生成的执行视图
├── 知乎依据.md              # 从 evidence/ 生成的来源索引
├── HISTORY.md              # 从 commits/ 生成的版本摘要
└── exports/                # 分享或导出的版本
```

`.plan/` 是完整 Plan Bundle。`plan.json` 是唯一正式状态；Markdown 文件均为可重新生成的阅读视图。导出或分享时，将 `.plan/` 与选择公开的阅读视图封装为 `.planbundle.zip`。不同 Roadmap、Flow、Routes 和 Timeline 视图只能投影并修改同一份 `plan.json`。

### 7.2 核心对象

| 对象 | 说明 |
| --- | --- |
| Goal | 最终希望达到的结果 |
| ProfileFact | 用户确认的背景事实 |
| Constraint | 时间、预算、设备和生活限制 |
| Skill | 已有能力或目标能力 |
| SkillGap | 当前能力与目标之间的缺口 |
| Source | 原始来源及其作者、发布时间、链接和获取时间 |
| Claim | 从 Source 提取的具体主张，包含内容类型与验证状态 |
| Evidence | 一个或多个 Claim 压缩形成的依据卡，可用于路线、步骤、风险或约束 |
| Route | 由一组适用条件、任务、依据和风险组成的候选路线 |
| Decision | 路线中的明确选择 |
| Milestone | 可验证的阶段成果 |
| Task | 具体行动 |
| Deliverable | 代码、文章、Demo、简历等可检查产出 |
| Checkpoint | 周复盘、能力测试或人工确认节点 |
| Assumption | 尚未确认但暂时采用的前提 |
| Event | 进度或现实条件变化 |
| Commit | 用户确认的一次计划版本更新 |

### 7.3 时间轴要求

每个 Task 至少包含：

- 所属 Milestone；
- 开始与结束日期；
- 预计投入时间；
- 前置依赖；
- 具体行动；
- 可提交产出物；
- 完成标准；
- 依据来源及用途（用户事实、已验证事实、知乎经验、观点或 AI 推断）；
- 状态；
- 调整原因。

时间轴不能只写“第一周学习 RAG”。合格任务示例：

```text
任务：为一个文档问答项目建立 20 条人工评测集
投入：3 小时
产出：eval_dataset.json + 一页评测说明
完成标准：覆盖事实查找、跨段推理、拒答三个类别；运行一次基线并记录结果
依据：E-04、E-07
```

### 7.4 计划更新

当用户报告“每周时间减半”“项目提前”“某技能已掌握”等 Event 时：

1. Agent 或用户提交结构化 Event；外部 Agent 提交的内容先进入 `.plan/pending/`；
2. Plan Engine 校验 Event，并根据节点关系定位受影响的 ProfileFact、Constraint、Assumption、Decision、Task 和 Milestone；
3. 知识与 Agent 层可补充候选 Route 或 Patch，Plan Engine 负责校验其节点引用、前置状态和 Plan Invariants；
4. UI 展示 Before → After Diff、依据变化和未受影响部分；
5. 用户逐项确认或修改；未经确认的 Patch 不改变 `plan.json`；
6. Plan Engine 应用已批准的 Patch，更新 `plan.json`，并在 `.plan/commits/` 写入新的不可变 Commit；
7. 系统重新生成 `PLAN.md`、`本周任务.md` 和 `HISTORY.md`；
8. 恢复旧版本时生成新的恢复 Commit，不删除后续历史。

本文中的 Commit 是 Plan Bundle 内部的计划版本，不等同于 Git Commit。项目位于 Git 仓库时，用户可以额外用 Git 管理 `.plan/`，但产品功能不能依赖 Git。

归档节点或 Route 时，只在 `plan.json` 中把状态改为 `Archived`；归档整个项目时，在 `manifest.json` 中把项目状态改为 `archived`。归档不删除 Bundle，也不上传到产品方服务器，UI 默认隐藏并允许恢复。

---

## 8. 模块详述

### 8.1 M1 — 用户理解与目标澄清（P0）

#### 核心目标

在检索和规划前建立经过用户确认的背景与目标，避免生成通用答案。

#### 输入

- 用户自然语言目标；
- 自适应问题回答；
- 用户上传的 Markdown/TXT；
- 可选简历、已有计划或项目说明。

#### 输出

- User Context Card；
- Goal Contract；
- 已确认事实；
- 未确认假设；
- 能力缺口初稿。

#### 验收标准

- [ ] 首轮不超过 8 个问题；
- [ ] 能根据答案跳过无关问题；
- [ ] 能识别回答中的冲突并追问；
- [ ] 用户可以修改背景摘要；
- [ ] 未明确成功标准时不直接生成正式计划。

### 8.2 M2 — 知乎知识检索与证据编译（P0）

#### 核心目标

把知乎搜索结果筛选为少量、可引用、与当前用户决策相关的 Evidence Cards。

#### 工作流

```text
能力缺口
→ 查询拆解
→ 知乎检索
→ 内容分类与风险标记
→ 去重、时效与质量过滤
→ 重排
→ 证据压缩
→ 分歧聚类与 Route Candidate 生成
→ 引用检查
```

#### 验收标准

- [ ] 至少调用一次真实知乎能力；
- [ ] 每张 Evidence Card 有可点击来源；
- [ ] 每张 Evidence Card 包含内容类型、验证状态、适用条件和风险标签；
- [ ] 单篇知乎回答不会未经验证直接生成正式 Fact；
- [ ] 最终计划能显示哪些任务使用了哪些证据；
- [ ] 同一答案不会占满 Context；
- [ ] 至少一组适用条件不同的观点可形成两个 Route Candidate；
- [ ] 没有来源支持的判断标为 AI 推断。

### 8.3 M3 — Plan Compiler（P0）

#### 核心目标

把用户目标、能力缺口和知乎证据编译成带时间轴的 Plan Bundle。

#### 输出要求

- 一条 Current Path；
- 1–2 条有真实分歧依据的候选 Route；
- 3–5 个 Milestone；
- 按周任务；
- 每项任务的产出物和完成标准；
- 关键依赖；
- 周复盘节点；
- 来源引用；
- 未确认假设和风险。

#### 验收标准

- [ ] 计划长度与用户每周可投入时间一致；
- [ ] 任务可以被外部观察和检查；
- [ ] 不出现只有“学习、了解、熟悉”的空任务；
- [ ] 每个重要 Milestone 至少有一项证据或用户事实支撑；
- [ ] Current Path 的选择说明引用了用户条件和对应 Route 的依据；
- [ ] 用户可以编辑并确认 Baseline；
- [ ] 可导出完整 Bundle。

### 8.4 M4 — Roadmap 交互、执行与动态调整（P0 核心）

#### 核心目标

把 Plan Bundle 渲染成可直接操作的 Roadmap，让计划在生成后成为用户持续工作的地方，而不是一次性图片。

#### P0 能力

- 时间轴、里程碑、任务、产出物和依赖关系；
- 节点详情、依据检查器和完成标准；
- 节点直接编辑、拖动改期、增删和状态更新；
- 今日和本周聚焦视图；
- 从全局或选中节点新增突发事件；
- 受影响路径高亮；
- 调整建议和 Before → After Diff；
- 用户确认后更新计划版本。

#### 验收标准

- [ ] 用户可以更新任务状态；
- [ ] 用户点击重要节点后，可以看到来源类型、原文链接、验证状态、适用条件和风险标签；
- [ ] 没有知乎来源的节点能正确显示为用户事实、规则结果或 AI 推断；
- [ ] 用户可以直接编辑 Roadmap 节点和日期；
- [ ] 用户可以在 Roadmap 上新增突发事件；
- [ ] 系统能高亮事件影响的节点与依赖路径；
- [ ] 时间变化后只调整受影响部分；
- [ ] 用户手工修改不会被静默覆盖；
- [ ] 每次正式调整有原因和历史记录。

### 8.5 M5 — 导出与分享（P0 导出，P1 分享）

#### P0

- Markdown/JSON/ZIP 导出。

#### P1

- 生成脱敏只读分享页；
- 用户选择隐藏背景、预算、进度和私人来源；
- 分享页展示目标、路线、里程碑和公开证据；
- 访问者可以“复制为自己的 Plan Bundle”，但不能修改原计划。

---

## 9. 技术架构

### 9.1 推荐架构

```text
React / Vite 前端
    ↓ REST + SSE
本地 Orchestrator
    ├── Knowledge and Agent Layer
    │     ├── Workflow Controller
    │     ├── Interview Manager
    │     ├── Roadmapper Agent
    │     ├── Zhihu Research Subagent
    │     └── Research Pipeline
    │           ├── Zhihu Retrieval Adapter
    │           ├── Claim Classifier 与 Risk Flagger
    │           ├── Evidence Ranker
    │           └── Route Candidate Builder
    │
    └── Visual Plan Runtime
          ├── Plan Engine
          ├── View Projector（P0 Roadmap；P1 多视图）
          └── Bundle Repository
                 ↓
          .plan/ + SQLite Evidence Cache

CLI Adapter ─────┐
MCP Adapter ─────┴──→ 调用同一个 Plan Engine
```

知识层与 Plan Runtime 通过结构化对象连接：知识层输出 User Context、Goal Contract、Evidence、Route 和候选 Patch；Plan Engine 只接受符合 Schema 的输入，校验后才能写入正式 Plan Bundle。

### 9.2 Plan Engine

Plan Engine 是本产品开发者编写的一组普通 functions，不是用户的 Agent，也不调用模型完成开放式判断。建议实现为独立 TypeScript package，最小接口包括：

```ts
createBaseline(input): PlanState
validatePlan(plan): ValidationResult
validateEvent(event, plan): ValidationResult
calculateImpact(plan, event): ImpactDiff
validatePatch(plan, patch): ValidationResult
applyPatch(plan, patch): PlanState
createCommit(before, after, metadata): Commit
restoreVersion(plan, commitId): Patch
projectView(plan, viewType): ViewModel
```

模型或外部 Agent 可以生成 Event、Route 和 Patch；Engine 不信任这些输出。校验失败时，函数返回结构化错误并保持 `plan.json` 不变。相同 Plan State 与相同输入应产生相同的校验和影响结果。

系统规则也属于 Engine，例如：硬依赖未满足时 Task 不能进入 Ready；被失效 Assumption 支撑的 Decision 必须重新评估；用户手工确认的字段不能被 Agent Patch 静默覆盖；任何正式修改都必须关联用户操作或已确认 Event。

### 9.3 前后端交互

建议接口：

| 接口 | 用途 |
| --- | --- |
| `POST /projects` | 创建本地项目 |
| `POST /projects/:id/sources` | 导入材料 |
| `POST /projects/:id/interview/answer` | 提交访谈回答 |
| `GET /projects/:id/interview/next` | 获取下一批自适应问题 |
| `POST /projects/:id/research` | 启动知乎检索 |
| `GET /projects/:id/research/stream` | SSE 返回检索进度 |
| `GET /projects/:id/evidence` | 获取证据卡 |
| `GET /projects/:id/routes` | 获取由不同经验形成的候选路线 |
| `POST /projects/:id/plan/compile` | 生成 Draft Plan |
| `POST /projects/:id/plan/confirm` | 确认 Baseline |
| `PATCH /projects/:id/nodes/:nodeId` | 编辑 Roadmap 节点 |
| `POST /projects/:id/nodes` | 新增 Roadmap 节点 |
| `GET /projects/:id/nodes/:nodeId/provenance` | 获取依据检查器所需的来源、分类、风险和采用原因 |
| `POST /projects/:id/relations` | 新增或修改依赖关系 |
| `POST /projects/:id/events` | 提交变化和进度 |
| `GET /projects/:id/diff` | 获取计划 Diff |
| `POST /projects/:id/diff/apply` | 用户批准更新 |
| `GET /projects/:id/export` | 导出 Plan Bundle |

本地服务负责调用知乎接口和模型，Access Secret 不进入浏览器页面；生产形态应存入系统 Keychain。

### 9.4 AI 调用方式

P0 采用以下组合：

```text
Workflow Controller（普通流程代码）
  ├── Roadmapper Agent（主 Agent）
  ├── Zhihu Research Subagent（按需、无长期记忆）
  └── Plan Engine（确定性 functions）
```

Workflow Controller 不是第三个推理 Agent。它通过固定状态机判断当前处于访谈、研究、规划还是更新阶段，执行 `shouldResearch()`，控制每次调用的 Context，并把 Agent 输出交给 Plan Engine。

Roadmapper Agent 和 Research Subagent 可以调用同一个模型、API Endpoint 和 API Key。Agent 的职责由 `Model + System Prompt + Context + Tool Allowlist + State + Output Schema` 共同定义，不需要为了隔离而使用两个模型或两个服务。P0 只要求逻辑隔离和独立 Run ID，不要求进程、容器或服务器级物理隔离。

#### 9.4.1 Zhihu Research Subagent

Research Subagent 内部的 Query Planner 先根据已确认的 Goal Contract、最小必要 User Context 和可选的知识缺口摘要生成 Research Question。Workflow Controller 对输出做数量、Schema 和隐私校验，并将每个问题组装为小型 `ResearchRequest`，其中包含研究问题、与问题相关的用户条件、时效要求和 Evidence 数量上限。

Research Subagent 随后用该 `ResearchRequest` 执行知乎搜索、回答读取、Claim 分类和 Evidence 保存，但不能读取完整 Roadmap、调用 Patch Apply 或创建 Commit。

它的唯一正式输出是 `EvidencePack`：

```json
{
  "claims": [],
  "evidence_cards": [],
  "route_candidates": [],
  "disagreements": [],
  "unresolved_questions": []
}
```

任务完成后结束该 Subagent Run，不保留原始对话作为长期记忆。原始知乎内容留在 Evidence Cache；Roadmapper 默认只接收 EvidencePack，需要核查时才按 Evidence ID 读取单条来源。

#### 9.4.2 Roadmapper Agent

Roadmapper 是与用户目标和 Roadmap 交互的主 Agent。单次调用只接收 Goal Contract、与当前问题相关的 User Context 字段、选中的 Evidence Cards、当前 Event 和受影响的 Plan 子图。它负责生成 Route、Draft Plan 或 Patch Proposal，但不能直接修改 `plan.json` 或创建 Commit。

#### 9.4.3 隔离要求

两个 Agent 必须隔离：

- **Context**：不共享完整聊天、完整用户档案、全部知乎原文或全部 History；
- **Tools**：Research 只使用检索和 Evidence 工具；Roadmapper 只使用计划读取与 Propose 工具；
- **State**：长期状态只存入 Plan Bundle 和 Evidence Cache，不依赖 Agent 会话记忆；
- **写权限**：两个 Agent 都不能调用正式 Apply/Commit；
- **接口**：Agent 之间只交换 `ResearchRequest`、`EvidencePack`、`RouteProposal` 和 `PatchProposal` 等结构化对象。

隔离的目的包括减少无关 Context、避免知乎原文中的提示注入直接影响计划写入、限制错误影响范围，以及让检索、Evidence、规划和 Engine 错误可以分别测试和重试。如果 Research Subagent 把全部原文传给 Roadmapper，隔离不能降低 Token，反而会增加调用成本，因此 EvidencePack 的数量和长度上限属于强制要求。

P1 再允许用户自己的外部 Agent 替换内置 Roadmapper，通过 CLI 或 MCP 调用 `request_research`、读取 EvidencePack 并提交 Patch Proposal。外部 Agent 与内置 Roadmapper 使用相同 Schema 和审批边界，不能维护另一份计划副本。

#### 9.4.4 三种实际调用流程

**首次制定计划**

1. Workflow Controller 先调用 Interview Manager，形成经用户确认的 User Context 和 Goal Contract；
2. Controller 判断 `shouldResearch=true`，将 Goal Contract 和最小必要 User Context 交给 Research Subagent 内的 Query Planner；
3. Query Planner 生成 1–3 个 Research Question；Controller 检查数量、Schema 和隐私边界，分配 ID 并补充时效与 Evidence 上限，组装为 `ResearchRequest`；
4. Controller 为每个 `ResearchRequest` 启动一次独立的 Research Subagent Run；Research Subagent 检索知乎并返回 EvidencePack，Run 随即结束；
5. Controller 把 Goal Contract、必要的用户条件和 EvidencePack 交给 Roadmapper；
6. Roadmapper 生成 Route 和 Draft Plan；
7. Plan Engine 校验依赖、时间、字段和来源引用；
8. 前端展示 Roadmap，用户确认后，Engine 才写入 `plan.json` 并创建 Baseline Commit。

**普通进度或时间变化**

例如用户把“每周投入 10 小时”改为“每周投入 5 小时”。Controller 判断 `shouldResearch=false`，不调用知乎。Plan Engine 先计算受影响节点，Roadmapper 只接收这些节点并提出排期 Patch；前端展示 Diff，用户批准后再写入 Commit。

**出现新的知识缺口**

例如原计划依赖的学习资料失效，现有 Evidence 又没有替代路线。Controller 判断 `shouldResearch=true`，将“原资料失效且缺少替代路线”这一知识缺口摘要交给 Query Planner；Query Planner 生成“在当前目标和用户条件下有哪些可替代路线”等 Research Question。Controller 组装 `ResearchRequest` 并启动新的 Research Subagent Run。新增 EvidencePack 与受影响 Plan 子图一起交给 Roadmapper，未受影响节点不进入 Context，也不重新生成整个计划。

### 9.5 UI CLI 与 MCP 的关系

UI、CLI 和 MCP 是 Plan Engine 的并列入口，不是依次连接。P0 Web UI 通过 localhost API 调用 Engine。具有 Shell 权限的 Coding Agent 可以在 P1 使用 CLI；支持 MCP 的 Agent 可以通过 MCP Adapter 使用同一组受限能力，不需要同时接入 CLI 和 MCP。

P1 最小 CLI 为 `zhilu init`、`zhilu show`、`zhilu check`、`zhilu event propose` 和 `zhilu patch propose`。其中 Agent 可调用的写命令只生成 pending 内容，不直接应用正式 Patch。

P1 MCP 可暴露：

```text
get_user_context
get_goal_contract
get_current_plan
request_research
get_evidence_pack
submit_progress
propose_event
propose_plan_patch
```

MCP 默认允许 Read 和 Propose；正式应用 Patch 必须由 Web UI 中的用户操作完成。

CLI 与 MCP 都不能保存自己的计划副本。候选 Event 和 Patch 写入 `.plan/pending/`；用户在 UI 批准后，Engine 才更新 `plan.json` 并生成 Commit。如果 Coding Agent 拥有项目目录的完整文件写权限，它可能绕过接口直接改文件；P1 需要通过版本号、Schema 和历史一致性检查识别未经过 Engine 的修改。

---

## 10. MVP 范围与版本

### 10.1 P0 — 黑客松必须完成

1. 本地 Web 创建项目；
2. 任意目标输入 + “成为 Agent 工程师”演示模板；
3. 6–8 个核心问题 + 至少一轮自适应追问；
4. 导入 Markdown/TXT 作为已有背景；
5. 用户确认 User Context Card 和 Goal Contract；
6. Workflow Controller 依据状态机控制访谈、研究、规划和更新，并执行 `shouldResearch()`；
7. 内置 Roadmapper Agent 与无长期记忆的 Research Subagent 使用独立 Context、Tool Allowlist 和 Run ID；两者可以共用同一模型/API；
8. Research Subagent 调用真实知乎知识接口，只输出结构化 EvidencePack；
9. 从候选结果生成 6–12 张 Evidence Cards；
10. 每张证据卡有来源、内容类型、验证状态、适用条件和风险标签；
11. 至少将一组条件不同或彼此冲突的知乎经验生成两个 Route Candidate；
12. 生成 8–12 周 Plan Bundle，并说明 Current Path 的选择依据；
13. Plan Engine 将 Baseline 写入 `.plan/plan.json` 并创建第一个 Commit；
14. 前端渲染可编辑 Roadmap，包含时间轴、任务、依赖和依据检查器；
15. 用户可直接编辑、改期、完成或新增 Roadmap 节点；
16. 用户可在 Roadmap 上新增一次突发事件；
17. Plan Engine 根据同一份 Plan Data 高亮受影响节点并生成 Before → After Diff；
18. 用户确认后，Engine 应用 Patch 并在 `.plan/commits/` 创建新版本；
19. 页面刷新后，Roadmap、History 和导出结果读取同一个 Commit；
20. 导出 `.planbundle.zip`、JSON 和 Markdown 阅读视图。

### 10.2 P1 — 有余力再做

- PDF/简历解析；
- 个人历史 Evidence RAG；
- CLI 接入；
- MCP 接入；
- 基于同一份 Plan Bundle 的 Flow、Routes 和 Timeline/Gantt 视图；
- 静态分享链接；
- 从他人的公开 Plan Bundle 复制模板；
- GitHub 项目读取；
- 多种目标模板与领域化提问策略；
- Tauri 桌面封装。

### 10.3 P2 — 远期

- 多 Agent 协作；
- 导师或同伴点评；
- 团队成长计划；
- 招聘岗位反向匹配；
- 自动检查 GitHub 产出；
- 跨设备同步；
- 公开 Plan Bundle 社区。

### 10.4 明确不做

- 通用人生规划；
- 自动替用户报名、投递或付费；
- 完整日历、Kanban 或项目管理替代品；
- 把知乎回答全文无差别保存到本地；
- 用赞同数直接判断答案正确；
- 一开始就建设知乎全量向量库；
- 在没有用户确认的情况下改变正式计划。

---

## 11. 成功指标

### 11.1 North Star

> 完成背景确认、引用知乎证据，并在一周后仍有任务更新的有效 Plan Bundle 数。

只生成一次时间轴不计入核心价值。

### 11.2 激活

- 70% 以上测试用户完成核心访谈；
- 10 分钟内得到第一版可执行路线；
- 80% 以上用户能正确复述系统理解的目标；
- 每份计划至少引用 5 个不同的知乎来源；
- 用户至少修改或确认一项背景事实和一项计划任务。
- 用户在 Roadmap 上完成至少一次直接编辑或新增事件。

### 11.3 知识质量

- Evidence Card 对当前用户“有帮助”标记率 ≥70%；
- 来源链接可访问率 ≥95%；
- 无来源支持却被写成事实的关键建议为 0；
- 未经验证的单篇知乎经验被写入正式 Fact 的数量为 0；
- Evidence Card 内容类型、验证状态和风险标签完整率为 100%；
- Top 10 证据的人工相关性 Precision@10 ≥0.7；
- 同一作者或同一回答占据超过一半证据的计划为 0。

### 11.4 计划质量

- 任务均有产出物或完成标准；
- 周任务总工时不超过用户可投入时间的 110%；
- 计划调整后，不受影响的已确认任务保留率 ≥95%；
- 突发事件发生后，用户能在 30 秒内指出主要受影响节点；
- 第 7 天有任务状态更新的测试用户 ≥40%。

---

## 12. 非功能需求

### 12.1 性能

| 操作 | 目标 |
| --- | --- |
| 下一批访谈问题 | P95 ≤5 秒 |
| 知乎检索与初筛 | P95 ≤30 秒，显示实时进度 |
| Evidence Cards 生成 | P95 ≤45 秒 |
| 首版计划生成 | P95 ≤60 秒 |
| 本地页面重新打开 | P95 ≤3 秒 |

### 12.2 隐私

- 用户文件和 Plan Bundle 默认保存在本地；
- 搜索 query 不带姓名、联系方式、公司机密和完整简历；
- 调用模型前显示会发送的数据类型；
- 分享前提供脱敏预览；
- 用户可以删除本地项目与 Evidence Cache；
- 不使用用户私人材料训练公共模型或公共知识库。

### 12.3 可解释性

- 每项关键任务显示“来自用户目标 / 用户事实 / 已验证事实 / 知乎经验或观点 / Engine 规则 / AI 推断”；
- 依据检查器可以查看 Source、Claim、Evidence Card、原文链接、验证状态、适用条件、风险标签和采用原因；
- 冲突观点不静默合并成确定结论；形成 Route 时分别保留各自依据和适用条件；
- 内容过时或发布日期未知时显示提示。

### 12.4 安全

- 知乎 Access Secret 只存本地服务，不进入前端 Bundle；
- 导入 Markdown/HTML 时进行 XSS 过滤；
- 知乎原文按不可信输入处理；Research Subagent 不拥有 Plan 写入、Apply 或 Commit 工具；
- 限制本地文件访问在用户授权的项目目录内；
- MCP 写操作默认关闭；
- 分享包默认排除原始简历、聊天和私人 sources。

---

## 13. 核心风险与缓解

| ID | 风险 | 等级 | 缓解 |
| --- | --- | --- | --- |
| R1 | 产品退化成“ChatGPT 生成学习计划” | 高 | Roadmap 成为主工作区；必须支持直接编辑、突发事件、影响高亮和版本 Diff |
| R2 | 30 问导致用户流失 | 高 | 默认 6–8 个核心问题，自适应追问，深度模式才到 30 |
| R3 | 知乎内容过时、观点化或带有推广目的 | 高 | 内容类型、验证状态、时效和风险标签；单篇经验不直接成为 Fact；冲突观点分别进入候选 Route |
| R4 | Context 膨胀 | 高 | Evidence Card、硬数量上限、局部 Plan 子图和按需取原文 |
| R5 | 高赞被误当成正确 | 中 | 社区热度只占来源质量的一部分，不直接决定结论 |
| R6 | 目标范围过宽，计划看起来合理但无法执行 | 高 | 使用统一 Goal Contract，但按领域加载提问与安全规则；所有任务必须有产出物、工时和完成标准 |
| R7 | 用户不回来更新 | 高 | 本周任务、复盘和 Event→Diff；7 日使用作为 Go/No-Go |
| R8 | 分享泄露私人背景 | 高 | 字段级脱敏、分享预览、默认不含 sources |
| R9 | 黑客松 API 配额或权限不足 | 高 | 尽快确认 Access Secret、配额和指定接入方式；准备缓存演示数据但明确标注 |
| R10 | 产品同时做 RAG、Planner、MCP、App 导致失控 | 高 | P0 只做本地 Web、知乎知识链路、最小 Plan Engine 和 Plan Bundle；CLI、MCP、多视图和桌面封装后置 |

---

## 14. Go / No-Go

### 14.1 继续投入信号

- 不同背景用户获得明显不同且合理的路线；
- 用户认为知乎证据比通用模型回答更可信或更具体；
- 用户会修改计划，并在一周后回来更新进度；
- 用户愿意分享脱敏后的路线或复制他人路线；
- Agent 能说明为什么某项任务适合当前用户。

### 14.2 停止或转型信号

- 用户跳过访谈，只想立刻拿通用答案；
- 去掉知乎检索后，用户无法感知计划质量差异；
- 大多数知乎证据只是重复模型已有常识；
- 生成时间轴后没有用户回来更新；
- 用户主要价值来自漂亮页面，而不是证据和执行；
- 真实答案筛选质量长期低于人工可接受水平。

---

## 15. 黑客松演示脚本

演示控制在 3–5 分钟：

1. 两个用户都输入“我想成为 Agent 工程师”，并说明这只是任意目标框架的演示案例；
2. 用户 A 是产品经理，用户 B 是 Python 后端工程师；
3. 展示 Agent 对二者提出不同追问；
4. 展示系统生成不同的知乎检索 query；
5. 打开 3 张 Evidence Card，展示内容类型、验证状态、来源、适用条件和风险标签；
6. 展示两组知乎经验如何形成不同 Route，并说明系统为什么为两个用户选择不同 Current Path；
7. 在前端拖动一个任务、完成一个节点，证明它不是静态时间表；
8. 在 Roadmap 上新增突发事件：“每周时间从 12 小时降到 6 小时”；
9. 展示受影响路径高亮和 Before → After Diff；
10. 用户批准调整，Roadmap 更新为新版本；
11. 导出 Plan Bundle；
12. 如分享功能完成，打开脱敏只读分享页。

演示必须回答三个问题：

- 为什么不能直接问通用模型？——因为它没有经过确认的用户背景和证据筛选。
- 为什么要用知乎？——因为计划引用了社区中的真实实践、失败经验与分歧，并保留来源。
- 为什么不是 ChatGPT？——因为用户得到的是可以直接编辑、记录突发事件、检查影响并持续更新的 Roadmap，而不是一段回答。

---

## 16. 开放问题

1. 黑客松官方要求使用知乎 Search API、Skill、MCP 中的哪一种，是否有强制演示规范？
2. API 返回哪些作者、互动、时间和正文元数据，可否满足当前重排公式？
3. 是否允许本地缓存回答片段，缓存期限和展示长度限制是什么？
4. 用户是否愿意在看到计划前完成 6–8 个问题？
5. 黑客松是否要补充第二个明显不同的目标案例，以证明框架不是 Agent 工程师专用？
6. 是否需要把用户简历纳入 P0，还是只支持结构化自述？
7. 时间轴以 8 周、12 周还是按用户截止日期动态生成？
8. 分享页是黑客松加分项，还是会分散知乎检索和个性化主链路？
9. MVP 使用哪一个模型负责访谈、Evidence 处理和 Roadmapper；两个 Agent 是否默认共用该模型/API？
10. 团队是否有可用于检索质量评测的 20–50 条人工标注问题？
11. Roadmap 第一版使用纯时间轴、依赖图，还是二者结合的泳道布局？

---

## 17. P0 验收标准汇总

- [ ] 用户可在本地 Web 创建项目；
- [ ] 用户可自由输入任意目标，也可选择演示模板；
- [ ] 系统先问核心问题，而不是直接生成答案；
- [ ] 系统能根据回答进行至少一轮差异化追问；
- [ ] 用户可确认或修改 User Context Card；
- [ ] 用户可确认 Goal Contract；
- [ ] 用户可导入 Markdown/TXT；
- [ ] Workflow Controller 能区分首次研究、普通状态变化和新知识缺口；
- [ ] Roadmapper 与 Research Subagent 使用独立 Run ID、Context 和 Tool Allowlist；允许共用同一模型/API；
- [ ] Research Subagent 无法读取完整 Plan 或调用 Apply/Commit，只输出符合 Schema 的 EvidencePack；
- [ ] Roadmapper 默认只接收 EvidencePack 和相关 Plan 子图，不接收整批知乎原文；
- [ ] 系统调用真实知乎知识能力；
- [ ] 系统生成 6–12 张带来源的 Evidence Cards；
- [ ] Evidence Cards 包含内容类型、验证状态、适用条件和风险标签，至少一张包含限制或反方观点；
- [ ] 未经验证的单篇知乎经验不会直接生成正式 Fact；
- [ ] 至少一组条件不同或冲突的经验形成两个 Route Candidate；
- [ ] 系统不会把整批知乎回答塞入最终 Context；
- [ ] 系统生成有工时、产出物和完成标准的时间轴；
- [ ] 关键任务能在依据检查器中追溯到用户事实、已验证事实、知乎经验或观点、Engine 规则或 AI 推断；
- [ ] 用户可以确认 Baseline；
- [ ] Baseline 写入 `.plan/plan.json`，并在 `.plan/commits/` 生成第一个 Commit；
- [ ] 前端能把 Plan Bundle 渲染为可编辑 Roadmap；
- [ ] 用户可以直接编辑、拖动、完成和新增节点；
- [ ] 用户可以在 Roadmap 上新增一次突发事件；
- [ ] 任务完成、日期或每周投入变化不会触发全量知乎检索；新知识缺口只触发受影响问题的局部检索；
- [ ] 系统能高亮受影响节点并展示计划修改 Diff；
- [ ] 未经用户确认的 Event/Patch 保存在 pending，不改变正式计划；
- [ ] 用户确认后由 Plan Engine 应用 Patch 并生成新 Commit；
- [ ] Roadmap、History 和导出结果显示同一个当前 Commit ID；
- [ ] 页面重新打开后状态仍存在；
- [ ] 用户可导出 `.planbundle.zip`、JSON 和 Markdown 阅读视图；
- [ ] 未接入官方黑客松要求的部分被显式标记，而不是假装完成。

---

## 附录 A：30 问深度访谈题库

Agent 不按顺序全部提问，而是根据目标和已有答案动态选择。

### 目标与成功标准

1. 你最终希望实现什么具体、可观察的结果？
2. 你的目标是求职、转岗、创业、自由职业，还是完成自己的项目？
3. 你希望什么时候达到这个目标？
4. 到期时，什么可观察结果能够证明你成功了？
5. 你更关注拿到工作、掌握能力，还是完成作品集？
6. 你为什么现在要做这件事？

### 当前基础

7. 你目前的职业、专业或主要工作内容是什么？
8. 你最熟悉哪些编程语言？
9. 你的 Python 水平如何，有没有独立完成过项目？
10. 你是否做过后端、数据库或 API 开发？
11. 你对机器学习和 LLM 的理解到什么程度？
12. 你是否使用过模型 API 或 SDK？
13. 你是否做过 RAG 或向量检索项目？
14. 你是否实现过 Tool Calling、Agent Loop 或工作流编排？
15. 你是否了解 MCP、状态管理和长期记忆？
16. 你是否做过部署、监控、评测或错误恢复？
17. 你目前有哪些可以公开展示的项目？
18. 你是否有真实用户或生产环境经验？

### 时间与资源

19. 你每周可以稳定投入多少小时？
20. 哪些时间段最适合学习和开发？
21. 你可以持续投入多少周？
22. 你能接受多少课程、API 和服务器预算？
23. 你是否有可以运行开发环境的电脑和必要账号？
24. 你阅读英文文档是否存在障碍？

### 学习与执行偏好

25. 你更适合课程、阅读、跟做项目还是边做边查？
26. 你希望计划按天、按周还是按里程碑呈现？
27. 你愿意多久进行一次复盘？
28. 过去类似计划失败的主要原因是什么？
29. 你是否愿意接受一次基础能力测试来校准路线？
30. 哪些个人信息和计划内容不能进入外部检索或分享页面？

---

## 附录 B：v0.3 核心判断摘要

产品成立需要同时满足：

```text
经过确认的用户背景
+ 可筛选、可引用的知乎证据
+ 由不同经验形成的候选 Route
+ 可直接操作的 Roadmap
+ 由 Plan Engine 管理的 Plan Bundle、Patch、Commit 和 History
+ 突发事件驱动的影响分析和持续调整
```

如果产品最终只是：

```text
输入一个目标
→ 搜索知乎
→ 总结回答
→ 生成漂亮时间表
```

则与 ChatGPT 或其他 Agent 没有足够差异，不值得作为独立产品继续投入。

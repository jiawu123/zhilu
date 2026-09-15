# 知乎直答 Agent 与当前研究方案的稳定性对比

评估日期：2026-09-13（本机 America/New_York；实测 UTC 日期为 2026-09-14）。

## 决策

保留当前 `batch-v1` 研究链路，本轮不切换默认 Provider。当前证据不足以证明直答 Agent 更稳定；本次同题实测中，直答调用失败，现有方案返回了带明确缺口的有效证据。一次对比不能推导长期成功率，也不能说明直答服务普遍不可用。

用户授权是“如果直答方案更稳定，就采用它”。本次未满足这一条件。没有更换模型、放宽证据校验、增加自动回退或修改正式计划。

## 官方文档核对

来源：[用户提供的飞书开发流程文档](https://pcnsiq9mmnww.feishu.cn/wiki/Pd1UwIIBriW0DBk8qlIczBAVnJc)，以及其中链接的 [知乎官方 Skill 0.7.2 文档包](https://developer-cdn.zhihu.com/zhihu-cli/releases/beta/skill/0.7.2-beta.20260911131715/zhihu-cli-skill-0.7.2-beta.20260911131715.zip)。参考文件为 `zhihu/SKILL.md`、`references/cli.md`、`references/http-api.md` 和 `references/open-platform.md`；仅下载阅读，未安装或更新 CLI/Skill。

- 直答提供 `zhida-fast-1p5`、`zhida-thinking-1p5`、`zhida-agent`。本次实际测试的是用户提到的智能检索档位 `zhida-agent`，没有测试另外两个档位。
- 原生接口为 `POST https://developer.zhihu.com/v1/chat/completions`，正式保证的请求字段只有 `model`、`messages`、`stream`。文档未承诺 JSON Schema/`response_format`、结构化来源片段及逐字引文绑定。
- CLI `answer` 面向单轮综合答案。官方文档和本机 `answer --help` 均将原始资料研究、证据链与观点比较引导至搜索。
- 飞书公开介绍的直答额度为每日 100 次、搜索 5,000 次；**本机实时 `quota` 返回两项均为每日 5,000 次，查询时均未使用**。额度按开发者账户共享，不能据公开介绍断言本账号只有 100 次。本次额度结果不是未来额度保证。

## 当前实现

`Server → Python → 知乎官方 CLI 搜索 → DeepSeek 批量整理 → Python/TypeScript 校验 → EvidencePack`。

现有检索使用官方接口，不依赖网页抓取。当前生产默认配置为 `batch-v1`，由 `packages/zhihu/zhihu_m2/retrieval_options.py` 读取；搜索由 `plan_retrieval.py` 执行；独立模型调用在 `llm_client.py`。

最近的失败记录集中在搜索成功之后的模型输出格式或引用关系，见 [现有故障修复记录](ZHIHU_LIVE_COMPILATION_FIX_2026-09-13.md)。当前实现会保留合格证据，隔离部分无效输出；HTTP 规划入口已采用 `allow_insufficient`，允许带证据缺口继续模型规划，执行错误仍会停止。

当前校验保证引文确实来自返回的搜索片段，并保留来源链接；不保证事实正确或语义充分支持。证据仍标记为搜索摘要、未经独立核实，需要人工检查。

## 本次同题在线验证

问题均为“计划一场环中国旅行”，不发送个人背景；本次各启动一次调用，独立并行执行，测试脚本未追加重试；CLI 内部是否重试未测量。测试覆盖研究环节，未调用 Planner 或 Roadmapper，未写入用户计划。

| 项目 | 官方直答 Agent | 当前 batch-v1 |
| --- | --- | --- |
| 调用 | `answer --model zhida-agent`，客户端等待上限 90 秒 | 1 次知乎搜索 + 1 次批量模型；最多 5 张卡；缓存关闭 |
| 结果 | CLI 退出码 5，`NETWORK_ERROR`，没有答案 | `partial`，5 张合格证据卡，1 个路线候选 |
| 耗时 | 30.750 秒（CLI 外层墙钟时间） | 38.984 秒（研究管线记录） |
| 细分 | CLI 未提供更具体的失败原因 | 搜索 0.609 秒，批量编译 38.359 秒 |
| 校验情况 | 无答案可供比较 | 10 个候选，9 个合法输出，1 个无效项，0 个无效研究假设；选择后保留 5 张卡 |

两种计时边界略有不同；直答失败耗时不是成功响应速度，不能据此判断哪个方案更快。直答失败可能涉及网络、CLI 或上游服务，本次未定位具体原因。没有把现有方案的 `partial` 当成完整研究成功。

本地证据（被 Git 忽略）：

- `packages/zhihu/artifacts/zhida-comparison-20260913/zhida-agent-probe.json`：直答安全结果摘要。
- `packages/zhihu/artifacts/research-zhihu-rulhWC/status.json`：现有研究的状态及计数。
- `packages/zhihu/artifacts/research-zhihu-rulhWC/result.json`：经现有 Provider 校验后的实际证据。

## 切换判断

直答把检索与回答合并，对只需要自然语言答案的功能可能更容易接入；这属于工程推断，并非本次测出的稳定性优势。若继续要求现有 EvidencePack 的来源与引文约束，就仍需取得原始来源、做适配和校验，不能通过换一个回答接口自动解决编译失败。

因此本轮保留现有实现。后续只有在直答取得可复核的原始来源、通过相同证据验收，并在多个代表性问题的重复测试中展示更高有效结果率后，才有依据替换研究 Provider。本次只新增评估记录；没有修改产品代码，也没有重跑整套离线测试。

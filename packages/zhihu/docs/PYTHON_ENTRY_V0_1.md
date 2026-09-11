# M2 Python 入口 v0.1：规划接通版

## 本次范围

这是补入空 `zhihu_m2/pipeline.py` 的第一步，不是完整 M2 实现。

- `--action plan`：调用项目已有 `query_planner.plan_research()`，正常执行最多一次模型调用；不检索知乎，不编译 Evidence。
- `--action research`：明确返回 `research_not_connected`，退出码 3。尚未连接正式 ResearchRequest → EvidencePack，不返回空的成功结果。
- 不覆盖现有 Planner、Retrieval、Ranker、Compiler、models、normalizer、llm_client、.env 或 .gitignore。
- 不读取完整 Roadmap，不写 Plan Bundle，不更改 human_approved，也不改写内部 question_id。

协议名称 `m2-entry-v0.1`、响应包装和 action 名称是此实现的接入草案，并不是 Jia 已确认的 contracts。
最新 PRD 的 Goal Contract/知识缺口输入、Controller 分配的 ID、单问题 ResearchRequest、完整 EvidencePack 仍需下一步接线。
旧的两字段输入只用于此版本的 `plan`，不能当作正式 ResearchRequest。

## 安装到现有仓库

在 `zhilu/packages/zhihu` 下按相对路径复制：

```text
zhihu_m2/pipeline.py
tests/test_pipeline_entry.py
examples/entry_plan_request.json
docs/PYTHON_ENTRY_V0_1.md
docs/ENTRY_VALIDATION_REPORT.md
```

保留项目原来的 `zhihu_m2/__init__.py`。压缩包故意不附带新的 `__init__.py` 或现有业务模块，避免覆盖。
该入口只新增标准库代码；现有 llm_client 的依赖和认证仍须按原项目配置。

## PowerShell：运行真实规划

在已配置好的虚拟环境中：

```powershell
cd C:\Users\Kylee\Desktop\zhilu\packages\zhihu
python -m pytest .\tests\test_pipeline_entry.py -q

python -X utf8 -u -m zhihu_m2.pipeline `
    --action plan `
    --input .\examples\entry_plan_request.json `
    --output .\artifacts\latest_entry_plan.json

if ($LASTEXITCODE -ne 0) {
    throw "入口运行失败，请检查终端 JSON 的 error.code；不要把旧输出文件当作本次成功结果。"
}

Get-Content .\artifacts\latest_entry_plan.json -Raw -Encoding UTF8
```

新入口默认调用模型，不需要旧 CLI 的 `--call-model`。不要自动循环重试。
输出目录提前检查，文件写入通过临时文件替换完成。执行中遇到存储错误时也可能已产生一次模型调用；看 metrics，不盲目重跑。

仅检查输入可以在同一命令里加 `--dry-run`，这不是真实调用的强制前置步骤。
`--max-questions` 允许 1–3，`--queries-per-question` 允许 1–2，保持当前 Planner 的范围；尚未升级 PRD 中的查询总预算。

## 输入

一个 UTF-8 JSON 对象，顶层恰好 `goal` 与 `user_context`：

```json
{
  "goal": "用户目标",
  "user_context": {}
}
```

复用当前 Planner 的目标长度、上下文长度、深度、有限数值与常见密钥字段检查。
入口另行限制 64,000 字节，拒绝重复 JSON 键、多文档输入、NaN/Infinity 和无效 Unicode。
这些检查不是完整 PII/秘密识别器。Goal 及背景都不应放密钥、私人简历或完整聊天。

## 响应包装

每次处理生成独立 run_id，stdout 返回一个对象，字段为：

| 字段 | 含义 |
| --- | --- |
| protocol_version | 固定 `m2-entry-v0.1` |
| run_id | 此次进程操作 ID，不是 Controller 问题 ID |
| action | `plan` / `research`；命令参数错误时可能是 null |
| ok | 入口是否成功获得该操作的结果；不表示事实验证或计划批准 |
| data | `plan` 的原有输出，失败时 null |
| error | 失败时 `{code, message}`；成功时 null |
| metrics | Planner 函数尝试次数、是否新增知乎检索、入口自动重试标志 |

`data.status` 必须单独检查：

- `ready_for_review`：研究问题提案；human_approved 仍为 false。
- `needs_clarification`：应返回 Controller 请求澄清，不能继续搜索。
- `dry_run`：只是输入预览。

不要把 `ok: true` 当成证据生成成功；此版本根本不生成 EvidencePack。
`planner_calls_attempted` 只统计调用已有 plan_research 的尝试，不是 HTTP 成功次数或计费凭证。
自动重试标志描述入口行为，不是第三方服务商的内部实现保证。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 获得操作结果，包括需要澄清；`--help` 也返回 0 |
| 1 | 依赖、模型、内部执行或输出文件错误 |
| 2 | 命令参数、输入文件或请求不合法 |
| 3 | research 尚未接入 |
| 130 | 用户中断，服务端是否收到请求可能未知 |

错误只返回允许的类别和固定消息，不返回任意异常字符串或堆栈。
已有业务依赖自行打印的日志会被转入 stderr；这些日志仍应由模块维护者避免包含敏感信息。

## Jia 的 Server 调用

工作目录设为他的 `zhilu/packages/zhihu`；选择他本机安装了 M2 依赖的虚拟环境 Python。
参数：`-X utf8 -u -m zhihu_m2.pipeline --action plan`。
不要传 `--input`；改为往 stdin 写入上述请求的 UTF-8 JSON，并在写完后关闭 stdin。
入口按 EOF 读取，父进程不关闭输入就会一直等输入；超时和进程取消应由 Server 管理。

父进程分别收集 stdout 和 stderr，等输出结束后解析完整 stdout JSON，再检查退出码、ok 和 data.status。
不要把每个输出 chunk 单独当作一条 JSON，也不要将 stderr 拼进 stdout。
stderr 目前包含诊断内容，不是已定义的 SSE 协议，不应直接全部转发前端。

一次进程处理一次请求。CLI 使用的 redirect_stdout 会影响进程全局，不能把 main() 当作同进程多线程 HTTP handler。

## 本次日志与隐私

`--output` 保存最终请求结果，stderr 记录 run_id、动作、错误类别与尝试次数，不打印请求或原始异常。
此入口直接调用 plan_research，不调用旧 run_planner，所以不会自动保存旧 CLI 的 system_prompt/model_response 等完整 artifacts。
Jia 的调用方应保存必要运行元数据。包含用户背景的实际结果放 artifacts，确认已被 .gitignore 忽略，不提交真实凭据或私人输出。
本包的 example 只是演示输入，可用于联调。

## 下一步连接 research

先确定正式 ResearchRequest 和 EvidencePack 对象格式，核对实际 models.py / normalizer.py / 已有 plan_evidence.py，然后替换 `research()` 的明确失败逻辑。
不要让 research 收到具体子问题后再次从宽泛 goal 生成新问题。
需要按原始 source/snippet 保留引文、保留外部 ID 映射、执行数量与时效限制、区分无证据与调用失败。
不将原始知乎全文/整批 snippets 装入交给 Roadmapper 的 EvidencePack。
这部分尚未实现，也未通过完整 M2 P0 验收。

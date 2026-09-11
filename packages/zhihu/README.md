# Zhihu Knowledge

# Zhilu — 知乎知识模块

`packages/zhihu` 是 Zhilu 项目中的知乎知识模块，负责从用户的研究需求出发，检索知乎内容、筛选和整理证据，并最终向主 Agent 提供结构化的 `EvidencePack`。

当前模块属于 P0 开发范围。

## 1. 模块职责

知乎知识模块负责：

* Query 规划；
* 知乎内容检索；
* 知乎回答 / 文章读取；
* 搜索结果去重；
* 内容分类；
* 风险和证据限制标注；
* 搜索结果重排；
* Evidence Card 编译；
* Evidence Cache；
* Mock Provider；
* 真实知乎 Provider；
* 为 Evidence / Source Inspector 提供来源信息；
* 最终完成：

```text
ResearchRequest
      ↓
知乎知识模块
      ↓
EvidencePack
```

知乎模块只负责提供研究证据。

它**不负责**：

* 修改正式 `PlanState`；
* 直接修改 Roadmap；
* 创建计划 Commit；
* 决定用户最终采用哪条路线。

这些工作由 `agent-runtime`、`plan-engine` 和 `apps/server` 完成。

---

# 2. 在 Monorepo 中的位置

项目采用单仓库结构：

```text
zhilu/
├── apps/
│   ├── web/
│   └── server/
│
├── packages/
│   ├── contracts/
│   ├── plan-engine/
│   ├── agent-runtime/
│   └── zhihu/              ← 本模块
│
├── examples/
├── docs/
├── pnpm-workspace.yaml
└── README.md
```

知乎模块主要开发目录：

```text
packages/zhihu/
```

Python package 位于：

```text
packages/zhihu/zhihu_m2/
```

---

# 3. 当前模块结构

当前代码大致分为以下几层：

```text
packages/zhihu/
├── .env.example
├── .env                     # 本地配置，不提交 Git
├── tests/
│
└── zhihu_m2/
    ├── config.py
    ├── zhihu_client.py
    ├── llm_client.py
    ├── query_planner.py
    ├── plan_retrieval.py
    ├── ranker.py
    ├── evidence_compiler.py
    └── ...
```

主要模块职责：

### `config.py`

负责加载本地 `.env` 配置。

默认读取：

```text
packages/zhihu/.env
```

已经存在的系统环境变量优先于 `.env`。

---

### `zhihu_client.py`

负责调用知乎 CLI。

主要职责包括：

* 查找知乎 CLI；
* 执行知乎搜索；
* 验证搜索结果数量；
* 解析知乎 CLI 返回的 JSON；
* 处理 CLI 超时和异常；
* 避免在异常信息中直接泄露凭据或原始敏感内容。

---

### `llm_client.py`

负责调用 DeepSeek 模型。

当前用途主要包括：

* 接收 system prompt；
* 接收 user prompt；
* 请求 JSON Object 输出；
* 处理 HTTP / timeout / JSON 错误。

API Key 从本地环境中读取，不写入源码。

---

### `query_planner.py`

负责把研究任务拆分成：

```text
Research Question
      ↓
Search Query
```

例如：

```text
研究问题：
Python 初学者应该怎样学习 Agent 开发？

↓

搜索词：
Python Agent 新手 学习路线
```

---

### `plan_retrieval.py`

负责根据 Query Plan 执行实际检索。

主要负责：

```text
Query Plan
    ↓
知乎 Search
    ↓
保存 Raw Response
    ↓
整理 Retrieval Results
```

---

### `ranker.py`

负责对候选知乎结果进行筛选和排序。

排序时可以综合考虑：

* 与研究问题的相关性；
* 内容质量；
* 来源信息完整度；
* 内容是否适合当前用户条件；
* 风险和局限性。

---

### `evidence_compiler.py`

负责把单个知乎来源整理成结构化 Evidence Card。

Evidence Card 可以包含：

```text
source
claim
claim_type
supporting_quote
applies_when
applicability_basis
caveats
risk_flags
verification_status
```

Evidence Card 只是研究证据，不代表系统已经认可该建议。

---

# 4. 环境准备

## 4.1 进入模块目录

Windows PowerShell：

```powershell
cd C:\Users\<你的用户名>\Desktop\zhilu\packages\zhihu
```

例如：

```powershell
cd C:\Users\Kylee\Desktop\zhilu\packages\zhihu
```

---

## 4.2 创建 Python 虚拟环境

第一次运行：

```powershell
python -m venv .venv
```

激活：

```powershell
.\.venv\Scripts\Activate.ps1
```

确认当前 Python：

```powershell
python -c "import sys; print(sys.executable)"
```

正常情况下应该指向：

```text
zhilu\packages\zhihu\.venv\Scripts\python.exe
```

---

# 5. 安装依赖

如果仓库已经提供：

```text
requirements.txt
```

优先运行：

```powershell
python -m pip install -r requirements.txt
```

如果当前尚未统一依赖文件，至少需要：

```powershell
python -m pip install pytest httpx python-dotenv
```

其中：

* `pytest`：测试；
* `httpx`：模型 HTTP 请求；
* `python-dotenv`：读取 `.env`。

---

# 6. 配置 `.env`

真实 API Key 和授权信息**不能提交到 Git**。

项目提供：

```text
.env.example
```

第一次配置时：

```powershell
Copy-Item .env.example .env
```

然后打开：

```powershell
code .env
```

示例：

```dotenv
# DeepSeek API
DEEPSEEK_API_KEY=

# 可选：
# 如果知乎 CLI 不在默认路径，可以手动指定。
# ZHIHU_CLI_PATH=C:/path/to/zhihu-cli.exe

# 可选：
# 用于首次配置知乎 CLI 授权。
# 已经完成本机 CLI 授权时不需要长期保留。
# ZHIHU_ACCESS_SECRET=
```

填写真实值：

```dotenv
DEEPSEEK_API_KEY=你的真实APIKey
```

不要把真实 Key 填入：

```text
.env.example
README.md
Python 源码
tests/
examples/
```

---

# 7. DeepSeek 配置

代码通过：

```text
DEEPSEEK_API_KEY
```

读取模型 API Key。

可以在不输出真实 Key 的情况下检查配置：

```powershell
python -c "from zhihu_m2.config import load_local_env; import os; load_local_env(); print('DeepSeek configured:', bool(os.getenv('DEEPSEEK_API_KEY', '').strip()))"
```

输出：

```text
DeepSeek configured: True
```

只表示读取到了非空配置，并不代表 Key 一定有效。

---

## DeepSeek 真实连接测试

运行：

```powershell
python -m zhihu_m2.llm_client
```

注意：

**该命令会发送一次真实 API 请求。**

它不是离线测试。

---

# 8. 知乎 CLI 配置

知乎检索通过本机知乎 CLI 完成。

Windows 默认查找：

```text
%LOCALAPPDATA%\ZhihuCLI\current\zhihu-cli.exe
```

也可以在 `.env` 中指定：

```dotenv
ZHIHU_CLI_PATH=C:/path/to/zhihu-cli.exe
```

检查 Python 是否能够找到 CLI：

```powershell
python -c "from zhihu_m2.zhihu_client import get_cli_path; print(get_cli_path())"
```

---

# 9. 知乎授权

知乎授权属于**本机配置**，不会随着 Git 仓库自动传给其他开发者。

因此：

```text
git clone zhilu
```

不会自动获得其他成员的知乎授权。

如果当前电脑已经完成知乎 CLI 授权，不需要因为重新 clone 或切换目录再次授权。

可以检查：

```powershell
$cli = "$env:LOCALAPPDATA\ZhihuCLI\current\zhihu-cli.exe"

& $cli auth status
```

如果使用自定义 CLI 路径：

```powershell
$cli = python -c "from zhihu_m2.zhihu_client import get_cli_path; print(get_cli_path())"

& $cli auth status
```

---

## 首次授权

如果项目中存在：

```text
zhihu_m2/setup_zhihu_auth.py
```

可以先在本机 `.env` 中配置：

```dotenv
ZHIHU_ACCESS_SECRET=你的AccessSecret
```

然后运行：

```powershell
python -m zhihu_m2.setup_zhihu_auth
```

该操作只用于：

* 第一次配置；
* 更换授权；
* 修复失效的本机授权。

正常搜索时不应该每次重新写入授权。

---

# 10. 测试

## dotenv / 客户端离线测试

运行：

```powershell
python -m pytest tests/test_dotenv_integration.py -q
```

该测试设计为离线运行：

* 不使用个人 API Key；
* 不访问真实 DeepSeek；
* 不执行真实知乎 CLI；
* 使用临时配置和 Mock transport。

---

## 运行整个知乎模块测试

```powershell
python -m pytest tests -q
```

提交代码前建议至少保证：

```text
pytest exit code = 0
```

---

# 11. 测试真实知乎搜索

完成 CLI 安装和授权后，可以手动运行：

```powershell
python -c "from zhihu_m2.zhihu_client import search_zhihu; print(search_zhihu('Agent Engineer 学习路线', 3))"
```

该命令会调用真实知乎服务。

如果成功，将返回知乎搜索结果列表。

---

# 12. 配置优先级

配置采用以下优先级：

```text
当前进程已经存在的环境变量
        ↓
packages/zhihu/.env
```

因此：

```text
Windows 环境变量中已有 DEEPSEEK_API_KEY
```

时，即使 `.env` 中存在另一个值，程序也可能继续使用系统环境变量。

如果发现修改 `.env` 后配置没有变化：

1. 检查 Windows 环境变量；
2. 关闭正在运行的 Python / Server；
3. 重新打开终端；
4. 再次运行检查命令。

---

# 13. `.env` 与 Git 安全

真实 `.env` 必须被 Git 忽略。

项目根目录 `.gitignore` 应包含：

```gitignore
.env
.env.*
!.env.example
```

提交前检查：

```powershell
git status
```

以及：

```powershell
git diff --cached --name-only
```

不应该出现：

```text
packages/zhihu/.env
```

可以出现：

```text
packages/zhihu/.env.example
```

因为 `.env.example` 不包含真实 Secret。

---

# 14. 数据与隐私

以下内容不能提交到 Git：

* API Key；
* Access Secret；
* `.env`；
* 私人用户档案；
* 未脱敏用户数据；
* 未脱敏的知乎缓存；
* 包含真实 Secret 的日志；
* 本地虚拟环境；
* Python Cache。

例如：

```text
.env
.venv/
__pycache__/
.pytest_cache/
data/
```

都应保留在本地。

可复现且已经脱敏的 Demo Fixture 可以提交到：

```text
examples/
```

---

# 15. 与其他模块的关系

依赖关系：

```text
apps/server
     │
     ▼
packages/zhihu
     │
     ▼
packages/contracts
```

知乎模块不应该直接修改：

```text
plan-engine
agent-runtime
Roadmap state
```

模块之间通过共享 Schema 通信。

---

# 16. 目标接口

P0 最终目标是提供统一入口：

```text
ResearchRequest
      ↓
Zhihu Provider
      ↓
EvidencePack
```

调用方不应该需要知道内部执行了：

```text
query_planner
    ↓
plan_retrieval
    ↓
zhihu_client
    ↓
ranker
    ↓
evidence_compiler
```

对 `apps/server` 来说，理想使用方式类似：

```python
evidence_pack = provider.research(request)
```

内部实现可以继续拆分成多个模块。

---

# 17. Mock Provider 与真实 Provider

P0 需要同时支持：

```text
ResearchRequest
      │
      ├── Mock Provider
      │        ↓
      │   EvidencePack
      │
      └── Real Zhihu Provider
               ↓
          EvidencePack
```

两种 Provider 应遵守相同的输入和输出 Schema。

这样其他成员可以在没有真实知乎授权或模型 API Key 的情况下，通过 Mock Provider 开发和测试完整主流程。

---

# 18. 当前开发重点

当前知乎模块的主要工作包括：

### 已建立的基础能力

* 知乎 CLI 搜索；
* Query Plan；
* 批量检索；
* Raw Response 保存；
* Retrieval Results；
* 来源去重；
* Evidence 编译；
* DeepSeek JSON Client；
* `.env` 配置；
* CLI 路径配置；
* 敏感错误信息处理；
* 离线测试。

### 下一阶段 P0 重点

主要需要继续完成：

```text
ResearchRequest
        ↓
统一 Provider
        ↓
Query Planning
        ↓
Retrieval
        ↓
Ranking
        ↓
Evidence Compilation
        ↓
EvidencePack
```

并与：

```text
packages/contracts
```

中的正式 Schema 对齐。

---

# 19. Git 开发流程

整个项目的 Git 根目录是：

```text
zhilu/
```

不是：

```text
packages/zhihu/
```

开发知乎模块时：

```powershell
cd C:\Users\<你的用户名>\Desktop\zhilu
```

查看状态：

```powershell
git status
```

提交知乎模块：

```powershell
git add packages/zhihu
git status
```

提交前确认：

* `.env` 没有被提交；
* 测试通过；
* 没有意外加入 `.venv`；
* 没有真实用户数据。

Commit 示例：

```powershell
git commit -m "feat(zhihu): update knowledge provider"
```

然后：

```powershell
git push
```

如果是新 branch 第一次 push：

```powershell
git push -u origin <branch-name>
```

---

# 20. 常见问题

## `ModuleNotFoundError: No module named 'zhihu_m2'`

确认当前目录：

```powershell
cd C:\Users\<你的用户名>\Desktop\zhilu\packages\zhihu
```

然后：

```powershell
python -c "import zhihu_m2; print(zhihu_m2.__file__)"
```

---

## 找不到知乎 CLI

检查：

```powershell
python -c "from zhihu_m2.zhihu_client import get_cli_path; print(get_cli_path())"
```

如果 CLI 安装在非默认位置，在 `.env` 中设置：

```dotenv
ZHIHU_CLI_PATH=C:/path/to/zhihu-cli.exe
```

---

## DeepSeek 提示缺少 API Key

检查：

```powershell
python -c "from zhihu_m2.config import load_local_env; import os; load_local_env(); print(bool(os.getenv('DEEPSEEK_API_KEY', '').strip()))"
```

如果输出：

```text
False
```

检查：

```text
packages/zhihu/.env
```

中的：

```dotenv
DEEPSEEK_API_KEY=
```

是否已经填写。

---

## `.env` 修改后没有生效

可能存在系统环境变量覆盖 `.env`。

PowerShell：

```powershell
echo $env:DEEPSEEK_API_KEY
```

不要把该命令的真实输出截图或发送到公开聊天。

---

# 21. P0 完成标准

知乎模块的 P0 验收目标：

1. 同一个 `ResearchRequest` 可以发送给 Mock Provider 或真实 Provider；
2. 两种 Provider 都返回符合共享 Schema 的 `EvidencePack`；
3. Evidence Card 保留来源；
4. Evidence Card 包含摘要；
5. Evidence Card 包含内容类型；
6. Evidence Card 包含适用条件；
7. Evidence Card 包含风险 / 限制信息；
8. 其他模块不需要理解知乎模块内部文件结构；
9. 没有真实 API Key、Access Secret 或私人数据进入 Git；
10. 知乎模块不直接修改正式 Plan 或创建计划 Commit。


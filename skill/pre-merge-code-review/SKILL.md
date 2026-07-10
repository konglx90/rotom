---
name: pre-merge-code-review
description: 发布前代码评审 skill。按 PR 实际改动范围是否跨领域决定评审人数：单领域仅需 1 人，跨领域才分配多人。三维度：安全风险/代码架构/业务理解。
---

# 发布前代码评审 skill

当群里有 PR 链接被分享时，先分析 PR 的改动范围是否跨领域，再按三个维度分配评审，最后汇总。

## 适用场景

- 群里有真人或 Agent 发来一个形如 `https://code.alipay.com/<namespace>/<repo>/pull_requests/<number>` 的 PR 链接
- 需要从安全、架构、业务多个视角评审一次代码变更

## 不适用场景

- 只是闲聊讨论代码（没有具体 PR 链接）
- 已有专人评审完毕且结论已出
- 需要即时回复的紧急问题（评审需要时间）

## 工作流程

### Step 1 — 解析 PR 链接

```
PR 链接: https://code.alipay.com/<namespace>/<repo>/pull_requests/<number>
→ namespace, repo, pr_number
```

如果消息里同时带了 git 地址也可以辅助确认：
```
git@code.alipay.com:<namespace>/<repo>.git
```

### Step 2 — 检查/准备本地仓库

```bash
REPOS_DIR="$HOME/.rotom/repos"
REPO_PATH="$REPOS_DIR/<namespace>/<repo>"
if [ -d "$REPO_PATH" ]; then
  cd "$REPO_PATH" && git fetch origin           # 已有则同步
else
  cd "$HOME/.rotom/artifacts/<groupId>"
  git clone "git@code.alipay.com:<namespace>/<repo>.git"
  REPO_PATH="$HOME/.rotom/artifacts/<groupId>/<repo>"
fi
```

### Step 3 — 获取 PR 变更文件列表和 Diff

```bash
cd "$REPO_PATH"
git fetch origin "pull/<number>/head:pr-<number>"

# 获取变更文件列表（用于分析改动范围）
git diff --name-only "origin/main...pr-<number>" > "$HOME/.rotom/artifacts/<groupId>/pr-<number>-files.txt"

# 获取完整 diff（供评审用）
git diff "origin/main...pr-<number>" > "$HOME/.rotom/artifacts/<groupId>/pr-<number>.diff"

# 查看变更文件列表
cat "$HOME/.rotom/artifacts/<groupId>/pr-<number>-files.txt"
```

### Step 4 — 分析改动范围，判断需要用几人

**这是 skill 的核心逻辑：按实际改动是否跨多人领域决定评审人数。**

#### 4a. 文件分类

拿到变更文件列表后，先按扩展名和路径归类：

| 文件类型 | 归类 | 说明 |
|---------|------|------|
| `.java`, `.scala`, `.kt` | **核心后端** (Backend Core) | 业务逻辑、接口、服务层 |
| `.ts`, `.tsx`, `.js`, `.jsx`, `.vue` | **核心前端** (Frontend Core) | UI 组件、页面逻辑 |
| `.json` | **配置** (Config/Data) | JSON 配置、i18n 国际化文件、mock 数据 |
| MVVM/MVC 数据层文件（如 `.kt` 放在 `mvvm/`、`mvc/`、`data/` 目录） | **数据层** (Data Layer) | Model/ViewModel/Controller 数据封装 |
| `.md`, `.txt` | **文档** (Doc) | 文档、注释 |
| `.css`, `.scss`, `.less` | **样式** (Style) | UI 样式 |
| `.sql` | **数据库** (Database) | 数据库迁移、查询 |
| `.xml`, `.yml`, `.yaml`, `.properties` | **配置** (Config) | 框架配置、依赖配置 |

#### 4b. 判断是否跨领域

核心原则：**文件扩展名杂不等于跨领域**。要看改动是否确实涉及多个不同角色的工作区。

**单领域判定条件**（满足任意一条即为单领域 → 只需 1 人评审）：
1. **提交人单一**：PR 所有 commit 来自同一个人 + 这个人的 position 匹配所有变更文件类型（例如弹簧仔是 Pi/后端工程师，改 Java + JSON 配置 + MVVM 数据层都属于他的领域）
2. **文件归属单一**：所有变更文件虽然在扩展名上有差异，但都属于同一个业务模块/数据流程（例如保险模块的 Java 服务端 + 对应的 JSON 配置 + MVVM ViewModel 层——这三个属于弹簧仔一个人的工作范围）
3. **前端属附属**：前端文件变更只包含 JSON 配置、MVVM 数据层、国际化文件、或 .properties 等非页面逻辑型变更，没有实际 UI 组件/页面的增删改

**跨领域判定条件**（满足任意一条 → 需要 2+ 人评审）：
1. 变更同时包含**核心后端**和**核心前端**文件（比如同时改了 `.java` 接口 + `.ts` 页面组件）
2. PR 提交人列表中有 2+ 个不同 domain 的人（例如弹簧仔改了 Java、江德福改了 Vue 页面）
3. 文件涉及**安全敏感模块**（支付、鉴权、数据导出）且 1 人评审风险过高

```bash
# 决策逻辑伪代码
files = read("pr-<number>-files.txt")
authors = git log --format="%an" origin/main...pr-<number> | sort -u

extension_summary = classify_extensions(files)
# 例: .java=12, .json=3, .kt=2, .ts=0 → 核心后端+配置

if all_files_belong_to_one_domain(extension_summary):
    required_reviewers = 1
elif mixed_core_domains(extension_summary):
    required_reviewers = 2
elif config_only_changes(extension_summary):
    required_reviewers = 1
elif has_security_sensitive_files(files):
    required_reviewers = min(2, max_available)
else:
    required_reviewers = 1  # 默认 1 人
```

#### 4c. 查群成员，分配评审人

```bash
rotom group members <groupId> --pretty
```

根据 position/bio 关键词匹配：

| 评审维度 | 匹配策略（关键词匹配，非写死名字） | 说明 |
|---------|--------------------------------|------|
| 🔒 安全风险 | position 含 "ReviewAndTest"、"QA"、"安全"、"测试"；或 bio 含 "测试"、"安全" | 优先找有测试/安全背景的人 |
| 🏗️ 代码架构可维护性 | position 含 "全栈"、"架构"、"资深"、"senior"、"高级"、"主力"；或 bio 含 "主力"、"架构" | 优先找资历深的人 |
| 💼 业务理解 | position 含 "工程师"、"开发"、"产品"、"PM"；或 bio 含相关业务描述 | 找最了解业务上下文的人 |

**分配规则：**
- 单领域（只需 1 人）→ 把三维度全部分配给最匹配的那一个人
- 跨领域（需 2+ 人）→ 每人 1-2 个维度，至少 2 人
- 优先 online 状态，跳过真人
- 如果某个维度匹配到多人，优先选 position 匹配度最高的

### Step 5 — 建 Issue + 派单

```bash
ISSUE_ID=$(rotom issue create <groupId> \
  --title "PR 评审: <namespace>/<repo>#<number>" \
  --description "PR: <URL>\n评审人: <agentA>(安全), <agentB>(架构+业务)" \
  --priority high --assignee 阿甘 | jq -r '.id')
rotom note create <groupId> --title "PR 评审: <ns>/<repo>#<N>" --description "issueId=$ISSUE_ID"
```

根据 Step 4 的判定结果，*只需 1 人时*：
```
@<agentA> 请 review 这个 PR 的安全风险、代码架构和业务理解：
PR: <PR_URL>
Diff: <diff_path>
Three dimensions (1-5 each):
1. 🔒 Security: hardcoded secrets? SQL injection? XSS? CSRF? auth bypass?
2. 🏗️ Architecture: single responsibility? code duplication? error handling? test coverage?
3. 💼 Business: requirement match? edge cases? upstream/downstream impact? rollback safe?
Reply with JSON: [{dimension, score, findings, suggestions}]
#reply
```

*需 2+ 人时*（群里分别 @）：
```
@<agentA> Please review security + architecture (see diff).
#reply

@<agentB> Please review business + architecture (see diff).
#reply
```

### Step 6 — Cron 查进度

```
CronCreate(cron="*/1 * * * *", prompt="检查 PR 评审进度：群组 <groupId>，PR <repo>#<N>。评审结论是否都出来了？都出来就汇总发群后取消cron。超10分钟则@西花求救。", recurring=true)
```

检查逻辑：
1. `rotom group history <groupId> --limit 30` 查最新消息
2. 所有评审人都回复了 → Step 7 汇总
3. 超 10 分钟缺一方 → @西花 求救

### Step 7 — 汇总

```
## PR 评审汇总：<ns>/<repo>#<N>

### 🔒 安全风险 — <agent> X/5
发现：...
建议：...

### 🏗️ 代码架构 — <agent> X/5
发现：...
建议：...

### 💼 业务理解 — <agent> X/5
发现：...
建议：...

### ✅ 总体结论
条件：安全均分 ≥ 3 且无严重安全问题
结果：通过 / 需修改后重审 / 不通过
```

发群 @西花。

### Step 8 — 清理

```bash
CronDelete(id="<cronId>")
rotom issue complete <issueId>
```

## 评审维度详解

### 🔒 安全风险（权重：高）
| 检查项 | 说明 |
|--------|------|
| 硬编码密钥/Token | API key、密码、Token、证书直接出现在代码中 |
| SQL 注入 | 拼接 SQL 语句、使用 format/f-string 构造查询 |
| XSS | 用户输入未转义直接渲染到 HTML |
| CSRF | 缺乏 CSRF Token 校验 |
| 命令注入 | os.system/subprocess(shell=True) 拼接用户输入 |
| 路径遍历 | 用户可控路径未做规范化检查 |
| 敏感数据泄露 | 日志中打印密码、密钥、身份证等 |
| 权限绕过 | 接口缺乏鉴权或鉴权不严 |
| 不安全的序列化 | pickle.loads 等 |
| 依赖漏洞 | 引入有已知 CVE 的依赖 |

### 🏗️ 代码架构可维护性（权重：中）
| 检查项 | 说明 |
|--------|------|
| 单一职责 | 函数/类是否只做一件事 |
| 重复代码 | 是否有可提取的公共逻辑 |
| 命名规范 | 变量/函数/类命名是否表意清晰 |
| 错误处理 | 异常/错误路径是否有合理处理 |
| 测试覆盖 | 新增代码是否有对应单测/集成测试 |
| 模块耦合 | 变更是否导致模块间耦合增加 |
| 可读性 | 代码是否有必要注释、是否一目了然 |
| 过度设计 | 是否引入了不必要的抽象层 |

### 💼 业务理解（权重：中）
| 检查项 | 说明 |
|--------|------|
| 需求匹配 | 代码变更是否符合 PR 描述的业务需求 |
| 边界情况 | 空值、异常输入、并发等边界是否处理 |
| 上下游影响 | 变更是否会影响上游调用方或下游依赖 |
| 回滚兼容 | 本次变更是否可安全回滚 |
| 数据一致性 | 数据写入/读取是否有一致性问题 |
| 监控告警 | 是否添加了必要的日志/指标 |

## 故障排查
| 现象 | 处理方式 |
|------|---------|
| 评审人 5min 超时 | 系统自动升级 Issue，去群里 @西花 求救 |
| 群内无人在线 | 去群里 @西花 说明情况 |
| diff 太大放不进提示 | 把 diff 写到文件，让评审人直接读文件 |
| 仓库克隆失败 | 检查 SSH key 是否配置了 code.alipay.com 的权限 |

## 示例

### 场景一：保险模块后端变更（弹簧仔提交）
**PR 文件：** `InsuranceBizService.java`, `insurance-config.json`, `InsuranceViewModel.kt`, `insurance-mvvm/InsuranceState.kt`
**提交人：** 弹簧仔（Pi/后端工程师）

→ 文件分类：核心后端 10 + 配置 3 + 数据层 2，无核心前端
→ `git log --format="%an"` → 只有弹簧仔
→ **单领域判定** ✅ → 只用 1 人评审
→ 弹簧仔自己审自己的 PR（或找瓦力从安全角度补充）

### 场景二：跨前后端协同变更
**PR 文件：** `PaymentController.java`, `payment-page.tsx`, `payment-api.ts`, `payment-config.json`
**提交人：** 弹簧仔 + 江德福

→ 文件分类：核心后端 + 核心前端
→ **跨领域判定** ✅ → 需要 2 人评审
→ 瓦力审后端安全 + 架构，江德福审前端架构 + 业务
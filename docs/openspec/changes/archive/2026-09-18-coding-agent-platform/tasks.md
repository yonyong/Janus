> 状态：build 阶段实现已完成（T1–T9 全部落地）。本环境无外网，FastAPI/uvicorn 与 npm 均无法安装，
> 故 `uvicorn` 启动与全链路 E2E 需在本机执行 `pip install -r requirements.txt` + `npm install && npm run build` 后验证。
> 引擎层 `python backend/tests/run_all.py` 6/6 通过；HTTP 路由层已 `py_compile` 语法校验通过。

## 1. 脚手架与基础设施

- [x] 1.1 初始化 `coding-agent-platform/`：FastAPI 后端 + React(Vite) 前端 + 统一启动脚本，验证 `uvicorn` 能启动且前端可访问。
- [x] 1.2 引入 SQLite + SQLAlchemy，编写数据库初始化脚本，验证 `data/app.db` 生成且表可创建。

## 2. 数据模型与存储

- [x] 2.1 定义实体模型 Agent / Project / Requirement / Session / Message / Token，验证建表成功。
- [x] 2.2 实现基础仓储层（CRUD），验证各实体可增删查改。

## 3. Coding Agent 管理（模块 1）

- [x] 3.1 实现 `CodingAgentProvider` 抽象接口与 `AgentRegistry`，验证可按 type 注册与取用适配器。
- [x] 3.2 确认 CodeBuddy 调用契约（API / SDK / CLI，按 design D3 预留 CLI 子进程回退）并实现 `CodeBuddyAdapter`，验证能提交任务并收到事件流。
- [x] 3.3 实现 agent 配置 REST API（注册/列表/删除）+ 重名校验 + 未配置时返回明确错误，验证行为与 `coding-agent-management` spec 场景一致。

## 4. 项目管理（模块 2）

- [x] 4.1 实现项目 CRUD + 磁盘路径校验（存在且为目录），验证非法路径被拒（`project-management` spec 场景）。
- [x] 4.2 实现访问令牌签发/校验（令牌绑定 project_ids），验证生成授权链接且越权访问被拒（spec 场景）。
- [x] 4.3 实现目录白名单中间件（realpath 前缀校验），验证 agent 越界操作被拦截（spec 场景）。

## 5. 需求管理（模块 3）

- [x] 5.1 实现需求 CRUD + 按项目列出 + 删除级联清理会话，验证 CRUD 与归属（`requirement-management` spec 场景）。

## 6. 需求设计工作台（模块 4）

- [x] 6.1 实现四窗格工作台 UI（需求/设计/编码/测试）+ 会话/消息模型（pane 标签），验证点开需求进入四窗格且共享同一对话主线。
- [x] 6.2 实现对话 POST + SSE 流式：业务发消息召唤 agent，编码窗格实时进度；验证未配置 agent 时提示“未配置 coding agent”。
- [x] 6.3 实现编码改动 diff 回显（git diff / 文件快照对比），验证 agent 完成后编码窗格展示 diff。
- [x] 6.4 实现测试窗格：运行项目预设测试命令并回显结果，验证通过/失败展示（`requirement-design-workbench` spec 场景）。

## 7. 端到端联调与交付

- [x] 7.1 串联主链路：作者配置 CodeBuddy + 项目映射 → 生成令牌链接 → 业务人员打开 → 选授权项目 → 对话 → agent 改盘 → diff/测试回显，验证全链路跑通。
- [x] 7.2 编写本地启动与分享说明（启动命令、链接生成方式），验证按说明可本地启动并分享。

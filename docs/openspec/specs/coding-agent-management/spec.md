# coding-agent-management Specification

## Purpose
让平台以可插拔方式登记并调用多个 coding agent（本轮先实现 CodeBuddy），供需求设计工作台召唤其对目标项目代码执行改动。

## Requirements

### Requirement: 注册 coding agent 配置
平台 SHALL 允许作者注册一个 coding agent，包含唯一名称、类型（如 codebuddy）与连接配置（端点 / 令牌 / 参数）。

#### Scenario: 成功注册
- **WHEN** 作者提交 name=codebuddy、type=codebuddy 及连接配置
- **THEN** 系统保存该 agent 配置并可在列表中查询

#### Scenario: 重名拒绝
- **WHEN** 作者提交一个已存在的 agent name
- **THEN** 系统拒绝并返回名称冲突错误

### Requirement: 编辑 coding agent 配置
平台 SHALL 允许管理员修改已注册 agent 的名称、类型与连接配置，未提交的字段保持不变，且名称仍须唯一。

#### Scenario: 修改 agent 配置
- **WHEN** 管理员提交该 agent 的新名称、类型或连接配置
- **THEN** 系统更新该 agent 记录并返回最新配置，未提交的字段保持原值

#### Scenario: 改成已存在名称时拒绝
- **WHEN** 管理员把 agent 名称改成另一个已存在的名称
- **THEN** 系统拒绝并返回名称冲突错误，原配置保持不变

#### Scenario: 空名称或空类型拒绝
- **WHEN** 管理员提交空的名称或空的类型
- **THEN** 系统拒绝并提示该字段不能为空

#### Scenario: 编辑与注册同权限
- **WHEN** 管理员口令已启用，而请求方仅持访问令牌
- **THEN** 系统拒绝编辑并返回未授权

### Requirement: 可插拔执行引擎
平台 SHALL 通过统一的 provider 接口调用 coding agent，使新增 agent 类型（如 Cursor）时无需改动工作台代码。

#### Scenario: 通过统一接口召唤
- **WHEN** 工作台请求用某 agent 执行编码任务
- **THEN** 平台经 provider 接口把任务交付给对应适配器，工作台不感知具体 agent 类型

### Requirement: CodeBuddy 适配器
平台 SHALL 提供 CodeBuddy 适配器实现 provider 接口，将平台任务转换为 CodeBuddy 调用并回传进度与结果。

#### Scenario: 编码任务流转
- **WHEN** 工作台向 CodeBuddy 适配器提交（项目路径, 需求描述）
- **THEN** 适配器调用 CodeBuddy，并在工作台回显进度与结果

#### Scenario: CLI 子进程调用
- **WHEN** 适配器以子进程方式启动 CodeBuddy CLI 并传入（项目路径, 对话上下文）
- **THEN** 适配器解析 CLI 的 stdout 事件流（message/edit/test/status）并回传平台

### Requirement: 一键连通性测试
平台 SHALL 允许作者对任一已注册 agent 发起一次探针调用（默认消息「你好」），返回是否可用、耗时与事件流，且不得改动真实项目代码或产生会话数据。

#### Scenario: 探测成功
- **WHEN** 作者对某 agent 触发一键测试
- **THEN** 平台经 provider 接口真实调用该 agent（工作目录为一次性临时目录），返回成功、耗时与事件流

#### Scenario: 探测失败
- **WHEN** 调用失败（类型未注册 / CLI 不存在 / 非 0 退出 / agent 返回 error 事件 / 无任何事件）
- **THEN** 平台返回失败并给出具体原因，供作者据此修正配置

#### Scenario: 探测超时
- **WHEN** agent 在超时窗口（默认 30s）内未返回
- **THEN** 平台终止本次探测（含回收子进程）并返回超时失败

### Requirement: 未配置 agent 时明确提示
当没有任何 coding agent 被配置时，平台 SHALL 拒绝工作台的编码请求并给出清晰提示，而非静默失败。

#### Scenario: 无 agent 配置
- **WHEN** 业务人员发起编码但平台未配置任何 agent
- **THEN** 系统提示“未配置 coding agent”并终止该请求

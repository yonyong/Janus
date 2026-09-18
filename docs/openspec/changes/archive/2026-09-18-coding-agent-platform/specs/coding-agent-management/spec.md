## Purpose

让平台以可插拔方式登记并调用多个 coding agent（本轮先实现 CodeBuddy），供需求设计工作台召唤其对目标项目代码执行改动。

## ADDED Requirements

### Requirement: 注册 coding agent 配置
平台 SHALL 允许作者注册一个 coding agent，包含唯一名称、类型（如 codebuddy）与连接配置（端点 / 令牌 / 参数）。

#### Scenario: 成功注册
- **WHEN** 作者提交 name=codebuddy、type=codebuddy 及连接配置
- **THEN** 系统保存该 agent 配置并可在列表中查询

#### Scenario: 重名拒绝
- **WHEN** 作者提交一个已存在的 agent name
- **THEN** 系统拒绝并返回名称冲突错误

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

### Requirement: 未配置 agent 时明确提示
当没有任何 coding agent 被配置时，平台 SHALL 拒绝工作台的编码请求并给出清晰提示，而非静默失败。

#### Scenario: 无 agent 配置
- **WHEN** 业务人员发起编码但平台未配置任何 agent
- **THEN** 系统提示“未配置 coding agent”并终止该请求

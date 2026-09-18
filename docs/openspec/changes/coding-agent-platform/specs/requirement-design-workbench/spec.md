## Purpose

为单个需求提供「需求 / 设计 / 编码 / 测试」四窗格对话工作台，业务人员通过对话召唤 coding agent 改动目标项目代码并回显结果，直至满足业务需求。

## ADDED Requirements

### Requirement: 四窗格对话空间
平台 SHALL 为单个需求提供含「需求 / 设计 / 编码 / 测试」四个上下文窗格的工作台，四窗格共享同一条对话主线。

#### Scenario: 打开工作台
- **WHEN** 业务人员点开某需求
- **THEN** 进入四窗格工作台，四窗格共享同一对话主线

### Requirement: 召唤 coding agent 编码
平台 SHALL 允许业务人员在对话中触发编码，召唤已配置的 coding agent 对需求所属项目代码执行修改，并把进度流式送入「编码」窗格。

#### Scenario: 发起编码
- **WHEN** 业务人员在对话中描述编码需求并触发编码
- **THEN** 平台调用 coding agent 对映射项目执行改动，编码窗格实时显示进度

### Requirement: 改动与测试回显
平台 SHALL 在「编码」窗格展示代码 diff / 改动，在「测试」窗格展示测试执行结果。

#### Scenario: 回显改动
- **WHEN** coding agent 完成一轮改动
- **THEN** 编码窗格展示 git diff，测试窗格展示由 agent 自行执行并回传的验证结果（通过 / 失败）

#### Scenario: agent 自主判断编码
- **WHEN** 业务发送一条对话消息
- **THEN** 平台将其转发给 coding agent CLI，由 CLI 自主决定是否修改代码，无需显式「编码」按钮

#### Scenario: 迭代至满足
- **WHEN** 测试未通过或业务不满意
- **THEN** 业务可继续对话要求修改，循环直至满足需求

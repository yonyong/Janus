# requirement-management Specification

## Purpose
在项目之下组织需求，作为需求设计工作台的工作单元（一个需求 = 一个对话空间）。

## Requirements

### Requirement: 需求 CRUD
平台 SHALL 允许作者在项目下新增、查看、编辑、删除需求。

#### Scenario: 创建需求
- **WHEN** 作者在某项目下新建需求并填写标题与描述
- **THEN** 该需求出现在该项目需求列表中

#### Scenario: 删除级联
- **WHEN** 作者删除某需求
- **THEN** 其关联的工作台会话与记录一并清除

### Requirement: 需求归属
每个需求 SHALL 仅归属于一个项目，并可在该项目内被列出。

#### Scenario: 按项目列出
- **WHEN** 查看某项目
- **THEN** 仅展示该项目下的需求

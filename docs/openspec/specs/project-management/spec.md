# project-management Specification

## Purpose
维护「项目 ↔ 本地磁盘目录」映射，并通过访问令牌控制业务人员对项目的可访问范围（链接令牌免登录）。

## Requirements

### Requirement: 项目磁盘映射
平台 SHALL 为每个项目记录名称与对应的本地绝对目录路径，且后续仅允许访问该目录。

#### Scenario: 创建映射
- **WHEN** 作者创建项目并指定本地目录 D:/projects/foo
- **THEN** 系统记录映射，且该项目的所有文件操作限定在此目录内

#### Scenario: 非法路径拒绝
- **WHEN** 作者指定的路径不存在或不是目录
- **THEN** 系统拒绝创建并提示路径无效

### Requirement: 访问令牌授权
平台 SHALL 签发绑定到一组被授权项目的访问令牌；持有有效令牌的业务用户只能看到这些项目。

#### Scenario: 生成授权链接
- **WHEN** 作者为若干项目生成访问令牌
- **THEN** 系统返回含令牌的链接，该令牌仅能访问这些项目

#### Scenario: 越权不可见
- **WHEN** 业务人员持令牌访问其未被授权的项目
- **THEN** 系统拒绝并返回无权限

### Requirement: 目录访问白名单
平台与 coding agent SHALL 仅读写已映射的项目目录，任何越界访问均被拦截。

#### Scenario: 越权路径拦截
- **WHEN** agent 尝试读写映射目录之外的路径
- **THEN** 平台拒绝该操作并记录告警

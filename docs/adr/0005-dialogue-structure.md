# 对话结构：个人独立 AgentSession + 团队共享 Pi（演进到方案 B）

个人对话 = 每员工独立 AgentSession（常驻）；团队对话 = 一个共享 AgentSession。最终目标方案 B：Pi 作为可发言的团队成员，通过 pi-intercom 通信。

**背景**: 需要个人对话隔离 + 团队协作对话。对话结构影响 AgentSession 数量和消息架构。

**决策**: POC 用方案 A（Pi 是助手）：个人=独立 AgentSession，团队=共享 Pi。架构预留方案 B（Pi 可发言）：团队消息用统一事件流，Pi 接入即加订阅者。

**后果**: POC 简单清晰（每员工一个常驻 AgentSession）；方案 B 需团队对话从"消息流"演进为"事件总线"，Pi 作为订阅者接入。

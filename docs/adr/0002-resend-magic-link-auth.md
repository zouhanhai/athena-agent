# Resend 邮箱魔法链接认证

认证用邮箱魔法链接，通过 Resend API 发信。

**背景**: 公司邮箱是 Outlook (Microsoft 365)，但 SMTP AUTH 被租户禁用（普通密码和应用密码都返回 535）。无法用公司 SMTP 发信。

**决策**: 用 Resend API 发魔法链接（key 已验证有效）。绕过 Outlook SMTP 限制，免费额度够 POC，不依赖公司 IT。

**后果**: 需在 Resend 验证 caleo.com 域名才能发员工；POC 阶段只能发给自己（zouhanhai@live.com）。

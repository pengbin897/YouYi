/**
 * 远程放行的安全护栏。
 *
 * 产品决策：微信远程放行是核心价值，但不能无限放行。这里把「一旦做错就无法挽回」
 * 的操作挡在远程之外，强制用户回电脑确认。判定宁可保守——误挡一次只是多走几步，
 * 误放一次可能丢数据、泄密或产生真实世界后果。
 */

export interface RiskAssessment {
  highRisk: boolean
  reason?: string
}

interface RiskRule {
  pattern: RegExp
  reason: string
}

/** 命中即禁止远程放行 */
const HIGH_RISK_RULES: RiskRule[] = [
  // 不可逆的批量删除
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, reason: '包含递归/强制删除' },
  { pattern: /\brmdir\s+\/s\b|\bdel\s+\/[sq]\b|Remove-Item[^|\n]*-Recurse/i, reason: '包含递归删除' },
  { pattern: /\bmkfs\b|\bdd\s+if=|\bdiskutil\s+erase/i, reason: '包含磁盘擦除操作' },
  { pattern: /:\(\)\s*\{.*\};\s*:/, reason: '疑似 fork 炸弹' },

  // 把改动推向他人可见的地方，撤回成本高
  { pattern: /\bgit\s+push\b(?![^\n]*--dry-run)/, reason: '会把改动推送到远端仓库' },
  { pattern: /\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f/, reason: '会丢弃未提交的改动' },
  { pattern: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/, reason: '会发布软件包' },
  { pattern: /\b(kubectl|helm)\s+(apply|delete|upgrade|rollout)\b/, reason: '会变更线上集群' },
  { pattern: /\b(terraform|pulumi)\s+(apply|destroy)\b/i, reason: '会变更云端基础设施' },
  { pattern: /\baws\s+|\bgcloud\s+|\baz\s+/, reason: '会操作云服务账号' },

  // 涉钱、涉密
  { pattern: /支付|付款|转账|下单|退款|payment|checkout|transfer/i, reason: '涉及资金操作' },
  {
    pattern: /\.env\b|id_rsa|\.pem\b|credentials|secret|token|password|私钥|密钥/i,
    reason: '涉及密钥或凭据文件'
  },

  // 权限提升
  { pattern: /\bsudo\b|\bsu\s+-|runas\s+\/user:/i, reason: '需要管理员权限' },
  { pattern: /\bchmod\s+777\b|\bchown\s+.*root/, reason: '会放宽系统权限' },

  // 群发类操作，误发无法收回
  { pattern: /发送(全部|所有|群发)|broadcast|mass\s*email/i, reason: '疑似群发操作' }
]

/** 这些工具本身只读，不需要走高危判定 */
const READONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch'])

export function assessRisk(toolName: string, requestText: string): RiskAssessment {
  if (READONLY_TOOLS.has(toolName)) return { highRisk: false }

  const text = requestText ?? ''
  for (const rule of HIGH_RISK_RULES) {
    if (rule.pattern.test(text)) {
      return { highRisk: true, reason: rule.reason }
    }
  }
  return { highRisk: false }
}

/** 高危请求推给用户时附带的说明，让「为什么不能远程放行」是清楚的 */
export function highRiskNotice(reason: string): string {
  return `这个操作${reason}，出于安全考虑不能在微信里放行，需要你回到电脑上确认。`
}

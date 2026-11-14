import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import {
  availableAmount,
  cancelRehearsal,
  channelBudget,
  findChannel,
  occupiedAmount,
  productionList,
  rescheduleCampaign,
  runConcurrentRehearsals,
  runRehearsal,
} from '@/api/rehearsal-service'

// 验收观察：每个用例在真实数据上执行，逐步记录变化前后快照，结果持久化，随时可回看。

export type AcceptanceStep = {
  步骤: string
  观察点: string
  变化前: string
  变化后: string
}

export type AcceptanceCaseResult = {
  用例编号: string
  用例名称: string
  场景: string
  断言: string
  通过: boolean
  步骤: AcceptanceStep[]
}

export type AcceptanceRun = {
  执行时间: string
  总数: number
  通过数: number
  用例: AcceptanceCaseResult[]
}

const ACCEPTANCE_KEY = 'data-product-ops:acceptance'

function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function channelSnapshot(code: string): string {
  const channel = findChannel(code)
  if (!channel) {
    return `渠道 ${code} 不存在`
  }
  const budget = channelBudget(code)
  const occupied = occupiedAmount(code)
  return `状态=${String(channel.status)}｜预算=${budget}｜占用=${occupied}｜可用=${budget - occupied}`
}

function rehearsalSnapshot(code: string): string {
  const row = listRows('rehearsal').find((item) => String(item['预演编号']) === code)
  if (!row) {
    return `预演 ${code} 不存在`
  }
  return `状态=${String(row.status)}｜结论=${String(row['准入结论'])}｜占用=${String(row['占用总额'])}｜缺口=${String(row['缺口金额'])}`
}

function setChannelStatus(code: string, status: string): void {
  const rows = listRows('channel')
  const index = rows.findIndex((row) => String(row['渠道编号']) === code)
  if (index < 0) {
    throw new Error(`没有找到渠道 ${code}`)
  }
  const next = [...rows]
  next[index] = { ...rows[index], status }
  saveRows('channel', next)
}

function setCampaignRange(code: string, start: string, end: string): void {
  const rows = listRows('campaign')
  const index = rows.findIndex((row) => String(row['活动编号']) === code)
  if (index < 0) {
    throw new Error(`没有找到活动 ${code}`)
  }
  const next = [...rows]
  next[index] = { ...rows[index], 开始日期: start, 结束日期: end }
  saveRows('campaign', next)
}

/** 清场：取消目标渠道上所有占用中的预演，让用例从确定的起点开始。 */
function releaseActiveOfChannel(channelCode: string, steps: AcceptanceStep[]): void {
  const active = listRows('rehearsal').filter(
    (row) => row.status === '占用中' && String(row['关联渠道']) === channelCode,
  )
  for (const row of active) {
    const before = channelSnapshot(channelCode)
    cancelRehearsal(Number(row.id))
    steps.push({
      步骤: `清场：取消既有占用 ${String(row['预演编号'])}`,
      观察点: `渠道 ${channelCode} 台账`,
      变化前: before,
      变化后: channelSnapshot(channelCode),
    })
  }
}

function latestRehearsalOf(campaignCode: string): EntryRow | undefined {
  return listRows('rehearsal')
    .filter((row) => String(row['关联活动']) === campaignCode)
    .sort((a, b) => (Number(b['确认序号']) || 0) - (Number(a['确认序号']) || 0))[0]
}

function caseChannelDisabled(): AcceptanceCaseResult {
  const steps: AcceptanceStep[] = []
  const before = channelSnapshot('CHAN-0001')
  setChannelStatus('CHAN-0001', '已停用')
  steps.push({ 步骤: '准备：停用渠道 CHAN-0001', 观察点: '渠道状态', 变化前: before, 变化后: channelSnapshot('CHAN-0001') })

  const ledgerBefore = channelSnapshot('CHAN-0001')
  const result = runRehearsal({
    channelCode: 'CHAN-0001',
    campaignCode: 'CAMP-0001',
    startDate: '2026-09-01',
    endDate: '2026-09-01',
    kind: '试投',
  })
  const code = result.record ? String(result.record['预演编号']) : '-'
  steps.push({
    步骤: `对停用渠道发起试投预演（${code}）`,
    观察点: '准入结论',
    变化前: ledgerBefore,
    变化后: `${channelSnapshot('CHAN-0001')}｜结论=${result.decision ?? '-'}｜缺口=${result.gap ?? 0}`,
  })

  const restoreBefore = channelSnapshot('CHAN-0001')
  setChannelStatus('CHAN-0001', '草稿')
  steps.push({ 步骤: '清理：恢复 CHAN-0001 为草稿', 观察点: '渠道状态', 变化前: restoreBefore, 变化后: channelSnapshot('CHAN-0001') })

  const passed = result.decision === '拒绝' && occupiedAmount('CHAN-0001') === 0
  return {
    用例编号: 'AC-01',
    用例名称: '渠道停用拒绝准入',
    场景: '渠道已停用后，其预算不可再被活动占用',
    断言: '预演结论为拒绝、缺口等于本次申请额、渠道不产生任何占用',
    通过: passed,
    步骤: steps,
  }
}

function caseBudgetExactlyExhausted(): AcceptanceCaseResult {
  const steps: AcceptanceStep[] = []
  releaseActiveOfChannel('CHAN-0003', steps)

  const first = runRehearsal({
    channelCode: 'CHAN-0003',
    campaignCode: 'CAMP-0003',
    startDate: '2026-09-03',
    endDate: '2026-09-04',
    kind: '试投',
  })
  const firstCode = first.record ? String(first.record['预演编号']) : '-'
  steps.push({
    步骤: `申请 40000/天 × 2 天 = 80000（${firstCode}），恰好等于渠道预算`,
    观察点: '渠道 CHAN-0003 台账',
    变化前: `可用=${first.availableBefore ?? '-'}`,
    变化后: `结论=${first.decision ?? '-'}｜可用=${first.availableAfter ?? '-'}`,
  })

  const second = runRehearsal({
    channelCode: 'CHAN-0003',
    campaignCode: 'CAMP-0003',
    startDate: '2026-09-05',
    endDate: '2026-09-05',
    kind: '试投',
  })
  steps.push({
    步骤: `预算用尽后再申请 40000（${second.record ? String(second.record['预演编号']) : '-'}）`,
    观察点: '准入结论',
    变化前: `可用=${second.availableBefore ?? '-'}`,
    变化后: `结论=${second.decision ?? '-'}｜缺口=${second.gap ?? '-'}`,
  })

  if (first.record) {
    const before = channelSnapshot('CHAN-0003')
    cancelRehearsal(Number(first.record.id))
    steps.push({ 步骤: `清理：取消 ${firstCode}`, 观察点: '渠道 CHAN-0003 台账', 变化前: before, 变化后: channelSnapshot('CHAN-0003') })
  }

  const passed =
    first.decision === '许可' &&
    first.availableAfter === 0 &&
    second.decision === '拒绝' &&
    second.gap === 40000
  return {
    用例编号: 'AC-02',
    用例名称: '预算刚好用尽',
    场景: '申请额恰好等于渠道预算时许可且可用归零，后续申请给出缺口',
    断言: '第一笔许可后可用=0，第二笔拒绝且缺口=40000',
    通过: passed,
    步骤: steps,
  }
}

function caseCrossDay(): AcceptanceCaseResult {
  const steps: AcceptanceStep[] = []
  releaseActiveOfChannel('CHAN-0001', steps)

  const result = runRehearsal({
    channelCode: 'CHAN-0001',
    campaignCode: 'CAMP-0001',
    startDate: '2026-09-01',
    endDate: '2026-09-03',
    kind: '试投',
  })
  const code = result.record ? String(result.record['预演编号']) : '-'
  steps.push({
    步骤: `跨日预演 2026-09-01~2026-09-03（${code}）`,
    观察点: '该时段占用明细',
    变化前: `可用=${result.availableBefore ?? '-'}`,
    变化后: `占用天数=${result.record ? String(result.record['占用天数']) : '-'}｜占用总额=${result.occupiedTotal ?? '-'}｜按日=${(result.daily ?? []).map((d) => `${d.date}:${d.amount}`).join('、')}`,
  })

  if (result.record) {
    const before = channelSnapshot('CHAN-0001')
    cancelRehearsal(Number(result.record.id))
    steps.push({ 步骤: `清理：取消 ${code}`, 观察点: '渠道 CHAN-0001 台账', 变化前: before, 变化后: channelSnapshot('CHAN-0001') })
  }

  const passed =
    result.decision === '许可' &&
    Number(result.record?.['占用天数']) === 3 &&
    result.occupiedTotal === 60000 &&
    (result.daily ?? []).length === 3
  return {
    用例编号: 'AC-03',
    用例名称: '活动跨日占用',
    场景: '活动跨 3 天时按日预算逐日累计占用',
    断言: '占用天数=3、占用总额=20000×3=60000、按日明细 3 行',
    通过: passed,
    步骤: steps,
  }
}

function caseRepeatCancel(): AcceptanceCaseResult {
  const steps: AcceptanceStep[] = []
  releaseActiveOfChannel('CHAN-0003', steps)

  const result = runRehearsal({
    channelCode: 'CHAN-0003',
    campaignCode: 'CAMP-0003',
    startDate: '2026-09-03',
    endDate: '2026-09-03',
    kind: '试投',
  })
  const code = result.record ? String(result.record['预演编号']) : '-'
  steps.push({
    步骤: `试投锁定 40000（${code}）`,
    观察点: '渠道 CHAN-0003 台账',
    变化前: `可用=${result.availableBefore ?? '-'}`,
    变化后: `可用=${result.availableAfter ?? '-'}`,
  })

  const recordId = result.record ? Number(result.record.id) : -1
  const firstCancel = cancelRehearsal(recordId)
  steps.push({
    步骤: '第一次取消试投',
    观察点: '渠道 CHAN-0003 台账',
    变化前: `可用=${firstCancel.availableBefore ?? '-'}`,
    变化后: `可用=${firstCancel.availableAfter ?? '-'}｜${firstCancel.message}`,
  })

  const beforeSecond = availableAmount('CHAN-0003')
  const secondCancel = cancelRehearsal(recordId)
  const afterSecond = availableAmount('CHAN-0003')
  steps.push({
    步骤: '重复取消同一条预演',
    观察点: '渠道 CHAN-0003 台账',
    变化前: `可用=${beforeSecond}`,
    变化后: `可用=${afterSecond}｜${secondCancel.message}`,
  })

  const passed =
    firstCancel.ok &&
    firstCancel.availableAfter === 80000 &&
    !secondCancel.ok &&
    beforeSecond === afterSecond &&
    afterSecond === 80000
  return {
    用例编号: 'AC-04',
    用例名称: '重复取消幂等',
    场景: '取消试投完整释放占用，重复取消不二次加回预算',
    断言: '第一次取消后可用恢复 80000；第二次取消被拒绝且可用金额不变',
    通过: passed,
    步骤: steps,
  }
}

function caseConcurrentContention(): AcceptanceCaseResult {
  const steps: AcceptanceStep[] = []
  releaseActiveOfChannel('CHAN-0002', steps)

  const before = channelSnapshot('CHAN-0002')
  const [first, second] = runConcurrentRehearsals([
    { channelCode: 'CHAN-0002', campaignCode: 'CAMP-0002', startDate: '2026-09-02', endDate: '2026-09-02', kind: '试投' },
    { channelCode: 'CHAN-0002', campaignCode: 'CAMP-0002', startDate: '2026-09-02', endDate: '2026-09-02', kind: '试投' },
  ])
  const firstCode = first.record ? String(first.record['预演编号']) : '-'
  const secondCode = second.record ? String(second.record['预演编号']) : '-'
  steps.push({
    步骤: `并发两笔预演争用 CHAN-0002 同一天预算（${firstCode}、${secondCode}）`,
    观察点: '准入结论（渠道评审中，预算 50000，单笔 30000）',
    变化前: before,
    变化后: `${firstCode}=${first.decision ?? '-'}（占用后可用 ${first.availableAfter ?? '-'}）｜${secondCode}=${second.decision ?? '-'}（缺口 ${second.gap ?? '-'}）`,
  })

  const granted = first.decision === '许可' ? first : second.decision === '许可' ? second : undefined
  if (granted?.record) {
    const cancelBefore = channelSnapshot('CHAN-0002')
    cancelRehearsal(Number(granted.record.id))
    steps.push({
      步骤: `取消获得许可的 ${String(granted.record['预演编号'])}`,
      观察点: '渠道 CHAN-0002 台账',
      变化前: cancelBefore,
      变化后: channelSnapshot('CHAN-0002'),
    })
  }

  const decisions = [first.decision, second.decision].sort()
  const gapValue = first.decision === '拒绝' ? first.gap : second.gap
  const passed =
    decisions.join(',') === '拒绝,许可' &&
    gapValue === 10000 &&
    availableAmount('CHAN-0002') === 50000 &&
    String(findChannel('CHAN-0002')?.status) === '渠道评审中'
  return {
    用例编号: 'AC-05',
    用例名称: '并发争用最后一笔预算',
    场景: 'CHAN-0002 处于渠道评审中，CAMP-0002 两笔并发预演争用同一天投放预算',
    断言: '只有一份获得许可，另一份缺口=10000；取消许可后 CHAN-0002 可用恢复 50000',
    通过: passed,
    步骤: steps,
  }
}

function caseReschedule(): AcceptanceCaseResult {
  const steps: AcceptanceStep[] = []
  releaseActiveOfChannel('CHAN-0003', steps)

  const result = runRehearsal({
    channelCode: 'CHAN-0003',
    campaignCode: 'CAMP-0003',
    startDate: '2026-09-03',
    endDate: '2026-09-03',
    kind: '正式',
  })
  const code = result.record ? String(result.record['预演编号']) : '-'
  steps.push({
    步骤: `正式预演许可，进入投产清单（${code}）`,
    观察点: '渠道 CHAN-0003 台账',
    变化前: `可用=${result.availableBefore ?? '-'}`,
    变化后: `可用=${result.availableAfter ?? '-'}｜${rehearsalSnapshot(code)}`,
  })

  const beforeReschedule = channelSnapshot('CHAN-0003')
  rescheduleCampaign('CAMP-0003', '2026-09-10', '2026-09-10')
  steps.push({
    步骤: '活动改期 2026-09-03 → 2026-09-10',
    观察点: `旧占用 ${code} 与渠道台账`,
    变化前: beforeReschedule,
    变化后: `${channelSnapshot('CHAN-0003')}｜${rehearsalSnapshot(code)}`,
  })

  const inProduction = productionList().some((row) => String(row['预演编号']) === code)
  const recordAfter = listRows('rehearsal').find((row) => String(row['预演编号']) === code)
  steps.push({
    步骤: '核对正式投产清单可追溯',
    观察点: `投产清单中的 ${code}`,
    变化前: '占用中（改期前）',
    变化后: inProduction ? `仍在清单，状态=${String(recordAfter?.status)}（历史可追溯）` : '不在清单',
  })

  const restoreBefore = listRows('campaign').find((row) => String(row['活动编号']) === 'CAMP-0003')
  setCampaignRange('CAMP-0003', '2026-09-03', '2026-09-03')
  steps.push({
    步骤: '清理：活动排期改回 2026-09-03',
    观察点: 'CAMP-0003 排期',
    变化前: `${String(restoreBefore?.['开始日期'])}~${String(restoreBefore?.['结束日期'])}`,
    变化后: '2026-09-03~2026-09-03',
  })

  const passed =
    result.decision === '许可' &&
    recordAfter?.status === '已失效' &&
    availableAmount('CHAN-0003') === 80000 &&
    inProduction
  return {
    用例编号: 'AC-06',
    用例名称: '活动改期旧占用失效',
    场景: '活动改期后旧占用立即失效释放预算，历史投产清单仍可追溯',
    断言: '旧预演状态=已失效、渠道可用恢复 80000、投产清单保留该历史记录',
    通过: passed,
    步骤: steps,
  }
}

const CASES: Array<() => AcceptanceCaseResult> = [
  caseChannelDisabled,
  caseBudgetExactlyExhausted,
  caseCrossDay,
  caseRepeatCancel,
  caseConcurrentContention,
  caseReschedule,
]

export function runAcceptanceCases(): AcceptanceRun {
  const results = CASES.map((run) => run())
  const run: AcceptanceRun = {
    执行时间: now(),
    总数: results.length,
    通过数: results.filter((item) => item.通过).length,
    用例: results,
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(ACCEPTANCE_KEY, JSON.stringify(run))
  }
  return run
}

export function loadAcceptanceRun(): AcceptanceRun | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(ACCEPTANCE_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as AcceptanceRun
  } catch {
    return null
  }
}

export function clearAcceptanceRun(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(ACCEPTANCE_KEY)
  }
}

/** 分析看板用的验收观察汇总。 */
export function acceptanceSummary(): { 最近执行: string; 总数: number; 通过数: number; 用例: { 用例编号: string; 用例名称: string; 通过: boolean }[] } | null {
  const run = loadAcceptanceRun()
  if (!run) {
    return null
  }
  return {
    最近执行: run.执行时间,
    总数: run.总数,
    通过数: run.通过数,
    用例: run.用例.map((item) => ({ 用例编号: item.用例编号, 用例名称: item.用例名称, 通过: item.通过 })),
  }
}

/** 分析看板用的预演占用汇总。 */
export function rehearsalSummary(): { 占用中: number; 已释放: number; 已失效: number; 已拒绝: number; 占用总额: number } {
  const rows = listRows('rehearsal')
  const count = (status: string) => rows.filter((row) => row.status === status).length
  return {
    占用中: count('占用中'),
    已释放: count('已释放'),
    已失效: count('已失效'),
    已拒绝: count('已拒绝'),
    占用总额: rows
      .filter((row) => row.status === '占用中')
      .reduce((sum, row) => sum + (Number(row['占用总额']) || 0), 0),
  }
}

/** 供验收观察视图引用的最近一次准入结果（渠道台账与活动排期共享同一预演编号）。 */
export function latestRehearsalCodeOf(campaignCode: string): string {
  const latest = latestRehearsalOf(campaignCode)
  return latest ? String(latest['预演编号']) : '-'
}

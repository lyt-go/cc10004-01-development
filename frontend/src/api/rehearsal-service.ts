import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 预算占用预演：渠道台账、活动排期、正式投产清单都围绕同一条预演记录（准入结果）展开。
// 试投只锁定预算，不进入正式投产清单；取消试投完整释放占用；改期/渠道停用让旧占用失效但记录可追溯。

export type RehearsalKind = '试投' | '正式'

export type RehearsalInput = {
  channelCode: string
  campaignCode: string
  startDate: string
  endDate: string
  kind: RehearsalKind
}

export type DailyOccupation = { date: string; amount: number }

export type RehearsalResult = {
  ok: boolean
  message: string
  record?: EntryRow
  decision?: '许可' | '拒绝'
  gap?: number
  channelStatus?: string
  occupiedTotal?: number
  daily?: DailyOccupation[]
  availableBefore?: number
  availableAfter?: number
}

export type LedgerEntry = {
  code: string
  campaign: string
  kind: string
  range: string
  amount: number
}

export type LedgerRow = {
  channelCode: string
  channelStatus: string
  budget: number
  occupied: number
  available: number
  entries: LedgerEntry[]
}

export type ScheduleRow = {
  campaignCode: string
  campaignStatus: string
  channelCode: string
  range: string
  dailyBudget: number
  rehearsals: { code: string; decision: string; status: string; kind: string; amount: number }[]
}

const DAY_MS = 24 * 60 * 60 * 1000

function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function parseDay(date: string): number {
  const time = Date.parse(`${date}T00:00:00Z`)
  if (Number.isNaN(time)) {
    throw new Error(`日期 ${date} 不合法，应为 YYYY-MM-DD`)
  }
  return time
}

export function dayCount(startDate: string, endDate: string): number {
  return Math.round((parseDay(endDate) - parseDay(startDate)) / DAY_MS) + 1
}

export function dailyBreakdown(startDate: string, endDate: string, dailyBudget: number): DailyOccupation[] {
  const days = dayCount(startDate, endDate)
  const startMs = parseDay(startDate)
  return Array.from({ length: days }, (_, index) => ({
    date: new Date(startMs + index * DAY_MS).toISOString().slice(0, 10),
    amount: dailyBudget,
  }))
}

export function findChannel(channelCode: string): EntryRow | undefined {
  return listRows('channel').find((row) => String(row['渠道编号']) === channelCode)
}

export function findCampaign(campaignCode: string): EntryRow | undefined {
  return listRows('campaign').find((row) => String(row['活动编号']) === campaignCode)
}

export function activeRehearsals(channelCode?: string): EntryRow[] {
  return listRows('rehearsal').filter(
    (row) => row.status === '占用中' && (!channelCode || String(row['关联渠道']) === channelCode),
  )
}

export function occupiedAmount(channelCode: string): number {
  return activeRehearsals(channelCode).reduce((sum, row) => sum + (Number(row['占用总额']) || 0), 0)
}

export function channelBudget(channelCode: string): number {
  const channel = findChannel(channelCode)
  return channel ? Number(channel['投放预算']) || 0 : 0
}

export function availableAmount(channelCode: string): number {
  return channelBudget(channelCode) - occupiedAmount(channelCode)
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((acc, row) => Math.max(acc, Number(row.id) || 0), 0) + 1
}

function nextRehearsalCode(rows: EntryRow[]): string {
  const max = rows.reduce((acc, row) => {
    const match = /^REHE-(\d+)$/.exec(String(row['预演编号'] ?? ''))
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `REHE-${String(max + 1).padStart(4, '0')}`
}

function nextSeq(rows: EntryRow[]): number {
  return rows.reduce((acc, row) => Math.max(acc, Number(row['确认序号']) || 0), 0) + 1
}

/** 发起一次预算占用预演：给出准入结论、渠道状态和该时段占用明细，并把准入结果落账。 */
export function runRehearsal(input: RehearsalInput): RehearsalResult {
  const channel = findChannel(input.channelCode)
  if (!channel) {
    return { ok: false, message: `没有找到渠道 ${input.channelCode}` }
  }
  const campaign = findCampaign(input.campaignCode)
  if (!campaign) {
    return { ok: false, message: `没有找到活动 ${input.campaignCode}` }
  }
  if (String(campaign['关联渠道']) !== input.channelCode) {
    return {
      ok: false,
      message: `活动 ${input.campaignCode} 关联的渠道是 ${String(campaign['关联渠道'])}，与所选渠道不一致`,
    }
  }
  let days: number
  try {
    days = dayCount(input.startDate, input.endDate)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '日期不合法' }
  }
  if (days <= 0) {
    return { ok: false, message: '结束日期不能早于开始日期' }
  }
  const dailyBudget = Number(campaign['日预算']) || 0
  if (dailyBudget <= 0) {
    return { ok: false, message: `活动 ${input.campaignCode} 的日预算不合法，无法预演` }
  }
  const total = dailyBudget * days
  const channelStatus = String(channel.status)
  const availableBefore = availableAmount(input.channelCode)
  const daily = dailyBreakdown(input.startDate, input.endDate, dailyBudget)

  // 准入规则：已停用渠道直接拒绝；其余渠道按可用金额判断。
  // 计划冲突时以已生效渠道和更早确认的活动为准——已确认占用先扣减，后来的预演只能竞争剩余额度。
  let decision: '许可' | '拒绝'
  let reason: string
  let gap = 0
  if (channelStatus === '已停用') {
    decision = '拒绝'
    gap = total
    reason = `渠道 ${input.channelCode} 已停用，预算不可用`
  } else if (availableBefore < total) {
    decision = '拒绝'
    gap = total - availableBefore
    reason = `可用金额 ${availableBefore} 不足以覆盖本次占用 ${total}，缺口 ${gap}`
  } else {
    decision = '许可'
    reason =
      channelStatus === '已启用'
        ? '渠道已生效，预算充足，许可占用'
        : `渠道${channelStatus}，许可先行锁定预算，正式投产以渠道生效为准`
  }

  const rows = listRows('rehearsal')
  const record: EntryRow = {
    id: nextId(rows),
    status: decision === '许可' ? '占用中' : '已拒绝',
    pending: decision !== '许可',
    abnormal: decision === '拒绝',
    预演编号: nextRehearsalCode(rows),
    关联渠道: input.channelCode,
    关联活动: input.campaignCode,
    开始日期: input.startDate,
    结束日期: input.endDate,
    预演类型: input.kind,
    日占用预算: dailyBudget,
    占用天数: days,
    占用总额: total,
    准入结论: decision,
    缺口金额: gap,
    渠道状态快照: channelStatus,
    确认序号: nextSeq(rows),
    占用前可用: availableBefore,
    占用后可用: decision === '许可' ? availableBefore - total : availableBefore,
    结论说明: reason,
    创建时间: now(),
    释放时间: '',
  }
  saveRows('rehearsal', [...rows, record])
  return {
    ok: true,
    message: `${String(record['预演编号'])} ${decision}：${reason}`,
    record,
    decision,
    gap,
    channelStatus,
    occupiedTotal: total,
    daily,
    availableBefore,
    availableAfter: Number(record['占用后可用']),
  }
}

/**
 * 并发预演：同一渠道的多笔请求在同一批里按确认顺序依次落账。
 * 先确认的先锁定预算，争用最后一笔预算时只有一份获得许可，其余拿到明确缺口。
 */
export function runConcurrentRehearsals(inputs: RehearsalInput[]): RehearsalResult[] {
  return inputs.map((input) => runRehearsal(input))
}

/** 取消试投：完整释放占用。重复取消是幂等的——已释放的记录不再二次加回预算。 */
export function cancelRehearsal(id: number): ActionResult & { availableBefore?: number; availableAfter?: number } {
  const rows = listRows('rehearsal')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的预演记录` }
  }
  const row = rows[index]
  const channelCode = String(row['关联渠道'])
  if (row.status === '已释放') {
    return { ok: false, message: `${String(row['预演编号'])} 已取消过，占用早已完整释放，无需重复取消` }
  }
  if (row.status === '已失效') {
    return { ok: false, message: `${String(row['预演编号'])} 已因改期或渠道变动失效，无需取消` }
  }
  if (row.status === '已拒绝') {
    return { ok: false, message: `${String(row['预演编号'])} 未获得许可，没有占用可释放` }
  }
  const availableBefore = availableAmount(channelCode)
  const next = [...rows]
  next[index] = { ...row, status: '已释放', pending: false, 释放时间: now() }
  saveRows('rehearsal', next)
  const availableAfter = availableAmount(channelCode)
  return {
    ok: true,
    message: `${String(row['预演编号'])} 已取消试投，占用 ${String(row['占用总额'])} 已完整释放，渠道可用 ${availableBefore} → ${availableAfter}`,
    availableBefore,
    availableAfter,
  }
}

/** 活动改期：更新排期，旧占用立即失效（记录保留可追溯），预算让回渠道。 */
export function rescheduleCampaign(
  campaignCode: string,
  newStart: string,
  newEnd: string,
): ActionResult & { invalidated?: number } {
  const campaigns = listRows('campaign')
  const cIndex = campaigns.findIndex((row) => String(row['活动编号']) === campaignCode)
  if (cIndex < 0) {
    return { ok: false, message: `没有找到活动 ${campaignCode}` }
  }
  let days: number
  try {
    days = dayCount(newStart, newEnd)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '日期不合法' }
  }
  if (days <= 0) {
    return { ok: false, message: '结束日期不能早于开始日期' }
  }
  const nextCampaigns = [...campaigns]
  nextCampaigns[cIndex] = { ...campaigns[cIndex], 开始日期: newStart, 结束日期: newEnd }
  saveRows('campaign', nextCampaigns)

  const rows = listRows('rehearsal')
  let invalidated = 0
  const nextRows = rows.map((row) => {
    if (String(row['关联活动']) === campaignCode && row.status === '占用中') {
      invalidated += 1
      return {
        ...row,
        status: '已失效',
        pending: false,
        释放时间: now(),
        结论说明: `${String(row['结论说明'])}；活动改期至 ${newStart}~${newEnd}，旧占用失效`,
      }
    }
    return row
  })
  if (invalidated > 0) {
    saveRows('rehearsal', nextRows)
  }
  return {
    ok: true,
    message: `活动 ${campaignCode} 已改期到 ${newStart}~${newEnd}，${invalidated} 笔旧占用失效，历史记录仍可追溯`,
    invalidated,
  }
}

/** 渠道停用/变动时：该渠道占用中的预演全部失效，预算让路给已生效渠道的计划。 */
export function invalidateChannelRehearsals(channelCode: string, reason: string): number {
  const rows = listRows('rehearsal')
  let count = 0
  const next = rows.map((row) => {
    if (String(row['关联渠道']) === channelCode && row.status === '占用中') {
      count += 1
      return {
        ...row,
        status: '已失效',
        pending: false,
        释放时间: now(),
        结论说明: `${String(row['结论说明'])}；${reason}，占用让路给已生效渠道的计划`,
      }
    }
    return row
  })
  if (count > 0) {
    saveRows('rehearsal', next)
  }
  return count
}

/** 渠道台账：每个渠道的预算、占用中金额、可用金额，以及引用预演编号的占用明细。 */
export function channelLedger(): LedgerRow[] {
  return listRows('channel').map((channel) => {
    const code = String(channel['渠道编号'])
    const entries = activeRehearsals(code)
      .map((row) => ({
        code: String(row['预演编号']),
        campaign: String(row['关联活动']),
        kind: String(row['预演类型']),
        range: `${String(row['开始日期'])}~${String(row['结束日期'])}`,
        amount: Number(row['占用总额']) || 0,
      }))
      .sort((a, b) => a.code.localeCompare(b.code))
    const budget = Number(channel['投放预算']) || 0
    const occupied = entries.reduce((sum, entry) => sum + entry.amount, 0)
    return {
      channelCode: code,
      channelStatus: String(channel.status),
      budget,
      occupied,
      available: budget - occupied,
      entries,
    }
  })
}

/** 活动排期：每个活动引用与渠道台账相同的预演编号（同一次准入结果）。 */
export function campaignSchedule(): ScheduleRow[] {
  const rehearsals = listRows('rehearsal')
  return listRows('campaign').map((campaign) => {
    const code = String(campaign['活动编号'])
    const linked = rehearsals
      .filter((row) => String(row['关联活动']) === code)
      .map((row) => ({
        code: String(row['预演编号']),
        decision: String(row['准入结论']),
        status: String(row.status),
        kind: String(row['预演类型']),
        amount: Number(row['占用总额']) || 0,
      }))
      .sort((a, b) => a.code.localeCompare(b.code))
    return {
      campaignCode: code,
      campaignStatus: String(campaign.status),
      channelCode: String(campaign['关联渠道']),
      range: `${String(campaign['开始日期'])}~${String(campaign['结束日期'])}`,
      dailyBudget: Number(campaign['日预算']) || 0,
      rehearsals: linked,
    }
  })
}

/** 正式投产清单：只有「正式」类型且许可的预演进入清单；改期失效的保留为历史，可追溯。 */
export function productionList(): EntryRow[] {
  return listRows('rehearsal').filter(
    (row) => String(row['预演类型']) === '正式' && String(row['准入结论']) === '许可',
  )
}

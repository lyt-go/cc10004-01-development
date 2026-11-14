import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  availableAmount,
  campaignSchedule,
  cancelRehearsal,
  channelLedger,
  productionList,
  rescheduleCampaign,
  runConcurrentRehearsals,
  runRehearsal,
} from '@/api/rehearsal-service'
import type { LedgerRow, RehearsalKind, RehearsalResult, ScheduleRow } from '@/api/rehearsal-service'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

export default function RehearsalView() {
  const [channels, setChannels] = useState<EntryRow[]>([])
  const [campaigns, setCampaigns] = useState<EntryRow[]>([])
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [schedule, setSchedule] = useState<ScheduleRow[]>([])
  const [records, setRecords] = useState<EntryRow[]>([])
  const [production, setProduction] = useState<EntryRow[]>([])
  const [message, setMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [results, setResults] = useState<RehearsalResult[]>([])

  const [campaignCode, setCampaignCode] = useState('CAMP-0002')
  const [startDate, setStartDate] = useState('2026-09-02')
  const [endDate, setEndDate] = useState('2026-09-02')
  const [kind, setKind] = useState<RehearsalKind>('试投')
  const [rescheduleDraft, setRescheduleDraft] = useState<Record<string, { start: string; end: string }>>({})

  const reload = useCallback(() => {
    setChannels(listRows('channel'))
    setCampaigns(listRows('campaign'))
    setLedger(channelLedger())
    setSchedule(campaignSchedule())
    setRecords(listRows('rehearsal'))
    setProduction(productionList())
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const channelCode = useMemo(() => {
    const campaign = campaigns.find((row) => String(row['活动编号']) === campaignCode)
    return campaign ? String(campaign['关联渠道']) : ''
  }, [campaigns, campaignCode])

  const channelStatus = useMemo(() => {
    const channel = channels.find((row) => String(row['渠道编号']) === channelCode)
    return channel ? String(channel.status) : '-'
  }, [channels, channelCode])

  function pickCampaign(code: string) {
    setCampaignCode(code)
    const campaign = campaigns.find((row) => String(row['活动编号']) === code)
    if (campaign) {
      setStartDate(String(campaign['开始日期']))
      setEndDate(String(campaign['结束日期']))
    }
  }

  function buildInput() {
    return { channelCode, campaignCode, startDate, endDate, kind }
  }

  function handleResults(outcome: RehearsalResult[]) {
    setResults(outcome)
    const failed = outcome.find((item) => !item.ok)
    if (failed) {
      setErrorMessage(failed.message)
    } else {
      setErrorMessage('')
      setMessage(outcome.map((item) => item.message).join('；'))
    }
    reload()
  }

  function runSingle() {
    setMessage('')
    handleResults([runRehearsal(buildInput())])
  }

  function runConcurrent() {
    setMessage('')
    // 同一渠道同一时段连发两笔，模拟并发争用：先确认的先锁定预算
    handleResults(runConcurrentRehearsals([buildInput(), buildInput()]))
  }

  function cancel(id: number) {
    setMessage('')
    setErrorMessage('')
    const result = cancelRehearsal(id)
    if (result.ok) {
      setMessage(result.message)
    } else {
      setErrorMessage(result.message)
    }
    reload()
  }

  function reschedule(code: string) {
    setMessage('')
    setErrorMessage('')
    const draft = rescheduleDraft[code]
    if (!draft || !draft.start || !draft.end) {
      setErrorMessage(`请先为 ${code} 选择新的开始和结束日期`)
      return
    }
    const result = rescheduleCampaign(code, draft.start, draft.end)
    if (result.ok) {
      setMessage(result.message)
    } else {
      setErrorMessage(result.message)
    }
    reload()
  }

  return (
    <section className="page" data-module="rehearsal">
      <header className="page-head">
        <div>
          <h2>预算预演</h2>
          <p className="page-desc">
            选择渠道、日期区间和活动发起可回放的预算占用预演：试投只锁定预算，不进正式投产清单；取消试投完整释放占用。
          </p>
        </div>
      </header>

      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault()
          runSingle()
        }}
      >
        <label className="filter-item">
          <span>投放活动</span>
          <select value={campaignCode} onChange={(event) => pickCampaign(event.target.value)}>
            {campaigns.map((row) => (
              <option key={String(row['活动编号'])} value={String(row['活动编号'])}>
                {String(row['活动编号'])}（{String(row['活动名称'])}）
              </option>
            ))}
          </select>
        </label>
        <label className="filter-item">
          <span>渠道（随活动关联）</span>
          <input value={channelCode ? `${channelCode}（${channelStatus}）` : '未关联'} readOnly />
        </label>
        <label className="filter-item">
          <span>开始日期</span>
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
        </label>
        <label className="filter-item">
          <span>结束日期</span>
          <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
        </label>
        <label className="filter-item">
          <span>预演类型</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as RehearsalKind)}>
            <option value="试投">试投（只锁预算）</option>
            <option value="正式">正式（进投产清单）</option>
          </select>
        </label>
        <button className="btn primary" type="submit">发起预演</button>
        <button className="btn" type="button" onClick={runConcurrent}>并发预演（双发争用）</button>
      </form>

      {results.length > 0 && (
        <div className="panel">
          <h3 className="panel-title">本次预演结果</h3>
          <div className="result-grid">
            {results.map((item, index) => (
              <article key={index} className={`result-card ${item.decision === '许可' ? 'pass' : 'fail'}`}>
                <strong>
                  {item.record ? String(item.record['预演编号']) : `第 ${index + 1} 笔`}：
                  {item.decision ?? '未执行'}
                </strong>
                <span>渠道状态：{item.channelStatus ?? '-'}</span>
                <span>该时段占用：{item.occupiedTotal ?? 0}</span>
                <span>可用金额：{item.availableBefore ?? '-'} → {item.availableAfter ?? '-'}</span>
                {item.decision === '拒绝' && <span className="error-text">金额缺口：{item.gap ?? 0}</span>}
                <span>{item.message}</span>
                {(item.daily ?? []).length > 0 && (
                  <table className="data-table">
                    <thead>
                      <tr><th>日期</th><th>当日占用</th></tr>
                    </thead>
                    <tbody>
                      {(item.daily ?? []).map((day) => (
                        <tr key={day.date}><td>{day.date}</td><td>{day.amount}</td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </article>
            ))}
          </div>
        </div>
      )}

      <div className="panel">
        <h3 className="panel-title">渠道台账（占用明细引用预演编号）</h3>
        <table className="data-table">
          <thead>
            <tr><th>渠道编号</th><th>渠道状态</th><th>投放预算</th><th>占用中</th><th>可用金额</th><th>占用明细（预演编号）</th></tr>
          </thead>
          <tbody>
            {ledger.map((row) => (
              <tr key={row.channelCode}>
                <td>{row.channelCode}</td>
                <td>{row.channelStatus}</td>
                <td>{row.budget}</td>
                <td>{row.occupied}</td>
                <td>{row.available}</td>
                <td>
                  {row.entries.length === 0 && '—'}
                  {row.entries.map((entry) => (
                    <span key={entry.code} className="legend-item">
                      {entry.code}｜{entry.campaign}｜{entry.kind}｜{entry.range}｜{entry.amount}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3 className="panel-title">活动排期（与台账引用同一次准入结果）</h3>
        <table className="data-table">
          <thead>
            <tr><th>活动编号</th><th>活动状态</th><th>关联渠道</th><th>计划区间</th><th>日预算</th><th>预演引用</th><th>活动改期</th></tr>
          </thead>
          <tbody>
            {schedule.map((row) => {
              const draft = rescheduleDraft[row.campaignCode] ?? { start: '', end: '' }
              return (
                <tr key={row.campaignCode}>
                  <td>{row.campaignCode}</td>
                  <td>{row.campaignStatus}</td>
                  <td>{row.channelCode}</td>
                  <td>{row.range}</td>
                  <td>{row.dailyBudget}</td>
                  <td>
                    {row.rehearsals.length === 0 && '—'}
                    {row.rehearsals.map((item) => (
                      <span key={item.code} className="legend-item">
                        {item.code}｜{item.decision}｜{item.status}｜{item.amount}
                      </span>
                    ))}
                  </td>
                  <td className="row-actions">
                    <input
                      type="date"
                      value={draft.start}
                      onChange={(event) =>
                        setRescheduleDraft((prev) => ({
                          ...prev,
                          [row.campaignCode]: { ...draft, start: event.target.value },
                        }))
                      }
                    />
                    <input
                      type="date"
                      value={draft.end}
                      onChange={(event) =>
                        setRescheduleDraft((prev) => ({
                          ...prev,
                          [row.campaignCode]: { ...draft, end: event.target.value },
                        }))
                      }
                    />
                    <button className="link" type="button" onClick={() => reschedule(row.campaignCode)}>改期</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3 className="panel-title">预演记录</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>预演编号</th><th>关联渠道</th><th>关联活动</th><th>区间</th><th>类型</th>
              <th>占用总额</th><th>准入结论</th><th>缺口金额</th><th>渠道状态快照</th><th>当前状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {records.map((row) => (
              <tr key={String(row.id)}>
                <td>{String(row['预演编号'])}</td>
                <td>{String(row['关联渠道'])}</td>
                <td>{String(row['关联活动'])}</td>
                <td>{String(row['开始日期'])}~{String(row['结束日期'])}</td>
                <td>{String(row['预演类型'])}</td>
                <td>{String(row['占用总额'])}</td>
                <td>{String(row['准入结论'])}</td>
                <td>{String(row['缺口金额'])}</td>
                <td>{String(row['渠道状态快照'])}</td>
                <td>{String(row.status)}</td>
                <td className="row-actions">
                  <button className="link" type="button" onClick={() => cancel(Number(row.id))}>取消试投</button>
                </td>
              </tr>
            ))}
            {records.length === 0 && (
              <tr><td className="empty-state" colSpan={11}>暂无预演记录，先在上方发起一次预演</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3 className="panel-title">正式投产清单（试投不进入；改期失效的保留为历史可追溯）</h3>
        <table className="data-table">
          <thead>
            <tr><th>预演编号</th><th>关联渠道</th><th>关联活动</th><th>区间</th><th>占用总额</th><th>清单状态</th></tr>
          </thead>
          <tbody>
            {production.map((row) => (
              <tr key={String(row.id)}>
                <td>{String(row['预演编号'])}</td>
                <td>{String(row['关联渠道'])}</td>
                <td>{String(row['关联活动'])}</td>
                <td>{String(row['开始日期'])}~{String(row['结束日期'])}</td>
                <td>{String(row['占用总额'])}</td>
                <td>{row.status === '占用中' ? '投产中' : `历史（${String(row.status)}）`}</td>
              </tr>
            ))}
            {production.length === 0 && (
              <tr><td className="empty-state" colSpan={6}>暂无正式投产记录，正式类型预演许可后进入本清单</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <footer className="page-foot">
        <span>渠道台账与活动排期引用同一条预演记录；当前 {records.length} 条预演记录</span>
        {message && <span>{message}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}

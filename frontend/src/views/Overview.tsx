import { useCallback, useEffect, useState } from 'react'

import { acceptanceSummary, rehearsalSummary } from '@/api/acceptance-service'
import { loadOverview } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'

type AcceptanceSummary = ReturnType<typeof acceptanceSummary>
type RehearsalSummary = ReturnType<typeof rehearsalSummary>

export default function Overview() {
  const [cards, setCards] = useState<OverviewResult['cards']>([])
  const [moduleRows, setModuleRows] = useState<OverviewResult['modules']>([])
  const [acceptance, setAcceptance] = useState<AcceptanceSummary>(null)
  const [rehearsal, setRehearsal] = useState<RehearsalSummary | null>(null)

  const refresh = useCallback(() => {
    const payload = loadOverview()
    setCards(payload.cards)
    setModuleRows(payload.modules)
    setAcceptance(acceptanceSummary())
    setRehearsal(rehearsalSummary())
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>运营概览</h2>
          <p className="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={refresh}>重新统计</button>
        </div>
      </header>
      <div className="stat-row">
        {cards.map((card) => (
          <article key={card.label} className="stat-card">
            <span className="stat-label">{card.label}</span>
            <strong className="stat-value">{card.value}</strong>
          </article>
        ))}
      </div>

      {rehearsal && (
        <div className="panel">
          <h3 className="panel-title">预算预演占用</h3>
          <div className="stat-row">
            <article className="stat-card">
              <span className="stat-label">占用中预演</span>
              <strong className="stat-value">{rehearsal.占用中}</strong>
            </article>
            <article className="stat-card">
              <span className="stat-label">占用中预算</span>
              <strong className="stat-value">{rehearsal.占用总额}</strong>
            </article>
            <article className="stat-card">
              <span className="stat-label">已释放</span>
              <strong className="stat-value">{rehearsal.已释放}</strong>
            </article>
            <article className="stat-card">
              <span className="stat-label">已失效 / 已拒绝</span>
              <strong className="stat-value">{rehearsal.已失效} / {rehearsal.已拒绝}</strong>
            </article>
          </div>
        </div>
      )}

      <div className="panel">
        <h3 className="panel-title">验收观察</h3>
        {acceptance ? (
          <>
            <p className="page-desc">
              最近执行：{acceptance.最近执行}｜通过 {acceptance.通过数}/{acceptance.总数}，明细见「验收观察」视图，可回看。
            </p>
            <p className="status-legend">
              {acceptance.用例.map((item) => (
                <span key={item.用例编号} className={`badge ${item.通过 ? 'pass' : 'fail'}`}>
                  {item.用例编号} {item.用例名称}：{item.通过 ? '通过' : '未通过'}
                </span>
              ))}
            </p>
          </>
        ) : (
          <p className="page-desc">尚未执行验收用例，请到「验收观察」视图执行；结果会同步展示在本看板。</p>
        )}
      </div>

      <table className="data-table">
        <thead>
          <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
        </thead>
        <tbody>
          {moduleRows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td>{row.created}</td>
              <td>{row.pending}</td>
              <td>{row.abnormal}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer className="page-foot">
        <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
      </footer>
    </section>
  )
}

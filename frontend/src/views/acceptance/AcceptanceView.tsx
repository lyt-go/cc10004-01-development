import { useCallback, useEffect, useState } from 'react'

import { clearAcceptanceRun, loadAcceptanceRun, runAcceptanceCases } from '@/api/acceptance-service'
import type { AcceptanceRun } from '@/api/acceptance-service'

export default function AcceptanceView() {
  const [run, setRun] = useState<AcceptanceRun | null>(null)
  const [message, setMessage] = useState('')

  const reload = useCallback(() => {
    setRun(loadAcceptanceRun())
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  function execute() {
    setMessage('')
    const outcome = runAcceptanceCases()
    setRun(outcome)
    setMessage(`验收执行完成：${outcome.通过数}/${outcome.总数} 通过，结果已留存可回看`)
  }

  function clear() {
    clearAcceptanceRun()
    setRun(null)
    setMessage('验收观察记录已清空')
  }

  return (
    <section className="page" data-module="acceptance">
      <header className="page-head">
        <div>
          <h2>验收观察</h2>
          <p className="page-desc">
            独立视图：在真实数据上执行预算预演验收用例，逐步记录变化前后快照，结果持久化可回看，并同步到分析看板。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={execute}>执行验收用例</button>
          <button className="btn ghost" type="button" onClick={clear}>清空观察记录</button>
        </div>
      </header>

      {run && (
        <>
          <div className="stat-row">
            <article className="stat-card">
              <span className="stat-label">用例总数</span>
              <strong className="stat-value">{run.总数}</strong>
            </article>
            <article className="stat-card">
              <span className="stat-label">通过数</span>
              <strong className="stat-value">{run.通过数}</strong>
            </article>
            <article className="stat-card">
              <span className="stat-label">未通过</span>
              <strong className="stat-value">{run.总数 - run.通过数}</strong>
            </article>
            <article className="stat-card">
              <span className="stat-label">最近执行时间</span>
              <strong className="stat-value">{run.执行时间}</strong>
            </article>
          </div>

          {run.用例.map((item) => (
            <div key={item.用例编号} className="panel">
              <h3 className="panel-title">
                {item.用例编号} {item.用例名称}
                <span className={`badge ${item.通过 ? 'pass' : 'fail'}`}>{item.通过 ? '通过' : '未通过'}</span>
              </h3>
              <p className="page-desc">场景：{item.场景}</p>
              <p className="page-desc">断言：{item.断言}</p>
              <table className="data-table">
                <thead>
                  <tr><th>步骤</th><th>观察点</th><th>变化前</th><th>变化后</th></tr>
                </thead>
                <tbody>
                  {item.步骤.map((step, index) => (
                    <tr key={index}>
                      <td>{step.步骤}</td>
                      <td>{step.观察点}</td>
                      <td>{step.变化前}</td>
                      <td>{step.变化后}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}

      {!run && (
        <p className="empty-state">暂无验收观察记录，点击「执行验收用例」生成；执行结果会留存，刷新后仍可回看。</p>
      )}

      <footer className="page-foot">
        <span>覆盖场景：渠道停用、预算刚好用尽、活动跨日、重复取消、并发争用（CHAN-0002/CAMP-0002）、活动改期</span>
        {message && <span>{message}</span>}
      </footer>
    </section>
  )
}

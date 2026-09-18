// 测试窗格：展示 agent 自报的测试结果。
export default function TestPane({ events }: { events: any[] }) {
  return (
    <div className="pane">
      <h3>测试</h3>
      {events.length === 0 && <div style={{ color: '#888' }}>暂无测试结果</div>}
      {events.map((e, i) => {
        const p = e.payload || {}
        return (
          <div className="card" key={i}>
            <div>命令：{p.cmd || '—'}</div>
            <div className={p.passed ? 'pass' : 'fail'}>{p.passed ? '通过' : '失败'}</div>
            {p.output && (
              <pre className="diff" style={{ background: '#0b1f12' }}>
                {p.output}
              </pre>
            )}
          </div>
        )
      })}
    </div>
  )
}

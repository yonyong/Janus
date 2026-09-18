// 编码窗格：展示 agent 产生的改动事件与 git diff。
export default function CodePane({ events }: { events: any[] }) {
  return (
    <div className="pane">
      <h3>编码</h3>
      {events.length === 0 && <div style={{ color: '#888' }}>暂无改动</div>}
      {events.map((e, i) => (
        <div className="card" key={i}>
          <div>{e.text || e.payload?.path || '改动'}</div>
          {e.diff && <pre className="diff">{e.diff}</pre>}
        </div>
      ))}
    </div>
  )
}

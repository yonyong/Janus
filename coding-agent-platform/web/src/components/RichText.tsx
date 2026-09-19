/** 轻量富文本渲染：支持 ``` 代码块，其余按原文换行展示。 */
export default function RichText({ text }: { text: string }) {
  if (!text) return null
  const parts = String(text).split('```')
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 1) {
          const nl = p.indexOf('\n')
          const body = nl === -1 ? p : p.slice(nl + 1)
          return (
            <pre className="code-block" key={i}>
              <code>{body.replace(/\n$/, '')}</code>
            </pre>
          )
        }
        return p ? (
          <span key={i} style={{ whiteSpace: 'pre-wrap' }}>
            {p}
          </span>
        ) : null
      })}
    </>
  )
}

import { HashRouter, Routes, Route, Link } from 'react-router-dom'
import { TokenContext } from './auth'
import { getToken } from './api'
import ProjectList from './pages/ProjectList'
import RequirementList from './pages/RequirementList'
import Workbench from './pages/Workbench'
import AgentList from './pages/AgentList'

export default function App() {
  const token = getToken()
  return (
    <TokenContext.Provider value={token}>
      <HashRouter>
        <div className="topbar">
          <span className="logo">编码 Agent 平台</span>
          <Link to="/">项目</Link>
          <Link to="/agents">Agent 管理</Link>
          {!token && <span style={{ color: '#e5484d' }}>（缺少访问令牌）</span>}
        </div>
        <Routes>
          <Route path="/" element={<ProjectList />} />
          <Route path="/agents" element={<AgentList />} />
          <Route path="/projects/:pid" element={<RequirementList />} />
          <Route path="/workbench/:sid" element={<Workbench />} />
        </Routes>
      </HashRouter>
    </TokenContext.Provider>
  )
}

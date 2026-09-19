import { GithubOutlined, MailOutlined } from '@ant-design/icons'

/**
 * 全站页脚：每个页面底部统一展示联系信息。
 * GitHub 与邮箱均为可点击链接（图标 + 文字）。
 */
export default function SiteFooter() {
  return (
    <div className="site-footer">
      <span>联系我们</span>
      <span className="site-footer-sep">·</span>
      <a
        className="site-footer-link"
        href="https://github.com/yonyong"
        target="_blank"
        rel="noreferrer"
        title="GitHub 主页"
      >
        <GithubOutlined className="site-footer-icon" />
        yonyong
      </a>
      <span className="site-footer-sep">·</span>
      <a className="site-footer-link" href="mailto:ace.yonyong@qq.com" title="发送邮件">
        <MailOutlined className="site-footer-icon" />
        ace.yonyong@qq.com
      </a>
    </div>
  )
}

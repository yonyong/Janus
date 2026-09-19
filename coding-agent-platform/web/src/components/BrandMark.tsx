import { useId } from 'react'

/**
 * 品牌 Logo：蓝紫渐变圆角方块 + 顶部高光 + 圆头描边「J」字钩。
 *
 * 渐变 id 用 useId 派生，保证同页多处渲染（侧边栏 + 登录弹框）时不会撞 id。
 */
export default function BrandMark({ size = 36 }: { size?: number }) {
  const gid = `janus-brand-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      className="brand-mark"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={gid}
          x1="2"
          y1="0"
          x2="34"
          y2="36"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#4d7cff" />
          <stop offset="1" stopColor="#7b5cff" />
        </linearGradient>
      </defs>
      <rect width="36" height="36" rx="10" fill={`url(#${gid})`} />
      <rect x="1.5" y="1.5" width="33" height="15" rx="8" fill="#ffffff" opacity="0.16" />
      <path
        d="M23 9.6v8.2c0 4.2-2.5 6.8-6.6 6.8-2.5 0-4.5-1.1-5.5-3"
        stroke="#ffffff"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

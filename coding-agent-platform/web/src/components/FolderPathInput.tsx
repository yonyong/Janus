import { useState } from 'react'
import { Button, Input } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import DirPickerModal from './DirPickerModal'

interface FolderPathInputProps {
  value?: string
  onChange?: (value: string) => void
  placeholder?: string
  disabled?: boolean
}

/**
 * 本地工程路径输入：点击「浏览」选择目录。
 * - 桌面端（pywebview）：弹系统文件夹对话框，返回真实绝对路径；
 * - 其余（浏览器）：弹网页版目录选择器（后端列目录），避开 webkitdirectory
 *   那个「将 N 个文件上传到此网站」的确认框、以及它拿不到绝对路径的问题。
 */
export default function FolderPathInput({ value, onChange, placeholder, disabled }: FolderPathInputProps) {
  const [pickerOpen, setPickerOpen] = useState(false)

  const emit = (v: string) => onChange?.(v)

  const pick = async () => {
    const api = (window as any).pywebview?.api
    if (api && typeof api.select_folder === 'function') {
      try {
        const path: string = await api.select_folder()
        if (path) emit(path)
        return
      } catch {
        // 桌面桥接异常，降级到网页目录选择器
      }
    }
    setPickerOpen(true)
  }

  return (
    <>
      <Input
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => emit(e.target.value)}
        addonAfter={
          <Button
            type="link"
            size="small"
            disabled={disabled}
            style={{ height: 'auto', padding: 0, fontSize: 13 }}
            icon={<FolderOpenOutlined />}
            onClick={pick}
          >
            浏览
          </Button>
        }
      />
      <DirPickerModal
        open={pickerOpen}
        initialPath={value}
        onCancel={() => setPickerOpen(false)}
        onSelect={(p) => {
          emit(p)
          setPickerOpen(false)
        }}
      />
    </>
  )
}

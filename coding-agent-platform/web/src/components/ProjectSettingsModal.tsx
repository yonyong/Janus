import { useEffect, useState } from 'react'
import { Form, Input, Modal } from 'antd'
import FolderPathInput from './FolderPathInput'
import { updateProject, type Project } from '../api'

/** 管理员编辑项目基本信息 + 日志目录。 */
export default function ProjectSettingsModal({
  open,
  project,
  token,
  onCancel,
  onSaved,
}: {
  open: boolean
  project: Project | null
  token: string | null
  onCancel: () => void
  onSaved: (p: Project) => void
}) {
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const diskWatch = Form.useWatch('disk_path', form) as string | undefined

  useEffect(() => {
    if (open && project) {
      form.setFieldsValue({
        name: project.name,
        disk_path: project.disk_path,
        log_dir: project.log_dir || '',
      })
    }
  }, [open, project, form])

  return (
    <Modal
      title={project ? `项目设置 · ${project.name}` : '项目设置'}
      open={open}
      onCancel={onCancel}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      destroyOnClose
      onOk={async () => {
        if (!project) return
        const v = await form.validateFields()
        setSaving(true)
        try {
          const out = await updateProject(token, project.id, {
            name: v.name.trim(),
            disk_path: v.disk_path.trim(),
            log_dir: (v.log_dir || '').trim() || null,
          })
          onSaved(out)
        } finally {
          setSaving(false)
        }
      }}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 12 }} requiredMark={false}>
        <Form.Item name="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
          <Input placeholder="例如：Janus 前端" />
        </Form.Item>
        <Form.Item
          name="disk_path"
          label="本地工程路径"
          rules={[{ required: true, message: '请输入本地磁盘绝对路径' }]}
          extra="路径必须已存在于后端运行的本机"
        >
          <FolderPathInput placeholder="D:/dev/my-project" />
        </Form.Item>
        <Form.Item
          name="log_dir"
          label="日志目录"
          extra="相对工程路径的子目录；浏览时限制在项目磁盘内。留空表示未配置。"
        >
          <FolderPathInput
            placeholder="例如 logs 或 var/log"
            rootPath={diskWatch || project?.disk_path}
            relative
            pickerTitle="选择项目内日志目录"
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}

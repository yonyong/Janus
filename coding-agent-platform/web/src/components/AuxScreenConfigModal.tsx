import { Form, Modal, Radio, Select, Typography } from 'antd'
import { AUX_TAB_OPTIONS, type AuxTab } from './FileWorkArea'
import type { AuxMode } from './auxScreen'

export type AuxScreenConfig = {
  left: AuxTab | null
  right: AuxTab | null
  mode: AuxMode
}

export default function AuxScreenConfigModal({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean
  onCancel: () => void
  onConfirm: (cfg: AuxScreenConfig) => void
}) {
  const [form] = Form.useForm()

  return (
    <Modal
      title="新建副屏"
      open={open}
      onCancel={onCancel}
      okText="创建"
      cancelText="取消"
      destroyOnClose
      afterOpenChange={(v) => {
        if (v) form.setFieldsValue({ left: 'code', right: null, mode: 'docked' })
      }}
      onOk={async () => {
        const v = await form.validateFields()
        onConfirm({
          left: v.left || null,
          right: v.right || null,
          mode: v.mode,
        })
      }}
    >
      <Form form={form} layout="vertical" requiredMark={false} style={{ marginTop: 12 }}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          可只选一侧：单 tab 时副屏全屏展示；左右都选则为双栏。
        </Typography.Paragraph>
        <Form.Item
          name="left"
          label="左侧展示"
          dependencies={['right']}
          rules={[
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (value || getFieldValue('right')) return Promise.resolve()
                return Promise.reject(new Error('请至少选择一个 tab'))
              },
            }),
          ]}
        >
          <Select allowClear placeholder="可选" options={AUX_TAB_OPTIONS} />
        </Form.Item>
        <Form.Item
          name="right"
          label="右侧展示"
          dependencies={['left']}
          rules={[
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (value || getFieldValue('left')) return Promise.resolve()
                return Promise.reject(new Error('请至少选择一个 tab'))
              },
            }),
          ]}
        >
          <Select allowClear placeholder="可选" options={AUX_TAB_OPTIONS} />
        </Form.Item>
        <Form.Item name="mode" label="打开方式" rules={[{ required: true }]}>
          <Radio.Group
            options={[
              { value: 'docked', label: '钉在工作台' },
              { value: 'popup', label: '弹出新标签页' },
            ]}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}

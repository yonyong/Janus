/**
 * 由 assets/janus-icon.svg 生成 Windows 图标资源。
 *
 * 零 Python 依赖：sharp 负责矢量光栅化与降采样，ICO 容器用纯 Node 二进制拼接。
 * 输出：
 *   assets/janus.ico        —— 多尺寸图标（16/24/32/48/64/128/256），供 PyInstaller --icon 与窗口图标使用
 *   assets/janus-512.png    —— 预览用大图
 *
 * 用法：node tools/make_icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// sharp 安装在 WorkBuddy 的隔离 Node 工作区，不污染项目 node_modules
const require = createRequire('C:/Users/yd236/.workbuddy/binaries/node/workspace/');
const sharp = require('sharp');

const ROOT = path.resolve(import.meta.dirname, '..');
const SVG = path.join(ROOT, 'assets', 'janus-icon.svg');
const OUT_ICO = path.join(ROOT, 'assets', 'janus.ico');
const OUT_PNG = path.join(ROOT, 'assets', 'janus-512.png');

// ICO 里 256 需要写成 0（单字节存不下）
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  if (!fs.existsSync(SVG)) throw new Error(`缺少矢量源文件：${SVG}`);
  const svg = fs.readFileSync(SVG);

  // SVG 自带 width/height=1024，sharp 按 1024 光栅化后再降采样，等效超采样，边缘干净
  const frames = [];
  for (const size of SIZES) {
    const buf = await sharp(svg)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    frames.push({ size, buf });
  }

  // ---- 组装 ICO ----
  // ICONDIR(6B) + ICONDIRENTRY(16B * n) + 各帧 PNG 数据
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved，必须为 0
  header.writeUInt16LE(1, 2); // type，1 = icon
  header.writeUInt16LE(frames.length, 4);

  const entries = [];
  let offset = 6 + 16 * frames.length;
  for (const { size, buf } of frames) {
    const e = Buffer.alloc(16);
    const dim = size >= 256 ? 0 : size;
    e.writeUInt8(dim, 0); // width
    e.writeUInt8(dim, 1); // height
    e.writeUInt8(0, 2); // 调色板数，PNG 帧写 0
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(buf.length, 8); // 该帧字节数
    e.writeUInt32LE(offset, 12); // 该帧起始偏移
    offset += buf.length;
    entries.push(e);
  }

  const ico = Buffer.concat([header, ...entries, ...frames.map((f) => f.buf)]);
  fs.writeFileSync(OUT_ICO, ico);

  await sharp(svg).resize(512, 512).png().toFile(OUT_PNG);

  console.log(`已生成 ${path.relative(ROOT, OUT_ICO)}（${frames.length} 尺寸，${(ico.length / 1024).toFixed(1)} KB）`);
  console.log(`已生成 ${path.relative(ROOT, OUT_PNG)}`);
}

main().catch((err) => {
  console.error('生成图标失败：', err.message);
  process.exit(1);
});

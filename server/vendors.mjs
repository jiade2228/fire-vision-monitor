const encode = (value) => encodeURIComponent(value);
const channel2 = (channel) => String(channel).padStart(2, '0');

function credentials(username, password, host, port) {
  return `rtsp://${encode(username)}:${encode(password)}@${host}:${port}`;
}

export const VENDOR_ADAPTERS = [
  {
    id: 'hikvision',
    name: '海康威视 / Annke / Swann / 华为坤灵',
    group: '海康兼容',
    defaultPort: 554,
    singleChannel: false,
    supportsSubstream: true,
    hint: 'NVR 通道使用 /Streaming/Channels/通道0码流；1 通道子码流为 102。',
    build: ({ username, password, host, port, channel, stream }) =>
      `${credentials(username, password, host, port)}/Streaming/Channels/${channel}${
        stream === 'main' ? '01' : '02'
      }`,
  },
  {
    id: 'dahua',
    name: '大华 / Amcrest / Lorex / Imou',
    group: '大华兼容',
    defaultPort: 554,
    singleChannel: false,
    supportsSubstream: true,
    hint: '使用 /cam/realmonitor?channel=通道&subtype=0 主码流、1 子码流。',
    build: ({ username, password, host, port, channel, stream }) =>
      `${credentials(username, password, host, port)}/cam/realmonitor?channel=${channel}&subtype=${
        stream === 'main' ? 0 : 1
      }`,
  },
  {
    id: 'uniview',
    name: '宇视 UNV',
    group: '宇视',
    defaultPort: 554,
    singleChannel: false,
    supportsSubstream: true,
    hint: '通用固件路径 /unicast/c通道/s0/live，子码流把 s0 改为 s1。',
    build: ({ username, password, host, port, channel, stream }) =>
      `${credentials(username, password, host, port)}/unicast/c${channel}/s${
        stream === 'main' ? 0 : 1
      }/live`,
  },
  {
    id: 'reolink',
    name: 'Reolink',
    group: 'Reolink',
    defaultPort: 554,
    singleChannel: false,
    supportsSubstream: true,
    hint: 'NVR 通常使用 /h264Preview_01_main，子码流替换为 _sub。',
    build: ({ username, password, host, port, channel, stream }) =>
      `${credentials(username, password, host, port)}/h264Preview_${channel2(channel)}_${
        stream === 'main' ? 'main' : 'sub'
      }`,
  },
  {
    id: 'hanwha',
    name: '韩华 / Samsung Wisenet 摄像机',
    group: '韩华',
    defaultPort: 554,
    singleChannel: true,
    supportsSubstream: true,
    hint: '单机位路径 /profile1/media.smp；子码流使用 profile2。',
    build: ({ username, password, host, port, stream }) =>
      `${credentials(username, password, host, port)}/profile${
        stream === 'main' ? 1 : 2
      }/media.smp`,
  },
  {
    id: 'axis',
    name: 'Axis 安讯士',
    group: 'Axis',
    defaultPort: 554,
    singleChannel: true,
    supportsSubstream: false,
    hint: '/axis-media/media.amp 为通用单机位地址，实际编码由摄像机配置决定。',
    build: ({ username, password, host, port }) =>
      `${credentials(username, password, host, port)}/axis-media/media.amp`,
  },
  {
    id: 'tplink',
    name: 'TP-Link Tapo',
    group: 'TP-Link',
    defaultPort: 554,
    singleChannel: true,
    supportsSubstream: true,
    hint: 'Tapo 需在 App 中创建独立的摄像机账号；主码流 /stream1，子码流 /stream2。',
    build: ({ username, password, host, port, stream }) =>
      `${credentials(username, password, host, port)}/stream${stream === 'main' ? 1 : 2}`,
  },
  {
    id: 'foscam',
    name: 'Foscam',
    group: 'Foscam',
    defaultPort: 554,
    singleChannel: true,
    supportsSubstream: true,
    hint: '主码流 /videoMain，子码流 /videoSub；老固件可能是 /11、/12。',
    build: ({ username, password, host, port, stream }) =>
      `${credentials(username, password, host, port)}/${
        stream === 'main' ? 'videoMain' : 'videoSub'
      }`,
  },
  {
    id: 'vivotek',
    name: 'Vivotek 晶睿',
    group: 'Vivotek',
    defaultPort: 554,
    singleChannel: true,
    supportsSubstream: true,
    hint: '通用路径 /live.sdp；部分型号子码流为 /live2.sdp。',
    build: ({ username, password, host, port, stream }) =>
      `${credentials(username, password, host, port)}/${
        stream === 'main' ? 'live.sdp' : 'live2.sdp'
      }`,
  },
  {
    id: 'bosch',
    name: 'Bosch 博世',
    group: 'Bosch',
    defaultPort: 554,
    singleChannel: true,
    supportsSubstream: true,
    hint: '常用单机位 /video?inst=1&rec=0，子码流使用 inst=2；不同固件可能不同。',
    build: ({ username, password, host, port, stream }) =>
      `${credentials(username, password, host, port)}/video?inst=${
        stream === 'main' ? 1 : 2
      }&rec=0`,
  },
  {
    id: 'eufy',
    name: 'Eufy',
    group: 'Eufy',
    defaultPort: 554,
    singleChannel: true,
    supportsSubstream: true,
    hint: '需在 App 中开启 RTSP；主码流 /live0，子码流 /live1。',
    build: ({ username, password, host, port, stream }) =>
      `${credentials(username, password, host, port)}/live${stream === 'main' ? 0 : 1}`,
  },
  {
    id: 'geovision',
    name: 'GeoVision',
    group: 'GeoVision',
    defaultPort: 8554,
    singleChannel: true,
    supportsSubstream: false,
    hint: '默认 RTSP 端口可能为 8554，路径 /CH001.sdp。',
    build: ({ username, password, host, port }) =>
      `${credentials(username, password, host, port)}/CH001.sdp`,
  },
  {
    id: 'custom',
    name: '自定义 RTSP 模板',
    group: '其他 / OEM',
    defaultPort: 554,
    singleChannel: false,
    supportsSubstream: true,
    custom: true,
    hint:
      '支持 {user} {password} {host} {port} {channel} {stream} 占位符，适用于未列出的品牌和私有固件。',
    build: () => '',
  },
];

export const VENDORS_BY_ID = new Map(VENDOR_ADAPTERS.map((vendor) => [vendor.id, vendor]));

export function publicVendors() {
  return VENDOR_ADAPTERS.map(({ build: _build, ...vendor }) => vendor);
}

export function buildVendorUrl(vendor, options) {
  if (vendor.id === 'custom') {
    const template =
      typeof options.template === 'string' ? options.template.trim() : '';
    if (!template) throw new Error('请填写自定义 RTSP 模板');
    if (!/^rtsps?:\/\//i.test(template)) {
      throw new Error('自定义 RTSP 模板必须以 rtsp:// 或 rtsps:// 开头');
    }
    if (/[\r\n]/.test(template)) throw new Error('自定义模板包含非法字符');
    const streamNumber = options.stream === 'main' ? '0' : '1';
    const url = template
      .replaceAll('{user}', encode(options.username))
      .replaceAll('{password}', encode(options.password))
      .replaceAll('{host}', options.host)
      .replaceAll('{port}', String(options.port))
      .replaceAll('{channel}', String(options.channel))
      .replaceAll('{stream}', options.stream)
      .replaceAll('{streamNum}', streamNumber);
    if (!/^rtsps?:\/\//i.test(url)) throw new Error('生成的地址不是有效 RTSP 地址');
    return url;
  }
  return vendor.build(options);
}

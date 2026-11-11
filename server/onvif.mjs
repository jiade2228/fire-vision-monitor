import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { assertOutboundUrl, guardedFetch } from './net-guard.mjs';

/**
 * ONVIF 设备主机格式校验。
 *
 * 只接受纯主机名、IPv4 字面量与带方括号的 IPv6 字面量；杜绝
 * `user@host`（userinfo）、路径、查询串等注入手法——它们会让
 * `http://${host}` 拼出的地址指向与用户预期不同的主机。
 *
 * @param {string} host 主机字符串。
 * @returns {boolean} 是否为合法主机。
 */
function isValidOnvifHost(host) {
  const value = String(host ?? '').trim();
  if (!value || value.length > 253) return false;
  if (value.includes('/') || value.includes('@') || value.includes('?')) return false;
  if (value.includes('[') || value.includes(']')) {
    return /^\[[0-9A-Fa-f:.]+\]$/.test(value);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) <= 255);
  }
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
    value,
  );
}

/**
 * 构造设备基础地址（http://host:port）。
 *
 * @param {string} host 主机（IPv6 需带方括号）。
 * @param {number} port 端口。
 * @returns {string} 形如 http://10.0.0.1:80 的前缀（末尾无斜杠）。
 */
function buildDeviceBaseUrl(host, port) {
  const url = new URL('http://placeholder.invalid');
  url.hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  url.port = String(port);
  return url.origin;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  textNodeName: '#text',
});

function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object') {
    if ('#text' in node) return String(node['#text']);
    if (Array.isArray(node)) return textOf(node[0]);
  }
  return '';
}

function attrOf(node, name) {
  if (!node || typeof node !== 'object') return '';
  return node[`@_${name}`] ?? node[name] ?? '';
}

// ONVIF 使用 WS-Security UsernameToken + PasswordDigest。
function buildSecurityToken(username, password) {
  if (!username) return '';
  const nonceBytes = crypto.randomBytes(16);
  const nonce = nonceBytes.toString('base64');
  const created = new Date().toISOString();
  const digest = crypto
    .createHash('sha1')
    .update(
      Buffer.concat([
        nonceBytes,
        Buffer.from(created, 'utf8'),
        Buffer.from(password || '', 'utf8'),
      ]),
    )
    .digest('base64');
  return `<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" soap:mustUnderstand="1">
  <wsse:UsernameToken wsu:Id="Unt-${nonceBytes.slice(0, 4).toString('hex')}">
    <wsse:Username>${username}</wsse:Username>
    <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>
    <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce}</wsse:Nonce>
    <wsu:Created>${created}</wsu:Created>
  </wsse:UsernameToken>
</wsse:Security>`;
}

/**
 * 构造 SOAP 信封。
 *
 * ONVIF 规范早期版本基于 SOAP 1.1（`schemas.xmlsoap.org`，Content-Type 为
 * text/xml + SOAPAction 头），2.0 起改用 SOAP 1.2（`w3.org/2003/05`，
 * application/soap+xml，动作放在 Content-Type 的 action 参数里）。
 * 国产与老款设备常只实现 1.1：直接用 1.2 会收到 400/415，表现为「扫描不到设备」。
 *
 * @param {string} bodyXml Body 内容。
 * @param {{username?:string,password?:string}} credentials 凭据。
 * @param {'1.1'|'1.2'} version SOAP 版本。
 * @returns {string} 完整 XML。
 */
function buildEnvelope(bodyXml, credentials, version = '1.2') {
  const security = buildSecurityToken(credentials?.username, credentials?.password);
  const envelopeNs =
    version === '1.1'
      ? 'http://schemas.xmlsoap.org/soap/envelope/'
      : 'http://www.w3.org/2003/05/soap-envelope';
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="${envelopeNs}">
  <soap:Header>${security}</soap:Header>
  <soap:Body>${bodyXml}</soap:Body>
</soap:Envelope>`;
}

/**
 * 发送 SOAP 请求；SOAP 1.2 被拒（400/415/500）时自动用 1.1 重试一次。
 *
 * @param {string} url 目标地址。
 * @param {string} action 动作名。
 * @param {string} bodyXml Body。
 * @param {object} credentials 凭据。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<object>} 解析后的 XML。
 */
async function soapRequest(url, action, bodyXml, credentials, timeoutMs = 8000) {
  const attempt = async (version) => {
    const headers =
      version === '1.1'
        ? {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction: `"${action}"`,
          }
        : {
            'Content-Type': `application/soap+xml; charset=utf-8; action="${action}"`,
            SOAPAction: `"${action}"`,
          };
    const response = await guardedFetch(url, {
      method: 'POST',
      headers,
      body: buildEnvelope(bodyXml, credentials, version),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const xml = await response.text();
    return { ok: response.ok, status: response.status, xml };
  };

  const first = await attempt('1.2');
  if (first.ok) return parser.parse(first.xml);
  // 仅对这些状态回退 1.1：认证失败(401/403)回退无意义，还会掩盖凭据问题。
  if ([400, 415, 500, 501].includes(first.status)) {
    const second = await attempt('1.1');
    if (second.ok) return parser.parse(second.xml);
    throw new Error(`ONVIF ${action} 返回 HTTP ${second.status}（已尝试 SOAP 1.2/1.1）`);
  }
  throw new Error(`ONVIF ${action} 返回 HTTP ${first.status}`);
}

async function getStreamUri(mediaUrl, token, credentials) {
  if (!token) return { rtspUri: '', snapshotUri: '' };
  const streamXml = `<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl"><StreamSetup xmlns="http://www.onvif.org/ver10/media/wsdl"><Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream><Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol xmlns="http://www.onvif.org/ver10/schema">RTSP</Protocol></Transport></StreamSetup><ProfileToken>${token}</ProfileToken></GetStreamUri>`;
  try {
    const sr = await soapRequest(
      mediaUrl,
      'http://www.onvif.org/ver10/media/wsdl/GetStreamUri',
      streamXml,
      credentials,
    );
    const mediaUri = sr?.Envelope?.Body?.GetStreamUriResponse?.MediaUri;
    return { rtspUri: textOf(mediaUri?.Uri) };
  } catch {
    return { rtspUri: '' };
  }
}

async function getSnapshotUri(mediaUrl, token, credentials) {
  if (!token) return '';
  const snapXml = `<GetSnapshotUri xmlns="http://www.onvif.org/ver10/media/wsdl"><ProfileToken>${token}</ProfileToken></GetSnapshotUri>`;
  try {
    const snr = await soapRequest(
      mediaUrl,
      'http://www.onvif.org/ver10/media/wsdl/GetSnapshotUri',
      snapXml,
      credentials,
    );
    const mediaUri = snr?.Envelope?.Body?.GetSnapshotUriResponse?.MediaUri;
    return textOf(mediaUri?.Uri);
  } catch {
    return '';
  }
}

export async function discoverDevice(target) {
  const host = String(target.host || '').trim();
  const port = Number(target.port) || 80;
  if (!host) throw new Error('缺少设备主机地址');
  const username = target.username ?? '';
  const password = target.password ?? '';
  const credentials = { username, password };
  // 主机必须是纯主机名 / IPv4 / [IPv6]：杜绝 userinfo（user@host）与路径注入，
  // 否则 http://${host} 拼出的地址可能指向与用户预期不同的主机。
  if (!isValidOnvifHost(host)) {
    throw new Error('设备主机格式无效');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('设备端口无效');
  }
  // 出网主机校验：必须在 URL 构造**之后**用规范化后的地址判定。
  // 旧实现对原始 host 字符串校验，而下方 buildDeviceBaseUrl 会经 WHATWG URL
  // 把 `2852039166` / `0xa9fea9fe` 等编码规范化成 169.254.169.254 —— 校验对象
  // 与实际连接对象不一致，构成云元数据绕过（check-use separation）。
  const base = buildDeviceBaseUrl(host, port);
  const deviceUrl = `${base}/onvif/device_service`;
  const mediaUrl = `${base}/onvif/media_service`;
  const checked = assertOutboundUrl(deviceUrl, {
    allowPrivate: true,
    allowLoopback: true,
    allowLinkLocal: true,
  });
  if (checked.error) throw new Error(`设备主机被拒绝：${checked.error}`);

  let manufacturer = '';
  let model = '';
  let firmware = '';
  try {
    const di = await soapRequest(
      deviceUrl,
      'http://www.onvif.org/ver10/device/wsdl/GetDeviceInformation',
      `<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>`,
      credentials,
    );
    const r = di?.Envelope?.Body?.GetDeviceInformationResponse || {};
    manufacturer = textOf(r.Manufacturer);
    model = textOf(r.Model);
    firmware = textOf(r.FirmwareVersion);
  } catch {
    // 设备信息可选，取不到不影响取流。
  }

  const gp = await soapRequest(
    mediaUrl,
    'http://www.onvif.org/ver10/media/wsdl/GetProfiles',
    `<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>`,
    credentials,
  );
  const resp = gp?.Envelope?.Body?.GetProfilesResponse || {};
  const list = resp.Profiles
    ? Array.isArray(resp.Profiles)
      ? resp.Profiles
      : [resp.Profiles]
    : [];
  const profiles = [];
  for (const p of list) {
    const token = attrOf(p, 'token') || textOf(p.token);
    if (!token) continue;
    const name = textOf(p.Name) || token;
    const { rtspUri } = await getStreamUri(mediaUrl, token, credentials);
    const snapshotUri = await getSnapshotUri(mediaUrl, token, credentials);
    profiles.push({ token, name, rtspUri, snapshotUri });
  }
  return { host, port, manufacturer, model, firmware, profiles };
}

export async function discoverDevices(targets, { concurrency = 8 } = {}) {
  const safe = targets.slice(0, 256);
  const results = [];
  for (let i = 0; i < safe.length; i += concurrency) {
    const batch = safe.slice(i, i + concurrency);
    const settled = await Promise.all(
      batch.map(async (target) => {
        try {
          const device = await discoverDevice(target);
          return { ok: true, target, device };
        } catch (error) {
          return { ok: false, target, error: error.message };
        }
      }),
    );
    results.push(...settled);
  }
  return results;
}

import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

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

function buildEnvelope(bodyXml, credentials) {
  const security = buildSecurityToken(credentials?.username, credentials?.password);
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Header>${security}</soap:Header>
  <soap:Body>${bodyXml}</soap:Body>
</soap:Envelope>`;
}

async function soapRequest(url, action, bodyXml, credentials, timeoutMs = 8000) {
  const envelope = buildEnvelope(bodyXml, credentials);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/soap+xml; charset=utf-8',
      SOAPAction: `"${action}"`,
    },
    body: envelope,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const xml = await response.text();
  if (!response.ok) {
    throw new Error(`ONVIF ${action} 返回 HTTP ${response.status}`);
  }
  return parser.parse(xml);
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
  const base = `http://${host}:${port}`;
  const deviceUrl = `${base}/onvif/device_service`;
  const mediaUrl = `${base}/onvif/media_service`;

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

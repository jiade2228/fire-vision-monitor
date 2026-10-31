import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  textNodeName: '#text',
});

const DEFAULT_ADDRESS = '239.255.255.250';
const DEFAULT_PORT = 3702;

function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'object') {
    if ('#text' in node) return String(node['#text']);
    if ('@_Item' in node) return String(node['@_Item']);
  }
  return '';
}

function scopeValue(scopes, key) {
  for (const scope of scopes) {
    const match = String(scope).match(new RegExp(`/${key}/([^/]+)`, 'i'));
    if (!match) continue;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return '';
}

function safeHostname(value) {
  return /^[a-zA-Z0-9.-]{1,253}$/.test(value) ? value : '';
}

/** 解析一条 WS-Discovery ProbeMatches 响应；无效响应返回空数组。 */
export function parseProbeMatches(xml) {
  let document;
  try {
    document = parser.parse(String(xml));
  } catch {
    return [];
  }
  const matches = document?.Envelope?.Body?.ProbeMatches?.ProbeMatch;
  const list = matches ? (Array.isArray(matches) ? matches : [matches]) : [];
  const devices = [];
  for (const match of list) {
    const xaddrs = textOf(match?.XAddrs)
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const scopes = textOf(match?.Scopes).split(/\s+/).filter(Boolean);
    const addresses = [];
    for (const xaddr of xaddrs) {
      try {
        const url = new URL(xaddr);
        if (!['http:', 'https:'].includes(url.protocol)) continue;
        const host = safeHostname(url.hostname);
        if (!host) continue;
        addresses.push({
          xaddr,
          host,
          port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
        });
      } catch {
        // 跳过厂商返回的异常地址，不影响其他设备。
      }
    }
    if (addresses.length === 0) continue;
    const name =
      scopeValue(scopes, 'name') ||
      scopeValue(scopes, 'hardware') ||
      scopeValue(scopes, 'model');
    devices.push({
      host: addresses[0].host,
      port: addresses[0].port,
      xaddrs: addresses.map((item) => item.xaddr),
      name,
      manufacturer: scopeValue(scopes, 'manufacturer'),
      types: textOf(match?.Types),
      endpoint: textOf(match?.EndpointReference?.Address),
      scopes,
    });
  }
  return devices;
}

function buildProbe(messageId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
  xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
  xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
  xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>uuid:${messageId}</w:MessageID>
    <w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>
</e:Envelope>`;
}

/**
 * 通过 WS-Discovery 组播发现 ONVIF 设备。
 * 默认 239.255.255.250:3702；测试可用参数或环境变量改到本地 UDP 模拟器。
 */
export function discoverOnvifDevices({
  timeoutMs = 4000,
  address = process.env.ONVIF_DISCOVERY_ADDRESS || DEFAULT_ADDRESS,
  port = Number(process.env.ONVIF_DISCOVERY_PORT) || DEFAULT_PORT,
  listenAddress = '0.0.0.0',
  repeat = 2,
} = {}) {
  const duration = Math.min(Math.max(Number(timeoutMs) || 4000, 500), 15_000);
  const attempts = Math.min(Math.max(Number(repeat) || 2, 1), 4);
  const targetPort = Math.min(Math.max(Number(port) || DEFAULT_PORT, 1), 65_535);
  const probe = Buffer.from(buildProbe(crypto.randomUUID()));
  const devices = new Map();

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    let interval = null;
    let timer = null;

    const close = () => {
      if (interval) clearInterval(interval);
      if (timer) clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // 已关闭
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      close();
      resolve(
        [...devices.values()].sort((a, b) =>
          a.host.localeCompare(b.host, undefined, { numeric: true }),
        ),
      );
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      close();
      reject(error);
    };

    socket.on('error', fail);
    socket.on('message', (message) => {
      for (const device of parseProbeMatches(message.toString('utf8'))) {
        const current = devices.get(device.host);
        if (current) {
          current.xaddrs = [...new Set([...current.xaddrs, ...device.xaddrs])];
          current.name ||= device.name;
          current.manufacturer ||= device.manufacturer;
        } else {
          devices.set(device.host, device);
        }
      }
    });

    socket.bind(0, listenAddress, () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(4);
      } catch {
        // 部分系统/单播测试地址不支持这些选项，不影响收发。
      }
      let sent = 0;
      const send = () => {
        if (settled || sent >= attempts) return;
        sent += 1;
        socket.send(probe, 0, probe.length, targetPort, address, (error) => {
          if (error) fail(error);
        });
      };
      send();
      if (attempts > 1) {
        interval = setInterval(send, Math.max(300, Math.floor(duration / attempts)));
      }
      timer = setTimeout(finish, duration);
      timer.unref?.();
    });
  });
}

import type {
  Connection,
  ConnectionsSnapshot,
  LogEntry,
  MihomoConfig,
  ProxyNode,
  ProxyProvider,
  Rule,
  Traffic,
} from './types';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const sampleTime = Date.parse('2026-10-07T14:32:00+08:00');

function history(delay: number): ProxyNode['history'] {
  return [-5, 2, -2, 4, 0].map((offset, index) => ({
    time: new Date(sampleTime - (4 - index) * 60_000).toISOString(),
    delay: delay === 0 ? 0 : delay + offset,
  }));
}

function node(name: string, type: string, delay: number): ProxyNode {
  return { name, type, history: history(delay), udp: true, alive: delay > 0 };
}

const nodes: ProxyNode[] = [
  node('🇭🇰 香港 01 · 高速专线', 'Shadowsocks', 24),
  node('🇭🇰 香港 02 · 流媒体', 'Trojan', 31),
  node('🇭🇰 香港 03 · IPLC', 'VLESS', 28),
  node('🇯🇵 东京 01 · 高速专线', 'VLESS', 58),
  node('🇯🇵 东京 02 · 流媒体', 'Trojan', 67),
  node('🇯🇵 大阪 01 · 精品线路', 'Shadowsocks', 72),
  node('🇸🇬 新加坡 01 · 高速专线', 'Hysteria2', 49),
  node('🇸🇬 新加坡 02 · AI 服务', 'VLESS', 53),
  node('🇸🇬 新加坡 03 · 流媒体', 'Trojan', 61),
  node('🇺🇸 洛杉矶 01 · 高速专线', 'Hysteria2', 158),
  node('🇺🇸 圣何塞 01 · AI 服务', 'VLESS', 172),
  node('🇺🇸 西雅图 01 · 备用线路', 'Shadowsocks', 196),
  node('🇩🇪 法兰克福 01 · 欧洲专线', 'Trojan', 238),
  node('🇬🇧 伦敦 01 · 维护中', 'VLESS', 0),
];

const names = nodes.map((item) => item.name);

function group(name: string, type: string, all: string[], now: string, delay: number): ProxyNode {
  return { name, type, all, now, history: history(delay), udp: true, alive: true };
}

export const demoConfig: MihomoConfig = {
  mode: 'rule',
  'mixed-port': 7890,
  port: 7891,
  'socks-port': 7892,
  'allow-lan': false,
  'bind-address': '*',
  'external-controller': '127.0.0.1:9090',
  ipv6: false,
  'log-level': 'info',
  'unified-delay': true,
  'tcp-concurrent': true,
  'find-process-mode': 'strict',
  tun: { enable: false, stack: 'mixed', 'auto-route': true, 'auto-detect-interface': true },
};

export const demoProxies: Record<string, ProxyNode> = Object.fromEntries(
  [
    group(
      'GLOBAL',
      'Selector',
      ['🚀 节点选择', '♻️ 自动选择', 'DIRECT', ...names],
      '🚀 节点选择',
      24,
    ),
    group('🚀 节点选择', 'Selector', ['♻️ 自动选择', ...names, 'DIRECT'], names[0]!, 24),
    group(
      '♻️ 自动选择',
      'URLTest',
      names.filter((name) => !name.includes('维护中')),
      names[0]!,
      24,
    ),
    group('🎬 流媒体', 'Selector', [names[4]!, names[1]!, names[8]!, names[9]!], names[4]!, 67),
    group('🤖 AI 服务', 'Selector', [names[7]!, names[10]!, names[9]!, names[6]!], names[7]!, 53),
    group('🌐 全球直连', 'Selector', ['DIRECT', '🚀 节点选择'], 'DIRECT', 8),
    group('🛡️ 广告拦截', 'Selector', ['REJECT', 'DIRECT'], 'REJECT', 0),
    group('🐟 漏网之鱼', 'Selector', ['🚀 节点选择', '🌐 全球直连'], '🚀 节点选择', 24),
    { name: 'DIRECT', type: 'Direct', history: history(8), udp: true, alive: true },
    { name: 'REJECT', type: 'Reject', history: [], udp: true, alive: true },
    ...nodes,
  ].map((proxy) => [proxy.name, proxy]),
);

export const demoProviders: Record<string, ProxyProvider> = {
  星海网络: {
    name: '星海网络',
    type: 'Proxy',
    vehicleType: 'HTTP',
    proxies: nodes.slice(0, 9),
    updatedAt: '2026-10-07T14:20:00+08:00',
    subscriptionInfo: {
      Upload: 8.6 * GiB,
      Download: 76.2 * GiB,
      Total: 300 * GiB,
      Expire: Date.parse('2026-11-07T00:00:00+08:00') / 1000,
    },
  },
  远山专线: {
    name: '远山专线',
    type: 'Proxy',
    vehicleType: 'HTTP',
    proxies: nodes.slice(9),
    updatedAt: '2026-10-07T13:45:00+08:00',
    subscriptionInfo: {
      Upload: 2.3 * GiB,
      Download: 28.5 * GiB,
      Total: 150 * GiB,
      Expire: Date.parse('2026-12-01T00:00:00+08:00') / 1000,
    },
  },
};

export const demoRules: Rule[] = [
  { type: 'DomainSuffix', payload: 'doubleclick.net', proxy: '🛡️ 广告拦截' },
  { type: 'DomainSuffix', payload: 'googlesyndication.com', proxy: '🛡️ 广告拦截' },
  { type: 'DomainSuffix', payload: 'openai.com', proxy: '🤖 AI 服务' },
  { type: 'DomainSuffix', payload: 'chatgpt.com', proxy: '🤖 AI 服务' },
  { type: 'DomainSuffix', payload: 'anthropic.com', proxy: '🤖 AI 服务' },
  { type: 'DomainSuffix', payload: 'claude.ai', proxy: '🤖 AI 服务' },
  { type: 'DomainSuffix', payload: 'youtube.com', proxy: '🎬 流媒体' },
  { type: 'DomainSuffix', payload: 'googlevideo.com', proxy: '🎬 流媒体' },
  { type: 'DomainSuffix', payload: 'netflix.com', proxy: '🎬 流媒体' },
  { type: 'DomainSuffix', payload: 'spotify.com', proxy: '🎬 流媒体' },
  { type: 'DomainSuffix', payload: 'github.com', proxy: '🚀 节点选择' },
  { type: 'DomainSuffix', payload: 'githubusercontent.com', proxy: '🚀 节点选择' },
  { type: 'DomainSuffix', payload: 'google.com', proxy: '🚀 节点选择' },
  { type: 'DomainSuffix', payload: 'telegram.org', proxy: '🚀 节点选择' },
  { type: 'DomainSuffix', payload: 'apple.com', proxy: '🌐 全球直连' },
  { type: 'DomainSuffix', payload: 'icloud.com', proxy: '🌐 全球直连' },
  { type: 'DomainSuffix', payload: 'bilibili.com', proxy: '🌐 全球直连' },
  { type: 'DomainSuffix', payload: 'qq.com', proxy: '🌐 全球直连' },
  { type: 'DomainSuffix', payload: 'taobao.com', proxy: '🌐 全球直连' },
  { type: 'Domain', payload: 'localhost', proxy: 'DIRECT' },
  { type: 'IPCIDR', payload: '127.0.0.0/8', proxy: 'DIRECT' },
  { type: 'IPCIDR', payload: '192.168.0.0/16', proxy: 'DIRECT' },
  { type: 'IPCIDR', payload: '10.0.0.0/8', proxy: 'DIRECT' },
  { type: 'GeoIP', payload: 'CN', proxy: '🌐 全球直连' },
  { type: 'Match', payload: '', proxy: '🐟 漏网之鱼' },
];

interface DemoConnection {
  host: string;
  ip: string;
  process: string;
  download: number;
  upload: number;
  chains: string[];
  rulePayload: string;
  age: number;
  udp?: boolean;
}

const connectionSamples: DemoConnection[] = [
  {
    host: 'github.com',
    ip: '140.82.113.3',
    process: 'chrome',
    download: 2.8 * MiB,
    upload: 184_320,
    chains: [names[0]!, '🚀 节点选择'],
    rulePayload: 'github.com',
    age: 128,
  },
  {
    host: 'rr3---sn-a5mekn6z.googlevideo.com',
    ip: '142.250.196.206',
    process: 'chrome',
    download: 126.4 * MiB,
    upload: 2.1 * MiB,
    chains: [names[4]!, '🎬 流媒体'],
    rulePayload: 'googlevideo.com',
    age: 347,
    udp: true,
  },
  {
    host: 'api.openai.com',
    ip: '172.66.0.243',
    process: 'Code',
    download: 1.6 * MiB,
    upload: 483_328,
    chains: [names[7]!, '🤖 AI 服务'],
    rulePayload: 'openai.com',
    age: 42,
  },
  {
    host: 'api.spotify.com',
    ip: '35.186.224.25',
    process: 'Spotify',
    download: 18.7 * MiB,
    upload: 262_144,
    chains: [names[4]!, '🎬 流媒体'],
    rulePayload: 'spotify.com',
    age: 212,
  },
  {
    host: 'avatars.githubusercontent.com',
    ip: '185.199.108.133',
    process: 'chrome',
    download: 847_872,
    upload: 24_576,
    chains: [names[0]!, '🚀 节点选择'],
    rulePayload: 'githubusercontent.com',
    age: 26,
  },
  {
    host: 'api.bilibili.com',
    ip: '203.107.1.66',
    process: 'chrome',
    download: 4.2 * MiB,
    upload: 121_856,
    chains: ['DIRECT', '🌐 全球直连'],
    rulePayload: 'bilibili.com',
    age: 86,
  },
  {
    host: 'gateway.icloud.com',
    ip: '17.248.156.5',
    process: 'cloudd',
    download: 623_616,
    upload: 3.2 * MiB,
    chains: ['DIRECT', '🌐 全球直连'],
    rulePayload: 'icloud.com',
    age: 583,
  },
  {
    host: 'claude.ai',
    ip: '160.79.104.10',
    process: 'chrome',
    download: 3.1 * MiB,
    upload: 958_464,
    chains: [names[7]!, '🤖 AI 服务'],
    rulePayload: 'claude.ai',
    age: 63,
  },
];

export const demoSnapshot: ConnectionsSnapshot = {
  downloadTotal: 3.42 * GiB,
  uploadTotal: 286.8 * MiB,
  memory: 68.4 * MiB,
  connections: connectionSamples.map((sample, index): Connection => ({
    id: `demo-connection-${index + 1}`,
    metadata: {
      network: sample.udp ? 'udp' : 'tcp',
      type: 'Mixed',
      sourceIP: '192.168.1.108',
      sourcePort: 53120 + index * 3,
      destinationIP: sample.ip,
      destinationPort: 443,
      host: sample.host,
      dnsMode: 'fake-ip',
      process: sample.process,
      processPath: `/Applications/${sample.process}.app/Contents/MacOS/${sample.process}`,
      inboundIP: '127.0.0.1',
      inboundPort: 7890,
    },
    upload: Math.round(sample.upload),
    download: Math.round(sample.download),
    start: new Date(Date.now() - sample.age * 1000).toISOString(),
    chains: sample.chains,
    rule: 'DomainSuffix',
    rulePayload: sample.rulePayload,
  })),
};

export const demoLogs: Array<LogEntry & { id: number; time: string }> = [
  { id: 1, time: '14:31:48', type: 'info', payload: 'Start initial compatible provider 星海网络' },
  { id: 2, time: '14:31:48', type: 'info', payload: 'Start initial compatible provider 远山专线' },
  {
    id: 3,
    time: '14:31:49',
    type: 'info',
    payload: 'Mixed(http+socks) proxy listening at: 127.0.0.1:7890',
  },
  {
    id: 4,
    time: '14:31:50',
    type: 'info',
    payload:
      '[TCP] 192.168.1.108:53120 --> github.com:443 match DomainSuffix(github.com) using 🚀 节点选择[🇭🇰 香港 01 · 高速专线]',
  },
  {
    id: 5,
    time: '14:31:52',
    type: 'info',
    payload:
      '[UDP] 192.168.1.108:53123 --> rr3---sn-a5mekn6z.googlevideo.com:443 match DomainSuffix(googlevideo.com) using 🎬 流媒体[🇯🇵 东京 02 · 流媒体]',
  },
  {
    id: 6,
    time: '14:31:54',
    type: 'debug',
    payload: '[DNS] api.openai.com --> 172.66.0.243 A from cache',
  },
  {
    id: 7,
    time: '14:31:54',
    type: 'info',
    payload:
      '[TCP] 192.168.1.108:53126 --> api.openai.com:443 match DomainSuffix(openai.com) using 🤖 AI 服务[🇸🇬 新加坡 02 · AI 服务]',
  },
  {
    id: 8,
    time: '14:31:55',
    type: 'warning',
    payload: 'Health check timeout: 🇬🇧 伦敦 01 · 维护中, keeping the current available proxy',
  },
  {
    id: 9,
    time: '14:31:57',
    type: 'info',
    payload:
      '[TCP] 192.168.1.108:53135 --> api.bilibili.com:443 match DomainSuffix(bilibili.com) using 🌐 全球直连[DIRECT]',
  },
  {
    id: 10,
    time: '14:31:58',
    type: 'debug',
    payload: '[DNS] claude.ai --> 160.79.104.10 A from cache',
  },
  {
    id: 11,
    time: '14:31:59',
    type: 'info',
    payload:
      '[TCP] 192.168.1.108:53141 --> claude.ai:443 match DomainSuffix(claude.ai) using 🤖 AI 服务[🇸🇬 新加坡 02 · AI 服务]',
  },
  {
    id: 12,
    time: '14:32:00',
    type: 'info',
    payload: 'Provider 星海网络 updated successfully, 9 proxies available',
  },
];

export function createDemoTraffic(tick: number): Traffic {
  const time = Number.isFinite(tick) ? tick : 0;
  const wave = (Math.sin(time / 6) + 1) / 2;
  const detail = (Math.sin(time / 1.9 + 0.6) + 1) / 2;
  const burst = Math.max(0, Math.sin(time / 11 - 1)) ** 8;
  return {
    up: Math.round((0.08 + wave * 0.22 + detail * 0.09 + burst * 0.7) * MiB),
    down: Math.round((0.8 + wave * 1.9 + detail * 0.65 + burst * 4.3) * MiB),
  };
}

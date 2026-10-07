/** The browser connects directly to this standard Mihomo external controller. */
export interface BackendProfile {
  url: string;
  secret: string;
}

export type ProxyMode = 'rule' | 'global' | 'direct';
export type LogLevel = 'debug' | 'info' | 'warning' | 'error' | 'silent';

export interface MihomoConfig {
  mode: ProxyMode;
  'mixed-port': number;
  'allow-lan': boolean;
  ipv6: boolean;
  'log-level': LogLevel;
  port?: number;
  'socks-port'?: number;
  'redir-port'?: number;
  'tproxy-port'?: number;
  'bind-address'?: string;
  'external-controller'?: string;
  'interface-name'?: string;
  'routing-mark'?: number;
  'unified-delay'?: boolean;
  'tcp-concurrent'?: boolean;
  'find-process-mode'?: string;
  sniffing?: boolean;
  tun?: {
    enable: boolean;
    stack?: string;
    device?: string;
    'auto-route'?: boolean;
    'auto-detect-interface'?: boolean;
  };
}

/** Writable runtime fields; a GET /configs response is not itself a PATCH body. */
export interface MihomoConfigPatch {
  mode?: ProxyMode;
  'log-level'?: LogLevel;
  ipv6?: boolean;
  port?: number;
  'socks-port'?: number;
  'redir-port'?: number;
  'tproxy-port'?: number;
  'mixed-port'?: number;
  'allow-lan'?: boolean;
  'bind-address'?: string;
  'tcp-concurrent'?: boolean;
  'find-process-mode'?: string;
  'interface-name'?: string;
  sniffing?: boolean;
  tun?: {
    /** Mihomo treats an omitted enable value as false during a TUN update. */
    enable: boolean;
    stack?: string;
    device?: string;
    'auto-route'?: boolean;
    'auto-detect-interface'?: boolean;
  };
}

export interface ProxyNode {
  name: string;
  type: string;
  now?: string;
  all?: string[];
  history: { time: string; delay: number }[];
  udp?: boolean;
  alive?: boolean;
  xudp?: boolean;
  uot?: boolean;
  tfo?: boolean;
  mptcp?: boolean;
  smux?: boolean;
  interface?: string;
  'routing-mark'?: number;
  'provider-name'?: string;
  'dialer-proxy'?: string;
  fixed?: string;
  testUrl?: string;
  hidden?: boolean;
  icon?: string;
  expectedStatus?: string;
  emptyFallback?: string;
  extra?: Record<string, { alive: boolean; history: { time: string; delay: number }[] | null }>;
}

export interface ProxiesResponse {
  proxies: Record<string, ProxyNode>;
}

export interface ProxyProvider {
  name: string;
  type: string;
  vehicleType: string;
  proxies: ProxyNode[];
  updatedAt?: string;
  subscriptionInfo?: {
    Upload: number;
    Download: number;
    Total: number;
    Expire: number;
  };
}

export interface Rule {
  index?: number;
  type: string;
  payload: string;
  proxy: string;
  size?: number;
  extra?: {
    disabled?: boolean;
    hitCount?: number;
    hitAt?: string;
    missCount?: number;
    missAt?: string;
  };
}

export interface RuleProvider {
  name: string;
  type: string;
  vehicleType: string;
  behavior: string;
  format: string;
  ruleCount: number;
  updatedAt?: string;
}

export interface Connection {
  id: string;
  metadata: {
    network: string;
    type: string;
    sourceIP: string;
    sourcePort: string | number;
    destinationIP: string;
    destinationPort: string | number;
    host: string;
    dnsMode?: string;
    process?: string;
    processPath?: string;
    uid?: number;
    inboundIP?: string;
    inboundPort?: string | number;
    inboundName?: string;
    specialProxy?: string;
    specialRules?: string;
    remoteDestination?: string;
    dscp?: number;
  };
  upload: number;
  download: number;
  start: string;
  chains: string[];
  providerChains?: string[];
  rule: string;
  rulePayload: string;
}

export interface ConnectionsSnapshot {
  downloadTotal: number;
  uploadTotal: number;
  memory?: number;
  connections: Connection[];
}

/** Mihomo serializes its Go nil slice as null when no connections are active. */
export type ConnectionsResponse = Omit<ConnectionsSnapshot, 'connections'> & {
  connections: Connection[] | null;
};

export interface Traffic {
  up: number;
  down: number;
  upTotal?: number;
  downTotal?: number;
}

export interface Memory {
  inuse: number;
  oslimit: number;
}

export interface LogEntry {
  type: string;
  payload: string;
}

export interface Version {
  version: string;
  meta?: boolean;
}

export interface DnsRecord {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

export interface DnsResponse {
  Status: number;
  Question?: { Name: string; Qtype: number; Qclass: number }[];
  TC?: boolean;
  RD?: boolean;
  RA?: boolean;
  AD?: boolean;
  CD?: boolean;
  Answer?: DnsRecord[];
  Authority?: DnsRecord[];
  Additional?: DnsRecord[];
}

export interface ConfigSource {
  path?: string;
  payload?: string;
}

export interface UpgradeResponse {
  status: 'ok';
}

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

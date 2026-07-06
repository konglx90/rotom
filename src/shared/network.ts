/**
 * 判断 socket 远端地址是否本机(loopback)或局域网(可信内网)。
 *
 * 免 token 本机/局域网认证:本机进程或局域网内"我的设备"(iPad / Mac / 开发盒)
 * 的请求/连接被信任,自动绑定本机 agent,跳过 mesh_token 校验。
 *
 * Node 在 IPv4-only 监听上会给出 `127.0.0.1`;
 * 双栈监听上 IPv4 连接会给出 IPv4-mapped 形式 `::ffff:127.0.0.1`。
 * 局域网段:192.168.0.0/16 / 10.0.0.0/8 / 172.16.0.0/12(含 IPv4-mapped 形式)
 * + 公司内网 30.0.0.0/8 段,等同 RFC1918 信任。
 */
export function isLoopback(addr: string | undefined | null): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1"
  );
}

/** 局域网 IP 段(可信内网,与 loopback 一起走免 token 信任) */
export function isLocalNetwork(addr: string | undefined | null): boolean {
  if (!addr) return false;
  if (isLoopback(addr)) return true;
  // 去掉 IPv4-mapped 前缀 `::ffff:` 便于匹配
  const v4 = addr.replace(/^::ffff:/, "");
  // 192.168.x.x
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(v4)) return true;
  // 10.x.x.x
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) return true;
  // 172.16-31.x.x
  const m172 = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(v4);
  if (m172) {
    const second = parseInt(m172[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  // 公司内网 30.x.x.x 段,同 RFC1918 处理
  if (/^30\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) return true;
  return false;
}


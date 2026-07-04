/**
 * 判断 socket 远端地址是否本机(loopback)。
 *
 * 免 token 本机认证:本机进程(IP=127.0.0.1 / ::1)的请求/连接被信任,
 * 自动绑定本机 agent,跳过 mesh_token 校验。
 *
 * Node 在 IPv4-only 监听上会给出 `127.0.0.1`;
 * 双栈监听上 IPv4 连接会给出 IPv4-mapped 形式 `::ffff:127.0.0.1`。
 */
export function isLoopback(addr: string | undefined | null): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1"
  );
}

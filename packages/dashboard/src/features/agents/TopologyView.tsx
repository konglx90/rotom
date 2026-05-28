import { useEffect, useRef, useState } from 'react';
import { Agent } from '../../api/types';
import { Button } from '../../components/ui/Button';
import styles from './TopologyView.module.css';

interface TopologyViewProps {
  agents: Agent[];
  statusFilter: 'all' | 'online' | 'offline';
  domainFilter: string;
  onAgentClick?: (agentName: string) => void;
}

interface TopoNode {
  name: string;
  x: number;
  y: number;
  r: number;
  isMaster?: boolean;
  status?: 'online' | 'offline';
  domain?: string;
  endpoint?: string;
  description?: string;
  deptColor?: string;
  color?: string;
}

interface TopoCluster {
  name: string;
  color: string;
  cx: number;
  cy: number;
  clR: number;
  members: Agent[];
  positions: { x: number; y: number }[];
  onlineCount: number;
  totalCount: number;
}

interface Particle {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  t: number;
  speed: number;
  color: string;
  size: number;
}

const DEPT_PALETTE = [
  '#6c8cff', '#22c55e', '#f59e0b', '#a78bfa', '#2dd4bf',
  '#f472b6', '#84cc16', '#06b6d4', '#fb923c', '#e879f9',
  '#fbbf24', '#64748b'
];

export function TopologyView({ agents, statusFilter, domainFilter, onAgentClick }: TopologyViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState({ deptCount: 0, agentCount: 0, messageCount: 0 });
  const [clusters, setClusters] = useState<TopoCluster[]>([]);
  const [zoom, setZoom] = useState(100);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Topology state
  const topoStateRef = useRef({
    nodes: [] as TopoNode[],
    clusters: [] as TopoCluster[],
    particles: [] as Particle[],
    scale: 1,
    contentCx: 0,
    contentCy: 0,
    hovered: null as TopoNode | null,
    hoveredCluster: null as TopoCluster | null,
    glowPhase: 0,
    animId: null as number | null,
    showNames: false
  });

  // Filter agents
  const filteredAgents = agents.filter(a => {
    if (statusFilter !== 'all' && a.status !== statusFilter) return false;
    if (domainFilter !== 'all' && (a.domain || '') !== domainFilter) return false;
    return true;
  });

  // Group by department
  const groupedAgents = filteredAgents.reduce((acc, agent) => {
    const dept = agent.domain || '未分组';
    if (!acc[dept]) acc[dept] = [];
    acc[dept].push(agent);
    return acc;
  }, {} as Record<string, Agent[]>);

  const deptNames = Object.keys(groupedAgents).sort();

  useEffect(() => {
    const canvasEl = canvasRef.current;
    const container = containerRef.current;
    if (!canvasEl || !container) return;

    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = container.clientWidth;
    const H = isFullscreen ? container.clientHeight : Math.max(500, Math.min(900, 480 + deptNames.length * 22 + filteredAgents.length * 0.6));

    canvasEl.width = W * dpr;
    canvasEl.height = H * dpr;
    canvasEl.style.width = W + 'px';
    canvasEl.style.height = H + 'px';
    ctx.scale(dpr, dpr);

    // Build topology
    buildTopology(canvasEl, W, H);

    // Start animation
    const state = topoStateRef.current;
    if (state.animId) cancelAnimationFrame(state.animId);

    function animate() {
      state.glowPhase += 0.012;
      drawTopology(canvasEl!, ctx!, W, H);
      state.animId = requestAnimationFrame(animate);
    }
    animate();

    return () => {
      if (state.animId) cancelAnimationFrame(state.animId);
    };
  }, [filteredAgents, deptNames, isFullscreen]);

  function buildTopology(canvasEl: HTMLCanvasElement, W: number, H: number) {
    const state = topoStateRef.current;
    const deptCount = deptNames.length;
    const totalNodes = filteredAgents.length;
    const vcx = W / 2;
    const vcy = H / 2;

    // Adaptive node size
    const nodeR = totalNodes > 120 ? 5 : totalNodes > 60 ? 6 : totalNodes > 30 ? 7 : totalNodes > 12 ? 8 : 10;
    const nodeSp = nodeR * 2.8;
    const showNames = totalNodes <= 20;

    // Master hub
    const masterR = 30;
    const masterNode: TopoNode = {
      name: '调度中心',
      x: vcx,
      y: vcy,
      r: masterR,
      isMaster: true,
      status: 'online'
    };

    state.nodes = [masterNode];
    state.clusters = [];

    // Layout clusters
    for (let i = 0; i < deptCount; i++) {
      const name = deptNames[i];
      const members = groupedAgents[name];
      const angle = deptCount === 1 ? 0 : deptCount === 2 ? (i === 0 ? Math.PI : 0) : (-Math.PI / 2 + (i / deptCount) * Math.PI * 2);

      // Hex pack positions
      const pos0 = hexPack(members.length, 0, 0, nodeSp);
      const clR = clusterRadius(pos0, 0, 0, nodeR + 18);
      const thisOrbitR = Math.max(clR + masterR + 65, 150);
      const clCx = vcx + Math.cos(angle) * thisOrbitR;
      const clCy = vcy + Math.sin(angle) * thisOrbitR;
      const positions = pos0.map(p => ({ x: p.x + clCx, y: p.y + clCy }));
      const color = DEPT_PALETTE[i % DEPT_PALETTE.length];
      const onlineCount = members.filter(a => a.status === 'online').length;

      state.clusters.push({
        name,
        color,
        cx: clCx,
        cy: clCy,
        clR,
        members,
        positions,
        onlineCount,
        totalCount: members.length
      });

      for (let j = 0; j < members.length; j++) {
        const a = members[j];
        state.nodes.push({
          name: a.name,
          x: positions[j].x,
          y: positions[j].y,
          r: nodeR,
          color: a.status === 'online' ? '#22c55e' : '#4a4f5a',
          status: a.status,
          domain: a.domain,
          endpoint: a.endpoint,
          deptColor: color,
          description: a.description
        });
      }
    }

    // Auto-scale
    let minX = vcx - masterR, maxX = vcx + masterR, minY = vcy - masterR, maxY = vcy + masterR;
    for (const cl of state.clusters) {
      minX = Math.min(minX, cl.cx - cl.clR - 20);
      maxX = Math.max(maxX, cl.cx + cl.clR + 20);
      minY = Math.min(minY, cl.cy - cl.clR - 40);
      maxY = Math.max(maxY, cl.cy + cl.clR + 30);
    }
    const contentW = maxX - minX || 1;
    const contentH = maxY - minY || 1;
    state.contentCx = (minX + maxX) / 2;
    state.contentCy = (minY + maxY) / 2;
    const pad = 60;
    const autoScale = Math.min((W - pad) / contentW, (H - pad) / contentH, 1.5);
    state.scale = autoScale;

    // Update stats
    setStats({
      deptCount,
      agentCount: totalNodes,
      messageCount: 0 // TODO: fetch from API
    });
    setClusters(state.clusters);
    setZoom(Math.round(autoScale * 100));

    state.showNames = showNames;

    // Create particles (simplified)
    state.particles = [];
    const maxP = 50;
    for (const cl of state.clusters) {
      if (state.particles.length >= maxP) break;
      const n = Math.min(3, Math.max(1, Math.ceil(cl.totalCount / 6)));
      for (let j = 0; j < n && state.particles.length < maxP; j++) {
        state.particles.push({
          fx: vcx,
          fy: vcy,
          tx: cl.cx,
          ty: cl.cy,
          t: Math.random(),
          speed: 0.0007 + Math.random() * 0.001,
          color: cl.color + '70',
          size: 2.5
        });
      }
    }

    // Mouse events
    canvasEl.onmousemove = (e: MouseEvent) => {
      const rect = canvasEl.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const mx = (sx - W / 2) / state.scale + state.contentCx;
      const my = (sy - H / 2) / state.scale + state.contentCy;

      state.hovered = null;
      state.hoveredCluster = null;

      for (let i = state.nodes.length - 1; i >= 0; i--) {
        const nd = state.nodes[i];
        const hit = showNames ? nd.r + 6 : nd.r + 4;
        if ((mx - nd.x) ** 2 + (my - nd.y) ** 2 < hit * hit) {
          state.hovered = nd;
          break;
        }
      }

      if (!state.hovered) {
        for (const cl of state.clusters) {
          if ((mx - cl.cx) ** 2 + (my - cl.cy) ** 2 < cl.clR * cl.clR) {
            state.hoveredCluster = cl;
            break;
          }
        }
      }

      canvasEl.style.cursor = (state.hovered && !state.hovered.isMaster) || state.hoveredCluster ? 'pointer' : 'default';
      (canvasEl as any)._lastSx = sx;
      (canvasEl as any)._lastSy = sy;
    };

    canvasEl.onclick = () => {
      if (state.hovered && !state.hovered.isMaster && onAgentClick) {
        onAgentClick(state.hovered.name);
      }
    };

    canvasEl.onwheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.08 : -0.08;
      state.scale = Math.max(0.1, Math.min(3, state.scale + delta));
      setZoom(Math.round(state.scale * 100));
    };
  }

  function drawTopology(canvasEl: HTMLCanvasElement, ctx: CanvasRenderingContext2D, W: number, H: number) {
    const state = topoStateRef.current;
    ctx.clearRect(0, 0, W, H);

    // Background dot grid
    ctx.fillStyle = '#ffffff06';
    for (let x = 25; x < W; x += 40) {
      for (let y = 25; y < H; y += 40) {
        ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
      }
    }

    // Apply transform
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(state.scale, state.scale);
    ctx.translate(-state.contentCx, -state.contentCy);

    const master = state.nodes[0];
    if (!master) return ctx.restore();

    // Background glow
    const bgGrad = ctx.createRadialGradient(master.x, master.y, 0, master.x, master.y, Math.max(W, H) * 0.55);
    bgGrad.addColorStop(0, '#7c6cff08');
    bgGrad.addColorStop(0.4, '#7c6cff03');
    bgGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(master.x - W, master.y - H, W * 2, H * 2);

    // Connection lines
    for (const cl of state.clusters) {
      const grad = ctx.createLinearGradient(master.x, master.y, cl.cx, cl.cy);
      grad.addColorStop(0, '#7c6cff40');
      grad.addColorStop(0.5, cl.color + '25');
      grad.addColorStop(1, cl.color + '10');
      ctx.beginPath();
      ctx.moveTo(master.x, master.y);
      ctx.lineTo(cl.cx, cl.cy);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Department clusters
    for (const cl of state.clusters) {
      const isHov = state.hoveredCluster === cl;
      const R = cl.clR;

      // Outer aura
      const aura = ctx.createRadialGradient(cl.cx, cl.cy, R * 0.3, cl.cx, cl.cy, R + 20);
      aura.addColorStop(0, cl.color + (isHov ? '18' : '0c'));
      aura.addColorStop(0.7, cl.color + (isHov ? '0a' : '05'));
      aura.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(cl.cx, cl.cy, R + 20, 0, Math.PI * 2);
      ctx.fillStyle = aura;
      ctx.fill();

      // Circle boundary
      ctx.beginPath();
      ctx.arc(cl.cx, cl.cy, R, 0, Math.PI * 2);
      ctx.fillStyle = cl.color + (isHov ? '12' : '08');
      ctx.fill();
      ctx.strokeStyle = cl.color + (isHov ? '40' : '20');
      ctx.lineWidth = isHov ? 1.5 : 1;
      ctx.stroke();

      // Department label
      const displayName = cl.name.length > 12 ? cl.name.slice(0, 11) + '…' : cl.name;
      ctx.font = '600 12px Inter, system-ui';
      const labelW = ctx.measureText(displayName).width + 16;
      const labelX = cl.cx - labelW / 2;
      const labelY = cl.cy - R - 28;
      roundRect(ctx, labelX, labelY, labelW, 22, 6);
      ctx.fillStyle = cl.color + '20';
      ctx.fill();
      ctx.strokeStyle = cl.color + '35';
      ctx.lineWidth = 0.8;
      roundRect(ctx, labelX, labelY, labelW, 22, 6);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillStyle = cl.color;
      ctx.fillText(displayName, cl.cx, labelY + 15);

      // Status badge
      const badgeText = cl.onlineCount + ' / ' + cl.totalCount;
      const onRatio = cl.totalCount ? cl.onlineCount / cl.totalCount : 0;
      const badgeColor = onRatio >= 1 ? '#22c55e' : onRatio > 0 ? '#f59e0b' : '#ef4444';
      ctx.font = '600 10px "JetBrains Mono", monospace';
      const bw = ctx.measureText(badgeText).width + 14;
      const bx = cl.cx - bw / 2;
      const by = cl.cy + R + 8;
      roundRect(ctx, bx, by, bw, 18, 5);
      ctx.fillStyle = badgeColor + '25';
      ctx.fill();
      ctx.strokeStyle = badgeColor + '40';
      ctx.lineWidth = 1;
      roundRect(ctx, bx, by, bw, 18, 5);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillStyle = badgeColor;
      ctx.fillText(badgeText, cl.cx, by + 13);
    }

    // Particles
    for (const p of state.particles) {
      p.t += p.speed;
      if (p.t > 1) p.t -= 1;
      const x = p.fx + (p.tx - p.fx) * p.t;
      const y = p.fy + (p.ty - p.fy) * p.t;

      ctx.beginPath();
      ctx.arc(x, y, p.size + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = p.color.replace(/[\da-f]{2}$/i, '15');
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    }

    // Agent nodes - offline
    for (let i = 1; i < state.nodes.length; i++) {
      const nd = state.nodes[i];
      if (nd.isMaster || nd.status === 'online') continue;
      const isHov = state.hovered === nd;
      const r = isHov ? nd.r + 2 : nd.r;
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#1e2228';
      ctx.fill();
      ctx.strokeStyle = isHov ? '#ef4444' : '#4a5060';
      ctx.lineWidth = isHov ? 2 : 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, r * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = '#ef444440';
      ctx.fill();
    }

    // Agent nodes - online
    for (let i = 1; i < state.nodes.length; i++) {
      const nd = state.nodes[i];
      if (nd.isMaster || nd.status !== 'online') continue;
      const isHov = state.hovered === nd;
      const r = isHov ? nd.r + 2 : nd.r;

      const g = ctx.createRadialGradient(nd.x, nd.y, r * 0.2, nd.x, nd.y, r + 8);
      g.addColorStop(0, '#22c55e30');
      g.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, r + 8, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();

      const bg = ctx.createRadialGradient(nd.x - r * 0.25, nd.y - r * 0.25, 0, nd.x, nd.y, r);
      bg.addColorStop(0, '#4ade80');
      bg.addColorStop(1, '#16a34a');
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.strokeStyle = isHov ? '#86efac' : '#22c55e80';
      ctx.lineWidth = isHov ? 2 : 1;
      ctx.stroke();
    }

    // Agent names
    if (state.showNames) {
      ctx.textAlign = 'center';
      ctx.font = '500 10px Inter, system-ui';
      for (let i = 1; i < state.nodes.length; i++) {
        const nd = state.nodes[i];
        if (nd.isMaster) continue;
        ctx.fillStyle = nd.status === 'online' ? '#d1fae5' : '#8492a6';
        ctx.fillText(nd.name, nd.x, nd.y + nd.r + 12);
      }
    }

    // Master hub
    const nd = master;
    const r = nd.r;
    const pulse = 0.6 + 0.4 * Math.sin(state.glowPhase);

    for (let ring = 3; ring >= 1; ring--) {
      const gr = ctx.createRadialGradient(nd.x, nd.y, r, nd.x, nd.y, r + ring * 18);
      gr.addColorStop(0, 'rgba(124,108,255,' + (0.06 * pulse / ring) + ')');
      gr.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, r + ring * 18, 0, Math.PI * 2);
      ctx.fillStyle = gr;
      ctx.fill();
    }

    // Hex body
    const bg = ctx.createRadialGradient(nd.x - r * 0.2, nd.y - r * 0.2, 0, nd.x, nd.y, r);
    bg.addColorStop(0, '#2a2050');
    bg.addColorStop(1, '#151025');
    drawHexagon(ctx, nd.x, nd.y, r);
    ctx.fillStyle = bg;
    ctx.fill();

    const bGrad = ctx.createLinearGradient(nd.x - r, nd.y - r, nd.x + r, nd.y + r);
    bGrad.addColorStop(0, '#7c6cffc0');
    bGrad.addColorStop(1, '#a78bfac0');
    drawHexagon(ctx, nd.x, nd.y, r);
    ctx.strokeStyle = bGrad;
    ctx.lineWidth = state.hovered === nd ? 3 : 2;
    ctx.stroke();

    // Label
    ctx.textAlign = 'center';
    ctx.fillStyle = '#c4b5fd';
    ctx.font = '700 13px Inter, system-ui';
    ctx.fillText(nd.name, nd.x, nd.y + r + 20);

    ctx.restore();

    // Tooltip
    const tip = state.hovered || state.hoveredCluster;
    if (tip) {
      const sx = (canvasEl as any)._lastSx || W / 2;
      const sy = (canvasEl as any)._lastSy || H / 2;
      drawTooltip(ctx, tip, sx, sy, W, H);
    }
  }

  function drawTooltip(ctx: CanvasRenderingContext2D, tip: any, sx: number, sy: number, W: number, H: number) {
    const state = topoStateRef.current;
    let lines: string[] = [];
    if (tip.isMaster) {
      lines = ['调度中心', '管理所有数字员工通信', state.clusters.length + ' 个部门 · ' + (state.nodes.length - 1) + ' 名员工'];
    } else if (tip.clR !== undefined) {
      lines = [tip.name + ' 部门', '在线 ' + tip.onlineCount + ' / 共 ' + tip.totalCount + ' 名'];
      const ml = tip.members.slice(0, 8).map((m: Agent) => (m.status === 'online' ? '● ' : '○ ') + m.name);
      if (tip.members.length > 8) ml.push('… 还有 ' + (tip.members.length - 8) + ' 名');
      lines = lines.concat(ml);
    } else {
      lines = [tip.name, '部门: ' + (tip.domain || '—')];
      if (tip.endpoint) lines.push('EP: ' + tip.endpoint);
      if (tip.description) lines.push(tip.description.slice(0, 24));
      lines.push(tip.status === 'online' ? '● 在线' : '○ 离线');
    }

    const lineH = 18;
    const tw = Math.min(240, Math.max(150, ...lines.map((l: string) => l.length * 7.5 + 28)));
    const th = lines.length * lineH + 14;
    let tx = sx + 14;
    let ty = sy - lines.length * 9;

    if (tx + tw > W - 8) tx = sx - tw - 10;
    if (ty < 6) ty = 6;
    if (ty + th > H - 6) ty = H - th - 6;

    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#111820f5';
    roundRect(ctx, tx, ty, tw, th, 10);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    const tipColor = tip.deptColor || tip.color || '#6c8cff';
    ctx.strokeStyle = tipColor + '40';
    ctx.lineWidth = 1;
    roundRect(ctx, tx, ty, tw, th, 10);
    ctx.stroke();
    ctx.fillStyle = tipColor;
    ctx.fillRect(tx + 1, ty + 8, 3, th - 16);

    ctx.textAlign = 'left';
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (i === 0) {
        ctx.fillStyle = '#fff';
        ctx.font = '700 12px Inter, system-ui';
      } else if (i === 1 && tip.clR !== undefined) {
        ctx.fillStyle = tip.color || '#8492a6';
        ctx.font = '600 11px "JetBrains Mono", monospace';
      } else if (l.startsWith('●')) {
        ctx.fillStyle = '#4ade80';
        ctx.font = '400 11px Inter, system-ui';
      } else if (l.startsWith('○')) {
        ctx.fillStyle = '#6b7280';
        ctx.font = '400 11px Inter, system-ui';
      } else {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '400 11px Inter, system-ui';
      }
      ctx.fillText(l, tx + 12, ty + 16 + i * lineH);
    }
  }

  function hexPack(count: number, cx: number, cy: number, sp: number) {
    if (!count) return [];
    if (count === 1) return [{ x: cx, y: cy }];
    const cols = Math.ceil(Math.sqrt(count * 1.15));
    const rows = Math.ceil(count / cols);
    const rowH = sp * 0.866;
    const res: { x: number; y: number }[] = [];
    let idx = 0;
    for (let r = 0; r < rows && idx < count; r++) {
      const n = Math.min(cols, count - idx);
      const ox = r % 2 ? sp * 0.5 : 0;
      for (let c = 0; c < n; c++, idx++) {
        res.push({ x: cx + (c - (n - 1) / 2) * sp + ox, y: cy + (r - (rows - 1) / 2) * rowH });
      }
    }
    return res;
  }

  function clusterRadius(pts: { x: number; y: number }[], cx: number, cy: number, pad: number) {
    if (!pts.length) return pad + 10;
    let maxD = 0;
    for (const p of pts) {
      const d = Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2);
      if (d > maxD) maxD = d;
    }
    return maxD + pad;
  }

  function drawHexagon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 3;
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath();
  }

  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  }

  function handleZoomIn() {
    const state = topoStateRef.current;
    state.scale = Math.min(3, state.scale + 0.1);
    setZoom(Math.round(state.scale * 100));
  }

  function handleZoomOut() {
    const state = topoStateRef.current;
    state.scale = Math.max(0.1, state.scale - 0.1);
    setZoom(Math.round(state.scale * 100));
  }

  function handleResetZoom() {
    const state = topoStateRef.current;
    state.scale = 1;
    setZoom(100);
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.statValue}>{stats.deptCount}</span>
            <span className={styles.statLabel}>部门</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statValue}>{stats.agentCount}</span>
            <span className={styles.statLabel}>员工</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statValue}>{stats.messageCount}</span>
            <span className={styles.statLabel}>对话</span>
          </div>
        </div>
        <div className={styles.controls}>
          <Button variant="ghost" size="sm" iconOnly onClick={handleZoomOut} title="缩小">−</Button>
          <span className={styles.zoomLevel}>{zoom}%</span>
          <Button variant="ghost" size="sm" iconOnly onClick={handleZoomIn} title="放大">+</Button>
          <Button variant="ghost" size="sm" iconOnly onClick={handleResetZoom} title="重置">⟲</Button>
          <Button variant="ghost" size="sm" iconOnly onClick={toggleFullscreen} title="全屏">⛶</Button>
        </div>
      </div>

      <div className={styles.legend}>
        <div className={styles.legendItem}>
          <div className={`${styles.legendDot} ${styles.legendDotOnline}`}></div>
          在线
        </div>
        <div className={styles.legendItem}>
          <div className={`${styles.legendDot} ${styles.legendDotOffline}`}></div>
          离线
        </div>
        {clusters.map((cl, i) => (
          <div key={i} className={styles.legendItem}>
            <div
              className={styles.legendDot}
              style={{ background: cl.color }}
              title={cl.name}
            ></div>
            {cl.name}
          </div>
        ))}
      </div>

      <div ref={containerRef} className={styles.canvasContainer}>
        <canvas ref={canvasRef} className={styles.canvas}></canvas>
      </div>
    </div>
  );
}

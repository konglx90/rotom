import { useState, useEffect } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { e2edApi, type E2edRequirement } from "../../api/e2ed";
import s from "./E2edSidebar.module.css";

const STATUS_DOT: Record<string, string> = {
  CREATED: "#868685",
  ENV_CHECKING: "#2563eb",
  ENV_READY: "#22c55e",
  REQ_REVIEWING: "#2563eb",
  REQ_REVIEWED: "#22c55e",
  PLANNING: "#7c3aed",
  PLAN_REVIEWING: "#2563eb",
  PLAN_REVIEWED: "#22c55e",
  DELIVERING: "#d97706",
  DELIVERED: "#22c55e",
  REVIEWING: "#2563eb",
  REVIEWED: "#22c55e",
  CLOSED: "#868685",
};

export function E2edSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [reqs, setReqs] = useState<E2edRequirement[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [createText, setCreateText] = useState("");
  const [createTitle, setCreateTitle] = useState("");

  useEffect(() => {
    e2edApi
      .list()
      .then(setReqs)
      .catch(() => {});
    const timer = setInterval(
      () =>
        e2edApi
          .list()
          .then(setReqs)
          .catch(() => {}),
      5000,
    );
    return () => clearInterval(timer);
  }, []);

  const selectedId = location.pathname.split("/e2ed/")[1]?.split("/")[0] || "";

  const handleCreate = async () => {
    if (!createText.trim()) return;
    try {
      await e2edApi.create({
        title: createTitle.trim() || undefined,
        text: createText.trim(),
      });
      setCreateText("");
      setCreateTitle("");
      setShowCreate(false);
      e2edApi.list().then(setReqs);
    } catch (e: any) {
      alert(e.message);
    }
  };

  const activeReqs = reqs.filter((r) => r.status !== "CLOSED");
  const closedReqs = reqs.filter((r) => r.status === "CLOSED");

  return (
    <div className={s.sidebar}>
      <Link to="/dashboard/e2ed" className={s.sidebarLogo}>
        <div className={s.sidebarLogoIcon}>E</div>
        <div>
          <div className={s.sidebarLogoTitle}>E2ED</div>
          <div className={s.sidebarLogoSub}>端到端交付</div>
        </div>
      </Link>

      <div className={s.sidebarCreateWrap}>
        {showCreate ? (
          <div className={s.sidebarCreateInner}>
            <input
              placeholder="标题（可选）"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              className={s.sidebarCreateInput}
            />
            <textarea
              placeholder="需求描述..."
              value={createText}
              onChange={(e) => setCreateText(e.target.value)}
              rows={3}
              className={s.sidebarCreateTextarea}
            />
            <div className={s.sidebarCreateActions}>
              <button onClick={handleCreate} className={s.ctaBtn}>
                创建
              </button>
              <button
                onClick={() => setShowCreate(false)}
                className={s.ghostBtn}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowCreate(true)} className={s.ctaBtnFull}>
            + 新建需求
          </button>
        )}
      </div>

      <div className={s.sidebarList}>
        {activeReqs.length > 0 && (
          <div className={s.sidebarSection}>
            <div className={s.sidebarSectionTitle}>进行中</div>
            {activeReqs.map((r) => (
              <ReqItem
                key={r.reqId}
                req={r}
                selected={r.reqId === selectedId}
                onClick={() => navigate(`/dashboard/e2ed/${r.reqId}`)}
              />
            ))}
          </div>
        )}

        {closedReqs.length > 0 && (
          <div className={s.sidebarSection}>
            <div className={s.sidebarSectionTitle}>已完成</div>
            {closedReqs.map((r) => (
              <ReqItem
                key={r.reqId}
                req={r}
                selected={r.reqId === selectedId}
                onClick={() => navigate(`/dashboard/e2ed/${r.reqId}`)}
                dimmed
              />
            ))}
          </div>
        )}

        {reqs.length === 0 && (
          <div className={s.sidebarEmpty}>点击上方按钮创建第一个需求</div>
        )}
      </div>

      <div className={s.sidebarFooter}>
        <Link to="/dashboard/agents" className={s.sidebarFooterLink}>
          ← 返回主面板
        </Link>
      </div>
    </div>
  );
}

function ReqItem({
  req,
  selected,
  onClick,
  dimmed,
}: {
  req: E2edRequirement;
  selected: boolean;
  onClick: () => void;
  dimmed?: boolean;
}) {
  const dotColor = STATUS_DOT[req.status] || "#868685";
  return (
    <div
      onClick={onClick}
      className={`${s.reqItem} ${selected ? s.reqItemSelected : ""} ${dimmed ? s.reqItemDimmed : ""}`}
    >
      <div className={s.reqDot} style={{ background: dotColor }} />
      <div className={s.reqItemInfo}>
        <div className={s.reqItemTitle}>
          {req.title || req.reqId.slice(0, 8)}
        </div>
        <div className={s.reqItemMeta}>
          <span>{req.compositeVersion}</span>
          <span>
            {req.planVersions?.length || 0}P · {req.codeVersions?.length || 0}C
          </span>
        </div>
      </div>
    </div>
  );
}

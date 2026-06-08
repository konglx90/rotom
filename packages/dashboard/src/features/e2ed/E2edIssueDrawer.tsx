import { useState, useEffect } from "react";
import { issuesApi } from "../../api/issues";
import { MarkdownContent } from "../../components/ui/MarkdownContent";
import { IssueDetail } from "../groups/IssueDetail";
import { useChatContext } from "../../context/ChatContext";
import { useSocket } from "../../context/SocketContext";
import s from "./E2edShared.module.css";

interface E2edIssueDrawerProps {
  issueId: string;
  groupId: string;
  onClose: () => void;
}

export function E2edIssueDrawer({ issueId, onClose }: E2edIssueDrawerProps) {
  const [tab, setTab] = useState<"product" | "process">("product");
  const [result, setResult] = useState<string | null>(null);
  const [issueType, setIssueType] = useState<string | null>(null);
  const { agents } = useChatContext();
  const { lastIssueChange } = useSocket();

  useEffect(() => {
    issuesApi
      .getById(issueId)
      .then((data) => {
        setResult(data.result || null);
        setIssueType(data.type || null);
        if (data.result) setTab("product");
      })
      .catch(() => {});
  }, [issueId]);

  useEffect(() => {
    if (!lastIssueChange || lastIssueChange.issueId !== issueId) return;
    issuesApi.getById(issueId).then((data) => {
      setResult(data.result || null);
      setIssueType(data.type || null);
    });
  }, [lastIssueChange, issueId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const productLabel = issueType === "review" ? "评审报告" : "产物";

  return (
    <>
      <div className={s.drawerOverlay} onClick={onClose} />
      <div className={`${s.drawer} ${s.drawerWide}`}>
        <div className={s.drawerHeaderCompact}>
          <span className={s.drawerTitleSm}>任务详情</span>
          <button onClick={onClose} className={s.iconBtnSmall}>
            &times;
          </button>
        </div>

        {result ? (
          <>
            <div className={s.tabBar}>
              <button
                className={`${s.tabBtn} ${tab === "product" ? s.tabBtnActive : ""}`}
                onClick={() => setTab("product")}
              >
                {productLabel}
              </button>
              <button
                className={`${s.tabBtn} ${tab === "process" ? s.tabBtnActive : ""}`}
                onClick={() => setTab("process")}
              >
                执行过程
              </button>
            </div>
            <div className={s.drawerBodyPadded}>
              {tab === "product" ? (
                <div className={s.drawerContent}>
                  <MarkdownContent content={result} />
                </div>
              ) : (
                <IssueDetail
                  issueId={issueId}
                  agents={agents}
                  groupMembers={[]}
                  onBack={onClose}
                />
              )}
            </div>
          </>
        ) : (
          <div className={s.drawerBodyPadded}>
            <IssueDetail
              issueId={issueId}
              agents={agents}
              groupMembers={[]}
              onBack={onClose}
            />
          </div>
        )}
      </div>
    </>
  );
}

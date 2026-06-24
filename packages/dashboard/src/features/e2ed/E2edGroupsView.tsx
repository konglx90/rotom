import { useState, useEffect } from "react";
import { e2edApi, type E2edRequirement } from "../../api/e2ed";
import { AsyncBoundary } from "../../components/data/AsyncBoundary";
import s from "./E2edGroupsView.module.css";
import shared from "./E2edShared.module.css";

export function E2edGroupsView() {
  const [reqs, setReqs] = useState<E2edRequirement[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = () => {
    setLoading(true);
    setError(null);
    e2edApi
      .list()
      .then((data) => {
        setReqs(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  };

  useEffect(() => {
    refetch();
  }, []);

  return (
    <AsyncBoundary
      data={reqs}
      loading={loading}
      error={error}
      onRetry={refetch}
      loadingFallback={
        <div className={shared.centerFill}>
          <span className={shared.loadingText}>Loading...</span>
        </div>
      }
    >
      {(data) => <E2edGroupsContent reqs={data} />}
    </AsyncBoundary>
  );
}

function E2edGroupsContent({ reqs }: { reqs: E2edRequirement[] }) {
  const activeReqs = reqs.filter((r) => r.status !== "CLOSED");

  return (
    <div className={s.welcomeWrap}>
      <div className={s.welcomeLogo}>E</div>
      <h1 className={s.welcomeTitle}>端到端需求交付</h1>
      <p className={s.welcomeDesc}>
        Claude 交付，Codex 评审。
        <br />
        从需求到代码的完整可追溯流水线。
      </p>

      {activeReqs.length > 0 ? (
        <div className={s.welcomeHint}>从左侧选择一个需求查看详情</div>
      ) : (
        <div className={s.welcomeHintGray}>
          点击左侧 <span className={s.welcomeInlinePill}>+ 新建需求</span> 开始
        </div>
      )}

      <div className={s.tutorialCard}>
        <div className={s.tutorialTitle}>快速上手</div>
        <div className={s.tutorialSteps}>
          <Step
            num={1}
            title="创建需求"
            cmd="rotom e2ed start '需求描述' --cwd <项目目录>"
          />
          <Step
            num={2}
            title="生成方案"
            cmd="rotom e2ed deliver <id> --plan-only --cwd <项目目录>"
          />
          <Step
            num={3}
            title="方案评审"
            cmd="rotom e2ed review <id> --type plan --cwd <项目目录>"
          />
          <Step
            num={4}
            title="实现代码"
            cmd="rotom e2ed deliver <id> --code-only --cwd <项目目录>"
          />
          <Step
            num={5}
            title="代码评审"
            cmd="rotom e2ed review <id> --type code --cwd <项目目录>"
          />
          <Step num={6} title="关闭需求" cmd="rotom e2ed close <id>" />
        </div>
        <div className={s.tutorialFooter}>
          <strong className={s.tutorialFooterStrong}>双智能体协作：</strong>
          Claude 负责交付（生成方案 & 实现代码），Codex 负责评审（需求评审 &
          方案评审 & 代码评审）。
          <code className={s.tutorialFooterCode}>rotom e2ed --help</code>
        </div>
      </div>

      {reqs.length > 0 && (
        <div className={s.statsBar}>
          <Stat label="需求总数" value={reqs.length} />
          <Stat label="进行中" value={activeReqs.length} />
          <Stat
            label="已完成"
            value={reqs.filter((r) => r.status === "CLOSED").length}
          />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className={s.statItem}>
      <div className={s.statValue}>{value}</div>
      <div className={s.statLabel}>{label}</div>
    </div>
  );
}

function Step({
  num,
  title,
  cmd,
}: {
  num: number;
  title: string;
  cmd: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className={s.stepWrap}>
      <div className={s.stepNum}>{num}</div>
      <div className={s.stepContent}>
        <div className={s.stepTitle}>{title}</div>
        <div className={s.stepCmd}>
          <code className={s.stepCmdCode}>{cmd}</code>
          <button
            onClick={handleCopy}
            className={`${shared.copyBtn} ${copied ? shared.copyBtnCopied : ""}`}
          >
            {copied ? "✓" : "复制"}
          </button>
        </div>
      </div>
    </div>
  );
}

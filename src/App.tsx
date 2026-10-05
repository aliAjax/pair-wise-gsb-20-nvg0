import { useEffect, useMemo, useState } from "react";
import {
  addAnnotation,
  Annotation,
  AppState,
  confirmRound,
  Conflict,
  createDemoState,
  getCurrentRound,
  getRound,
  getSample,
  getUser,
  mergeOutbox,
  recalculateAnnotation,
  resolveConflict,
  roundAnnotations,
  roundChain,
  roundConflicts,
  roundOutbox,
  roundPending,
  recalculationTarget,
  reviewPendingAnnotation,
  selectRound,
  setCurrentUser,
  setFailureAfter,
  setOnline,
  startRound,
  useCurrentRound
} from "./chain";
import "./styles.css";

const STORAGE_KEY = "microscopy-record-chain-v1";

const runtime = {
  id: () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  now: () => new Date().toISOString()
};

function loadState(): AppState {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved) as AppState;
  } catch {
    // 忽略损坏的本地缓存，回退到演示数据。
  }
  return createDemoState(runtime);
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function formatTime(value?: string): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

function StatusPill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "ok" | "warn" | "danger" | "info" }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

function AnnotationRows({ annotations, state }: { annotations: Annotation[]; state: AppState }) {
  if (annotations.length === 0) return <p className="empty">暂无标注</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>坐标</th>
            <th>结构 / 测量</th>
            <th>作者</th>
            <th>状态</th>
            <th>凭据</th>
          </tr>
        </thead>
        <tbody>
          {annotations.map((annotation) => {
            const author = state.users.find((user) => user.id === annotation.authorId);
            const tone =
              annotation.status === "invalid"
                ? "danger"
                : annotation.status === "accepted"
                  ? "ok"
                  : annotation.status === "rejected" || annotation.status === "pending"
                    ? "warn"
                    : "info";
            return (
              <tr key={annotation.clientId}>
                <td className="coordinate">({annotation.x}, {annotation.y})</td>
                <td>
                  <strong>{annotation.label}</strong>
                  <span>{annotation.value}</span>
                  {annotation.note && <em>{annotation.note}</em>}
                </td>
                <td>{author?.name ?? annotation.authorId}</td>
                <td><StatusPill tone={tone}>{annotation.status}</StatusPill></td>
                <td className="mono">{shortId(annotation.clientId)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PendingRows({
  annotations,
  state,
  onReview
}: {
  annotations: Annotation[];
  state: AppState;
  onReview: (clientId: string, decision: "accepted" | "rejected") => void;
}) {
  if (annotations.length === 0) return null;
  const actor = getUser(state);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>坐标</th>
            <th>结构 / 测量</th>
            <th>作者</th>
            <th>状态</th>
            <th>老师复审</th>
          </tr>
        </thead>
        <tbody>
          {annotations.map((annotation) => {
            const author = state.users.find((user) => user.id === annotation.authorId);
            return (
              <tr key={annotation.clientId}>
                <td className="coordinate">({annotation.x}, {annotation.y})</td>
                <td>
                  <strong>{annotation.label}</strong>
                  <span>{annotation.value}</span>
                  {annotation.note && <em>{annotation.note}</em>}
                </td>
                <td>{author?.name ?? annotation.authorId}</td>
                <td><StatusPill tone="warn">pending</StatusPill></td>
                <td>
                  {actor.role === "teacher" ? (
                    <div className="review-actions">
                      <button onClick={() => onReview(annotation.clientId, "accepted")}>接受</button>
                      <button onClick={() => onReview(annotation.clientId, "rejected")}>拒绝</button>
                    </div>
                  ) : "等待老师"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function App() {
  const [state, setState] = useState<AppState>(loadState);
  const [roundSample, setRoundSample] = useState("");
  const [magnification, setMagnification] = useState(100);
  const [focus, setFocus] = useState("");
  const [reason, setReason] = useState("");
  const [x, setX] = useState(40);
  const [y, setY] = useState(20);
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const currentRound = getCurrentRound(state);
  const selectedRound = getRound(state, state.selectedRoundId);

  useEffect(() => {
    if (!currentRound) return;
    setRoundSample(currentRound.sampleId);
    setMagnification(currentRound.magnification);
    setFocus(currentRound.focus);
    setReason("");
  }, [currentRound?.id]);

  const actor = getUser(state);
  const selectedSample = selectedRound ? getSample(state, selectedRound.sampleId) : undefined;
  const selectedAnnotations = selectedRound ? roundAnnotations(state, selectedRound.id) : [];
  const selectedPending = selectedRound ? roundPending(state, selectedRound.id) : [];
  const selectedConflicts = selectedRound ? roundConflicts(state, selectedRound.id) : [];
  const selectedOutbox = selectedRound ? roundOutbox(state, selectedRound.id) : [];
  const invalidAnnotations = state.annotations.filter(
    (annotation) => annotation.status === "invalid" && annotation.supersededByRound && !annotation.recalculatedClientId
  );
  const roundsByTime = useMemo(
    () => [...state.rounds].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    [state.rounds]
  );
  const chain = selectedRound ? roundChain(state, selectedRound.id) : [];
  const openConflicts = state.conflicts.filter((conflict) => conflict.status === "open");

  const contextWillChange = Boolean(
    currentRound &&
      (currentRound.sampleId !== roundSample ||
        currentRound.magnification !== Number(magnification) ||
        currentRound.focus.trim() !== focus.trim())
  );

  function runAction(action: { state: AppState; ok: boolean }) {
    setState(action.state);
    if (action.ok) {
      setLabel("");
      setValue("");
    }
  }

  function handleStartRound(event: React.FormEvent) {
    event.preventDefault();
    runAction(
      startRound(
        state,
        {
          sampleId: roundSample,
          magnification: Number(magnification),
          focus,
          reason
        },
        runtime
      )
    );
  }

  function handleAddAnnotation(event: React.FormEvent) {
    event.preventDefault();
    if (!currentRound) return;
    runAction(addAnnotation(state, { roundId: currentRound.id, x: Number(x), y: Number(y), label, value }, runtime));
  }

  function handleReset() {
    const fresh = createDemoState(runtime);
    setState(fresh);
    setRoundSample(fresh.rounds[0].sampleId);
    setMagnification(fresh.rounds[0].magnification);
    setFocus(fresh.rounds[0].focus);
    setReason("");
    setLabel("");
    setValue("");
  }

  function conflictAnnotations(conflict: Conflict): Annotation[] {
    return [
      ...state.annotations.filter((annotation) => conflict.annotationIds.includes(annotation.clientId)),
      ...state.pendingAnnotations.filter((annotation) => conflict.annotationIds.includes(annotation.clientId))
    ];
  }

  return (
    <main className="app-shell">
      <section className="hero record-hero">
        <div>
          <p className="eyebrow">可续作显微观察记录链</p>
          <h1>课堂 · 样本 · 观察回合 · 标注</h1>
          <p className="subtitle">
            每个回合锁定样本、倍率与焦点；老师确认后只读。学生离线补画先入本地队列，回连后按回合逐坐标幂等合并，重叠坐标保留双方值交老师裁定。
          </p>
        </div>
        <div className="control-card">
          <label>
            <span>当前身份</span>
            <select value={state.currentUserId} onChange={(event) => setState(setCurrentUser(state, event.target.value))}>
              {state.users.map((user) => (
                <option key={user.id} value={user.id}>{user.name} · {user.role === "teacher" ? "老师" : "学生"}</option>
              ))}
            </select>
          </label>
          <div className="switch-row">
            <StatusPill tone={state.online ? "ok" : "danger"}>{state.online ? "在线" : "离线"}</StatusPill>
            <button onClick={() => setState(setOnline(state, !state.online))}>
              {state.online ? "模拟断网" : "恢复网络"}
            </button>
          </div>
          <button className="ghost-button" onClick={handleReset}>重置演示数据</button>
        </div>
      </section>

      <section className="metrics-grid compact">
        <article className="metric-card"><span>课堂</span><strong>{state.classroom.name}</strong></article>
        <article className="metric-card"><span>观察回合</span><strong>{state.rounds.length}</strong></article>
        <article className="metric-card"><span>本地待传</span><strong>{state.outbox.length}</strong></article>
        <article className="metric-card"><span>待老师裁定</span><strong>{openConflicts.length}</strong></article>
      </section>

      <div className={`system-message ${state.lastMessage.includes("不能") || state.lastMessage.includes("失败") ? "error" : ""}`}>
        {state.lastMessage}
      </div>

      <section className="workspace chain-workspace">
        <aside className="panel timeline-panel">
          <div className="section-heading compact-heading">
            <div>
              <p>记录链</p>
              <h2>观察回合</h2>
            </div>
          </div>
          <div className="round-timeline">
            {roundsByTime.map((round, index) => {
              const sample = getSample(state, round.sampleId);
              const active = round.id === state.selectedRoundId;
              return (
                <button
                  key={round.id}
                  className={`timeline-item ${active ? "active" : ""}`}
                  onClick={() => setState(selectRound(state, round.id))}
                >
                  <span className="timeline-index">{String(index + 1).padStart(2, "0")}</span>
                  <span>
                    <strong>{sample?.name}</strong>
                    <em>{round.magnification}× · {round.focus}</em>
                    <small className="mono">hash {round.hash}</small>
                  </span>
                  <StatusPill tone={round.status === "confirmed" ? "ok" : round.status === "superseded" ? "danger" : "warn"}>
                    {round.status === "confirmed" ? "只读" : round.status === "superseded" ? "失效" : "草稿"}
                  </StatusPill>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="panel round-panel">
          {selectedRound && selectedSample && currentRound ? (
            <>
              <div className="section-heading">
                <div>
                  <p>{state.classroom.name}</p>
                  <h2>{selectedSample.name} / {selectedRound.magnification}× / {selectedRound.focus}</h2>
                </div>
                <div className="heading-actions">
                  {state.selectedRoundId !== state.currentRoundId && (
                    <button onClick={() => setState(useCurrentRound(state))}>回到当前回合</button>
                  )}
                  {actor.role === "teacher" && selectedRound.status === "draft" && (
                    <button
                      className="primary-action"
                      onClick={() => setState(confirmRound(state, selectedRound.id, runtime).state)}
                    >
                      老师确认并锁定
                    </button>
                  )}
                </div>
              </div>

              {state.selectedRoundId !== state.currentRoundId && (
                <div className="inline-banner warn-banner">正在查看历史回合；确认回合只读，新标注必须进入老师开启的当前回合。</div>
              )}

              <div className="chain-strip">
                {chain.map((round) => {
                  const sample = getSample(state, round.sampleId);
                  return (
                    <div key={round.id} className={`chain-node ${round.id === selectedRound.id ? "current" : ""}`}>
                      <span>{sample?.name}</span>
                      <strong>{round.magnification}×</strong>
                      <small className="mono">{round.prevHash} → {round.hash}</small>
                    </div>
                  );
                })}
              </div>

              <div className="round-meta-grid">
                <div><span>样本类型</span><strong>{selectedSample.type}</strong></div>
                <div><span>染色方式</span><strong>{selectedSample.stain}</strong></div>
                <div><span>开启原因</span><strong>{selectedRound.reason}</strong></div>
                <div><span>状态</span><strong>{selectedRound.status === "confirmed" ? "已确认，只读" : selectedRound.status === "superseded" ? "倍率已变化，回合失效" : "未确认"}</strong></div>
                <div><span>开启 / 确认时间</span><strong>{formatTime(selectedRound.startedAt)} / {formatTime(selectedRound.confirmedAt)}</strong></div>
                <div><span>确认哈希</span><strong className="mono">{selectedRound.confirmationHash ?? "确认后生成"}</strong></div>
              </div>

              <div className="subheading">
                <h3>本回合标注依据</h3>
                <p>坐标为视野画布坐标；同回合同坐标用统一键比较。</p>
              </div>
              <AnnotationRows annotations={selectedAnnotations} state={state} />

              {selectedPending.length > 0 && (
                <>
                  <div className="subheading warning-title">
                    <h3>确认后的离线补画（复审队列）</h3>
                    <p>不会覆盖已确认值，老师接受后才追加为审计补充。</p>
                  </div>
                  <PendingRows
                    annotations={selectedPending}
                    state={state}
                    onReview={(clientId, decision) =>
                      setState(reviewPendingAnnotation(state, clientId, decision, runtime).state)
                    }
                  />
                </>
              )}

              {selectedConflicts.length > 0 && (
                <div className="conflict-box">
                  <div className="subheading warning-title">
                    <h3>重叠坐标裁定</h3>
                    <p>双方值均保留，老师选择作为当前依据的值。</p>
                  </div>
                  {selectedConflicts.map((conflict) => {
                    const items = conflictAnnotations(conflict);
                    return (
                      <div className="conflict-card" key={conflict.id}>
                        <div className="conflict-head">
                          <strong>({conflict.x}, {conflict.y})</strong>
                          <StatusPill tone={conflict.status === "open" ? "danger" : "ok"}>{conflict.status}</StatusPill>
                        </div>
                        {items.map((item) => {
                          const author = state.users.find((user) => user.id === item.authorId);
                          return (
                            <label className="choice" key={item.clientId}>
                              <input
                                type="radio"
                                name={conflict.id}
                                disabled={actor.role !== "teacher" || conflict.status === "resolved"}
                                checked={conflict.winningClientId === item.clientId}
                                onChange={() => setState(resolveConflict(state, conflict.id, item.clientId, runtime).state)}
                              />
                              <span>
                                <strong>{item.label}：{item.value}</strong>
                                <em>{author?.name} · {shortId(item.clientId)}</em>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}

              {selectedOutbox.length > 0 && (
                <div className="outbox-box">
                  <div className="subheading">
                    <h3>本地待传（{selectedOutbox.length}）</h3>
                    <p>合并失败也保留；恢复后按 clientId 补缺，重复补传不生成副本。</p>
                  </div>
                  <ul>
                    {selectedOutbox.map((item) => (
                      <li key={item.clientId}>
                        <span>({item.x}, {item.y}) {item.label} · {item.value}</span>
                        <em>尝试 {item.attempts} 次 {item.lastError ? `· ${item.lastError}` : ""}</em>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : null}
        </section>
      </section>

      <section className="action-grid">
        <form className="panel action-panel" onSubmit={handleStartRound}>
          <div className="section-heading compact-heading">
            <div>
              <p>老师操作</p>
              <h2>换样本 / 物镜 / 焦点</h2>
            </div>
          </div>
          <label>
            <span>样本</span>
            <select value={roundSample} onChange={(event) => setRoundSample(event.target.value)} disabled={actor.role !== "teacher"}>
              {state.samples.map((sample) => <option key={sample.id} value={sample.id}>{sample.name}</option>)}
            </select>
          </label>
          <label>
            <span>倍率（×）</span>
            <input type="number" min={1} step={10} value={magnification} onChange={(event) => setMagnification(Number(event.target.value))} disabled={actor.role !== "teacher"} />
          </label>
          <label>
            <span>焦点</span>
            <input value={focus} onChange={(event) => setFocus(event.target.value)} disabled={actor.role !== "teacher"} placeholder="如 F2 细胞核层" />
          </label>
          <label>
            <span>开启原因</span>
            <input value={reason} onChange={(event) => setReason(event.target.value)} disabled={actor.role !== "teacher"} placeholder="如 切换到 400× 观察细胞核" />
          </label>
          {contextWillChange && (
            <div className="inline-banner warn-banner">
              {roundSample === currentRound?.sampleId && Number(magnification) !== currentRound?.magnification
                ? "倍率变化后，上一未确认回合的有效标注将失效，需重算。"
                : "将开启新回合；旧标注留在旧视野，不会串到新视野。"}
            </div>
          )}
          <button className="primary-action" disabled={actor.role !== "teacher" || !state.online || !contextWillChange}>
            固定上下文并开启回合
          </button>
          {actor.role !== "teacher" && <p className="hint">学生只读该操作；请请老师执行换样或调物镜。</p>}
        </form>

        <form className="panel action-panel" onSubmit={handleAddAnnotation}>
          <div className="section-heading compact-heading">
            <div>
              <p>学生操作</p>
              <h2>{state.online ? "在线标注" : "离线补画"}</h2>
            </div>
          </div>
          <div className="two-cols">
            <label><span>X</span><input type="number" value={x} onChange={(event) => setX(Number(event.target.value))} /></label>
            <label><span>Y</span><input type="number" value={y} onChange={(event) => setY(Number(event.target.value))} /></label>
          </div>
          <label><span>结构名称</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="如 细胞核" /></label>
          <label><span>测量值 / 依据</span><input value={value} onChange={(event) => setValue(event.target.value)} placeholder="如 8 μm" /></label>
          <button className="primary-action" disabled={!currentRound || currentRound.status === "confirmed"}>
            {state.online ? "提交坐标" : "保存到本地队列"}
          </button>
          <p className="hint">
            {currentRound?.status === "confirmed"
              ? "当前回合已只读，需老师开启续作回合。"
              : state.online
                ? "同坐标重复值自动归并；不同作者或不同值保留冲突。"
                : "断网期间不要新开回合；所有补画带稳定 clientId，回连后补传。"}
          </p>
        </form>

        <section className="panel action-panel sync-panel">
          <div className="section-heading compact-heading">
            <div>
              <p>回连续作</p>
              <h2>逐坐标同步</h2>
            </div>
          </div>
          <label>
            <span>模拟失败点</span>
            <select
              value={state.failureAfter ?? ""}
              onChange={(event) => setState(setFailureAfter(state, event.target.value === "" ? null : Number(event.target.value)))}
            >
              <option value="">不失败</option>
              <option value="0">第一条即失败</option>
              <option value="1">成功 1 条后失败</option>
              <option value="2">成功 2 条后失败</option>
            </select>
          </label>
          <button
            className="primary-action"
            disabled={!state.online || state.outbox.length === 0}
            onClick={() => setState(mergeOutbox(state, runtime).state)}
          >
            合并本地待传（{state.outbox.length}）
          </button>
          <ul className="rule-list">
            <li>按回合、坐标键匹配，不跨视野合并。</li>
            <li>同 clientId 重传跳过，避免副本。</li>
            <li>失败后保留本地回合和剩余坐标。</li>
            <li>确认回合后的补画进入老师复审队列。</li>
          </ul>
        </section>
      </section>

      {invalidAnnotations.length > 0 && (
        <section className="panel invalid-panel">
          <div className="section-heading">
            <div>
              <p>倍率变化</p>
              <h2>失效标注重算</h2>
            </div>
          </div>
          <div className="invalid-grid">
            {invalidAnnotations.map((annotation) => {
              const oldRound = getRound(state, annotation.roundId);
              const successor = oldRound ? recalculationTarget(state, oldRound) : undefined;
              const ratio = oldRound && successor ? successor.magnification / oldRound.magnification : 1;
              return (
                <article key={annotation.clientId} className="invalid-card">
                  <StatusPill tone="danger">invalid</StatusPill>
                  <h3>{annotation.label}</h3>
                  <p>原坐标 ({annotation.x}, {annotation.y}) · {oldRound?.magnification}×</p>
                  {successor ? (
                    <>
                      <p className="recalc-target">新坐标约 ({Math.round(annotation.x * ratio)}, {Math.round(annotation.y * ratio)}) · {successor.magnification}×</p>
                      <button
                        disabled={actor.role !== "student"}
                        onClick={() => setState(recalculateAnnotation(state, annotation.clientId, runtime).state)}
                      >
                        重算并补入新回合
                      </button>
                    </>
                  ) : (
                    <p className="hint">等待老师创建同一样本的倍率续作回合。</p>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}

export default App;

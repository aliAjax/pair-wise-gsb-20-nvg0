import { useMemo, useState } from "react";
import "./styles.css";
import {
  Annotation,
  DeviceStore,
  MAGNIFICATIONS,
  Role,
  ServerStore,
  fmtUm,
  roundLabel,
  withLog,
} from "./lib/types";
import {
  DEVICE_KEY,
  SERVER_KEY,
  loadStore,
  resetStores,
  saveStore,
  seedStores,
} from "./lib/store";
import * as chain from "./lib/chain";
import * as sync from "./lib/sync";
import { ChainNav } from "./components/ChainNav";
import { FieldCanvas } from "./components/FieldCanvas";
import { SyncPanel } from "./components/SyncPanel";

const STUDENT = "小林";
const TEACHER = "王老师";
const LABEL_PRESETS = ["细胞壁", "细胞核", "液泡", "叶绿体", "红细胞", "白细胞", "纤毛"];

function usePersistent<T>(key: string, fallback: () => T) {
  const [value, setValue] = useState<T>(() => loadStore(key, fallback));
  const set = (next: T) => {
    setValue(next);
    saveStore(key, next);
  };
  return [value, set] as const;
}

const statusText: Record<Annotation["status"], string> = {
  pending: "待确认",
  confirmed: "已确认",
  invalid: "已失效",
};

let toastSeq = 0;

function App() {
  const seed = useMemo(seedStores, []);
  const [device, setDevice] = usePersistent<DeviceStore>(DEVICE_KEY, () => seed.device);
  const [server, setServer] = usePersistent<ServerStore>(SERVER_KEY, () => seed.server);
  const [online, setOnline] = useState(true);
  const [role, setRole] = useState<Role>("student");
  const author = role === "teacher" ? TEACHER : STUDENT;

  const [roundId, setRoundId] = useState<string | null>(null);
  const [selectedAnnId, setSelectedAnnId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const [draftLabel, setDraftLabel] = useState("细胞核");
  const [draftLength, setDraftLength] = useState(10);
  const [newRound, setNewRound] = useState({ sampleId: "sp-onion", magnification: 400, focus: 15 });
  const [inject, setInject] = useState({ roundId: "sp-onion-r2", label: "液泡", x: 45, y: 61, length: 26 });
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);

  const pushToast = (text: string) => {
    const id = ++toastSeq;
    setToasts((list) => [...list, { id, text }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4200);
  };

  /** 本地改动 → 在线则立即合并同步，离线则保留本地 */
  const applyDevice = (fn: (d: DeviceStore) => { store: DeviceStore; toasts?: string[] }) => {
    try {
      const { store: d1, toasts: localToasts = [] } = fn(device);
      if (online) {
        const r = sync.syncDevice(d1, server, true);
        setDevice(r.device);
        setServer(r.server);
        [...localToasts, ...r.messages].forEach(pushToast);
      } else {
        setDevice(withLog(d1, ["离线：改动已保存在本地，待回连合并"]));
        [...localToasts, "离线中：改动已保存在本地"].forEach(pushToast);
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err));
    }
  };

  const runSync = (d: DeviceStore, s: ServerStore) => {
    const r = sync.syncDevice(d, s, true);
    setDevice(r.device);
    setServer(r.server);
    if (r.messages.length) r.messages.forEach(pushToast);
    else pushToast("所有回合均已同步");
  };

  // ---------- 派生状态 ----------
  const round =
    device.rounds.find((r) => r.id === roundId) ?? device.rounds[device.rounds.length - 1];
  const sample = device.samples.find((s) => s.id === round?.sampleId);
  const roundAnns = round ? chain.annotationsOf(device, round.id) : [];
  const readOnly = !round || round.status === "confirmed";
  const roundSync = round ? device.sync[round.id] ?? "synced" : "synced";
  const selectedAnn = device.annotations.find((a) => a.id === selectedAnnId) ?? null;
  const selectedAnnRound = selectedAnn
    ? device.rounds.find((r) => r.id === selectedAnn.roundId)
    : null;
  const openRoundOfSample = sample
    ? device.rounds.filter((r) => r.sampleId === sample.id && r.status === "open").slice(-1)[0]
    : undefined;
  const dirtyCount = device.rounds.filter(
    (r) => (device.sync[r.id] ?? "synced") !== "synced"
  ).length;

  // ---------- 操作 ----------
  const handleOpenRound = () =>
    applyDevice((d) => {
      const r = chain.openRound(d, { ...newRound, author }, Date.now());
      setRoundId(r.round.id);
      setSelectedAnnId(null);
      setDraft(null);
      return {
        store: r.store,
        toasts:
          r.invalidated > 0 ? [`倍率变化：${r.invalidated} 条未确认标注已失效，需重算`] : [],
      };
    });

  const handlePlace = (x: number, y: number) => {
    if (readOnly) {
      pushToast("回合已确认，只读");
      return;
    }
    setDraft({ x, y });
  };

  const handleAddAnnotation = () => {
    if (!draft || !round) return;
    const point = draft;
    applyDevice((d) => ({
      store: chain.addAnnotation(
        d,
        { roundId: round.id, author, x: point.x, y: point.y, label: draftLabel, length: draftLength },
        Date.now()
      ).store,
    }));
    setDraft(null);
  };

  const handleConfirmRound = () => {
    if (!round) return;
    applyDevice((d) => ({ store: chain.confirmRound(d, round.id, author, Date.now()) }));
  };

  const handleRecalc = (ann: Annotation) => {
    const target = device.rounds
      .filter((r) => r.sampleId === selectedAnnRound?.sampleId && r.status === "open")
      .slice(-1)[0];
    if (!target) {
      pushToast("该样本没有开放回合，无法重算");
      return;
    }
    applyDevice((d) => ({
      store: chain.recalcAnnotation(d, ann.id, target.id, author, Date.now()).store,
      toasts: [`已按倍率比换算，重算到${roundLabel(target)}`],
    }));
  };

  const handleRemove = (annId: string) =>
    applyDevice((d) => ({ store: chain.removeAnnotation(d, annId) }));

  const handleToggleNet = () => {
    const next = !online;
    setOnline(next);
    if (next) {
      pushToast("已回连：开始按回合合并");
      runSync(device, server);
    } else {
      pushToast("已断网：可继续补画，改动保留在本地");
    }
  };

  const handleResolve = (conflictId: string, choice: "local" | "remote" | "both") => {
    const s1 = sync.resolveConflict(server, conflictId, choice);
    setServer(s1);
    setDevice(sync.pullDevice(device, s1));
    pushToast(
      choice === "local" ? "已采用本地值" : choice === "remote" ? "已采用远端值" : "双方值均已保留"
    );
  };

  const handleUnlock = (rid: string) => {
    const s1 = sync.serverUnlockLateMerge(server, rid);
    pushToast("已解锁补录窗口，重试合并缺失坐标");
    if (online) runSync(device, s1);
    else setServer(s1);
  };

  const handleInject = () => {
    try {
      const r = sync.serverInjectAnnotation(
        server,
        { ...inject, author: "邻桌设备" },
        Date.now()
      );
      setServer(r.server);
      pushToast(`他端已在 (${inject.x},${inject.y}) 落点并同步到服务端`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err));
    }
  };

  const handleServerConfirm = (rid: string) => {
    try {
      setServer(sync.serverConfirmRound(server, rid, TEACHER, Date.now()));
      pushToast("他端已确认该回合（服务端只读）");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReset = () => {
    resetStores();
    const fresh = seedStores();
    setDevice(fresh.device);
    setServer(fresh.server);
    setRoundId(null);
    setSelectedAnnId(null);
    setDraft(null);
    pushToast("已重置演示数据");
  };

  const metrics: { label: string; value: number }[] = [
    { label: "样本数", value: device.samples.length },
    { label: "观察回合", value: device.rounds.length },
    { label: "标注总数", value: device.annotations.length },
    { label: "待同步回合", value: dirtyCount },
    { label: "待处理冲突", value: server.conflicts.length },
  ];

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-06 · 课堂 → 样本 → 回合 → 标注</p>
          <h1>显微镜观察记录链</h1>
          <p className="subtitle">
            每个观察回合固定样本、倍率与焦点，标注挂在回合上，测量依据不再错位。
            倍率变化后未确认标注自动失效重算；老师确认后回合只读；断网补画回连后按回合逐坐标合并，
            重叠位置保留双方值交老师处理，补传同一回合不生成副本。
          </p>
        </div>
        <div className="stack-card">
          <span>当前身份</span>
          <div className="role-switch">
            <button
              className={role === "student" ? "on" : ""}
              onClick={() => setRole("student")}
            >
              学生 · {STUDENT}
            </button>
            <button
              className={role === "teacher" ? "on" : ""}
              onClick={() => setRole("teacher")}
            >
              老师 · {TEACHER}
            </button>
          </div>
          <button className={`net-toggle ${online ? "on" : "off"}`} onClick={handleToggleNet}>
            {online ? "● 在线（点击断网）" : "○ 离线（点击回连）"}
          </button>
          <button onClick={handleReset}>重置演示数据</button>
        </div>
      </section>

      <section className="metrics-grid five">
        {metrics.map((m) => (
          <article key={m.label} className="metric-card">
            <span>{m.label}</span>
            <strong>{m.value}</strong>
          </article>
        ))}
      </section>

      <section className="workspace three-col">
        <ChainNav
          device={device}
          selectedRoundId={round?.id}
          onSelectRound={(id) => {
            setRoundId(id);
            setSelectedAnnId(null);
            setDraft(null);
          }}
          isTeacher={role === "teacher"}
          newRound={newRound}
          onChangeNewRound={setNewRound}
          onOpenRound={handleOpenRound}
          magnifications={MAGNIFICATIONS}
        />

        <section className="panel main-col">
          {round && sample ? (
            <>
              <div className="round-banner">
                <div>
                  <p className="eyebrow">
                    {sample.name} · {sample.kind} · {sample.stain}
                  </p>
                  <h2>
                    {roundLabel(round)} · {round.magnification}x · 焦点 {round.focus}
                  </h2>
                </div>
                <div className="round-flags">
                  <span className={`flag ${round.status === "confirmed" ? "lock" : "open"}`}>
                    {round.status === "confirmed"
                      ? `已确认 · 只读（${round.confirmedBy}）`
                      : "开放中"}
                  </span>
                  {roundSync !== "synced" && (
                    <span className={`flag ${roundSync === "failed" ? "bad" : "warn"}`}>
                      {roundSync === "failed" ? "合并失败 · 本地已保留" : "待同步"}
                    </span>
                  )}
                  {role === "teacher" && round.status === "open" && (
                    <button className="primary-action" onClick={handleConfirmRound}>
                      确认本回合
                    </button>
                  )}
                </div>
              </div>

              <FieldCanvas
                round={round}
                annotations={roundAnns}
                readOnly={readOnly}
                selectedId={selectedAnnId}
                draft={draft}
                onPlace={handlePlace}
                onSelect={setSelectedAnnId}
              />

              {draft && !readOnly && (
                <div className="draft-form">
                  <b>
                    落点 ({draft.x},{draft.y})
                  </b>
                  <input
                    list="label-presets"
                    value={draftLabel}
                    onChange={(e) => setDraftLabel(e.target.value)}
                    placeholder="结构名称"
                  />
                  <datalist id="label-presets">
                    {LABEL_PRESETS.map((l) => (
                      <option key={l} value={l} />
                    ))}
                  </datalist>
                  <input
                    type="number"
                    min={1}
                    value={draftLength}
                    onChange={(e) => setDraftLength(Number(e.target.value))}
                    placeholder="长度（视野单位）"
                  />
                  <span className="hint">
                    ≈ {fmtUm(draftLength, round.magnification)}（按 {round.magnification}x 换算）
                  </span>
                  <button className="primary-action" onClick={handleAddAnnotation}>
                    添加标注
                  </button>
                  <button onClick={() => setDraft(null)}>取消</button>
                </div>
              )}

              <table className="ann-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>结构</th>
                    <th>坐标</th>
                    <th>测量</th>
                    <th>状态</th>
                    <th>作者</th>
                    <th>依据 / 备注</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {roundAnns.map((a, i) => (
                    <tr
                      key={a.id}
                      className={a.id === selectedAnnId ? "selected" : ""}
                      onClick={() => setSelectedAnnId(a.id)}
                    >
                      <td>{i + 1}</td>
                      <td>{a.label}</td>
                      <td>
                        ({a.x},{a.y})
                      </td>
                      <td>{fmtUm(a.length, round.magnification)}</td>
                      <td>
                        <span className={`ann-status ${a.status}`}>{statusText[a.status]}</span>
                      </td>
                      <td>{a.author}</td>
                      <td className="note">
                        {a.note ?? `${sample.name} · ${round.magnification}x · 焦点${round.focus}`}
                      </td>
                      <td className="row-actions">
                        {a.status === "invalid" && openRoundOfSample && (
                          <button onClick={() => handleRecalc(a)}>
                            重算到{roundLabel(openRoundOfSample)}
                          </button>
                        )}
                        {a.status === "pending" && !readOnly && (
                          <button onClick={() => handleRemove(a.id)}>删除</button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {roundAnns.length === 0 && (
                    <tr>
                      <td colSpan={8} className="hint">
                        本回合暂无标注{readOnly ? "" : "，点击视野落点开始"}。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          ) : (
            <p className="hint">请先在左侧创建一个观察回合。</p>
          )}
        </section>

        <SyncPanel
          online={online}
          isTeacher={role === "teacher"}
          device={device}
          server={server}
          onSyncNow={() => runSync(device, server)}
          onResolve={handleResolve}
          onUnlock={handleUnlock}
          inject={inject}
          onChangeInject={setInject}
          onInject={handleInject}
          onServerConfirm={handleServerConfirm}
        />
      </section>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
          </div>
        ))}
      </div>
    </main>
  );
}

export default App;

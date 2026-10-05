// 同步面板：待同步队列、重叠冲突仲裁、模拟他端工具、同步日志

import { ConflictPair, DeviceStore, Round, ServerStore, fmtUm, roundLabel } from "../lib/types";

const syncText: Record<string, string> = {
  synced: "已同步",
  pending: "待同步",
  failed: "合并失败",
};

interface Props {
  online: boolean;
  isTeacher: boolean;
  device: DeviceStore;
  server: ServerStore;
  onSyncNow: () => void;
  onResolve: (conflictId: string, choice: "local" | "remote" | "both") => void;
  onUnlock: (roundId: string) => void;
  inject: { roundId: string; label: string; x: number; y: number; length: number };
  onChangeInject: (v: Props["inject"]) => void;
  onInject: () => void;
  onServerConfirm: (roundId: string) => void;
}

function roundName(rounds: Round[], roundId: string): string {
  const r = rounds.find((x) => x.id === roundId);
  return r ? roundLabel(r) : roundId;
}

function ConflictCard({
  conflict,
  rounds,
  isTeacher,
  onResolve,
}: {
  conflict: ConflictPair;
  rounds: Round[];
  isTeacher: boolean;
  onResolve: Props["onResolve"];
}) {
  const mag = rounds.find((r) => r.id === conflict.roundId)?.magnification ?? 100;
  const side = (title: string, a: ConflictPair["local"], cls: string) => (
    <div className={`conflict-side ${cls}`}>
      <b>{title}</b>
      <span>{a.label}</span>
      <span>
        ({a.x},{a.y}) · {fmtUm(a.length, mag)} · {a.author}
      </span>
    </div>
  );
  return (
    <article className="conflict-card">
      <p className="conflict-head">
        重叠位置 ({conflict.local.x},{conflict.local.y}) · {roundName(rounds, conflict.roundId)}
      </p>
      <div className="conflict-body">
        {side("本地补画", conflict.local, "local")}
        {side("服务端已有", conflict.remote, "remote")}
      </div>
      {isTeacher ? (
        <div className="conflict-actions">
          <button onClick={() => onResolve(conflict.id, "local")}>采用本地</button>
          <button onClick={() => onResolve(conflict.id, "remote")}>采用远端</button>
          <button onClick={() => onResolve(conflict.id, "both")}>双方保留</button>
        </div>
      ) : (
        <p className="hint">双方值已保留，等待老师处理。</p>
      )}
    </article>
  );
}

export function SyncPanel(props: Props) {
  const { online, isTeacher, device, server } = props;
  const dirty = device.rounds.filter((r) => (device.sync[r.id] ?? "synced") !== "synced");
  const serverOpenRounds = server.rounds.filter((r) => r.status === "open");

  return (
    <aside className="panel narrow sync-panel">
      <h2>同步</h2>
      <p className={`net-state ${online ? "on" : "off"}`}>
        <i className={`dot ${online ? "dot-ok" : "dot-bad"}`} />
        {online ? "在线：改动即时合并到课堂服务端" : "离线：补画保留在本地，回连后按回合合并"}
      </p>

      {dirty.length > 0 ? (
        <div className="sync-queue">
          {dirty.map((r) => {
            const st = device.sync[r.id];
            return (
              <div key={r.id} className={`sync-item ${st}`}>
                <span>
                  {roundLabel(r)} · {r.magnification}x
                </span>
                <em>{syncText[st]}</em>
                {st === "failed" && isTeacher && (
                  <button onClick={() => props.onUnlock(r.id)}>解锁补录</button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="hint">所有回合均已同步。</p>
      )}
      <button className="primary-action wide" onClick={props.onSyncNow} disabled={!online}>
        立即同步
      </button>

      <h2>重叠冲突（{server.conflicts.length}）</h2>
      {server.conflicts.length === 0 && <p className="hint">无待处理冲突。</p>}
      {server.conflicts.map((c) => (
        <ConflictCard
          key={c.id}
          conflict={c}
          rounds={server.rounds}
          isTeacher={isTeacher}
          onResolve={props.onResolve}
        />
      ))}

      {isTeacher && (
        <div className="peer-tools">
          <h2>模拟他端（教学演示）</h2>
          <label>
            <span>回合</span>
            <select
              value={props.inject.roundId}
              onChange={(e) => props.onChangeInject({ ...props.inject, roundId: e.target.value })}
            >
              {serverOpenRounds.map((r) => (
                <option key={r.id} value={r.id}>
                  {roundName(server.rounds, r.id)} · {r.magnification}x
                </option>
              ))}
            </select>
          </label>
          <div className="inject-grid">
            <label>
              <span>结构</span>
              <input
                value={props.inject.label}
                onChange={(e) => props.onChangeInject({ ...props.inject, label: e.target.value })}
              />
            </label>
            <label>
              <span>X</span>
              <input
                type="number"
                value={props.inject.x}
                onChange={(e) => props.onChangeInject({ ...props.inject, x: Number(e.target.value) })}
              />
            </label>
            <label>
              <span>Y</span>
              <input
                type="number"
                value={props.inject.y}
                onChange={(e) => props.onChangeInject({ ...props.inject, y: Number(e.target.value) })}
              />
            </label>
            <label>
              <span>长度</span>
              <input
                type="number"
                value={props.inject.length}
                onChange={(e) =>
                  props.onChangeInject({ ...props.inject, length: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <button onClick={props.onInject}>他端注入标注（直接到服务端）</button>
          <button onClick={() => props.onServerConfirm(props.inject.roundId)}>
            他端确认该回合
          </button>
          <p className="hint">用于演示：断网补画与他端改动在回连合并时产生冲突或合并失败。</p>
        </div>
      )}

      <h2>同步日志</h2>
      <ul className="sync-log">
        {device.log.slice(0, 10).map((line, i) => (
          <li key={`${i}-${line}`}>{line}</li>
        ))}
      </ul>
    </aside>
  );
}

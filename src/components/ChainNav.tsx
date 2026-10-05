// 记录链导航：课堂 → 样本 → 观察回合

import { DeviceStore, Round, SyncState, roundLabel } from "../lib/types";

const syncChip: Record<SyncState, { text: string; cls: string }> = {
  synced: { text: "已同步", cls: "dot-ok" },
  pending: { text: "待同步", cls: "dot-warn" },
  failed: { text: "合并失败", cls: "dot-bad" },
};

interface Props {
  device: DeviceStore;
  selectedRoundId: string | undefined;
  onSelectRound: (roundId: string) => void;
  isTeacher: boolean;
  newRound: { sampleId: string; magnification: number; focus: number };
  onChangeNewRound: (v: { sampleId: string; magnification: number; focus: number }) => void;
  onOpenRound: () => void;
  magnifications: number[];
}

export function ChainNav(props: Props) {
  const { device, selectedRoundId, onSelectRound, isTeacher } = props;
  const session = device.sessions[0];

  const roundState = (round: Round): SyncState => device.sync[round.id] ?? "synced";

  return (
    <aside className="panel narrow chain-nav">
      <p className="chain-session">
        {session?.name}
        <span>{session?.date}</span>
      </p>

      {device.samples.map((sample) => {
        const rounds = device.rounds.filter((r) => r.sampleId === sample.id);
        return (
          <div key={sample.id} className="chain-sample">
            <h3>
              {sample.name}
              <span>
                {sample.kind} · {sample.stain}
              </span>
            </h3>
            {rounds.length === 0 && <p className="chain-empty">尚无观察回合</p>}
            <div className="chain-rounds">
              {rounds.map((round) => {
                const st = syncChip[roundState(round)];
                const active = round.id === selectedRoundId;
                return (
                  <button
                    key={round.id}
                    className={`chain-round${active ? " active" : ""}`}
                    onClick={() => onSelectRound(round.id)}
                    title={`${roundLabel(round)} · ${round.magnification}x · 焦点 ${round.focus}`}
                  >
                    <i className={`dot ${round.status === "confirmed" ? "dot-lock" : st.cls}`} />
                    <b>{roundLabel(round)}</b>
                    <span>
                      {round.magnification}x · 焦点{round.focus}
                      {round.status === "confirmed" ? " · 只读" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {isTeacher && (
        <div className="new-round">
          <h3>新开回合（固定倍率与焦点）</h3>
          <label>
            <span>样本</span>
            <select
              value={props.newRound.sampleId}
              onChange={(e) =>
                props.onChangeNewRound({ ...props.newRound, sampleId: e.target.value })
              }
            >
              {device.samples.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>倍率</span>
            <select
              value={props.newRound.magnification}
              onChange={(e) =>
                props.onChangeNewRound({
                  ...props.newRound,
                  magnification: Number(e.target.value),
                })
              }
            >
              {props.magnifications.map((m) => (
                <option key={m} value={m}>
                  {m}x
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>焦点刻度</span>
            <input
              type="number"
              step={0.5}
              value={props.newRound.focus}
              onChange={(e) =>
                props.onChangeNewRound({ ...props.newRound, focus: Number(e.target.value) })
              }
            />
          </label>
          <button className="primary-action" onClick={props.onOpenRound}>
            固定条件，开新回合
          </button>
          <p className="hint">倍率变化后，此前未确认的标注将失效并需重算。</p>
        </div>
      )}
    </aside>
  );
}

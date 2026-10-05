// 视野画布：点击落点标注，坐标固定在 0-100 视野坐标系

import { Annotation, Round, fmtUm } from "../lib/types";

const SIZE = 340;
const CENTER = SIZE / 2;
const RADIUS = 150;

const statusColor: Record<Annotation["status"], string> = {
  pending: "#d97706",
  confirmed: "#0d9488",
  invalid: "#94a3b8",
};

interface Props {
  round: Round;
  annotations: Annotation[];
  readOnly: boolean;
  selectedId: string | null;
  draft: { x: number; y: number } | null;
  onPlace: (x: number, y: number) => void;
  onSelect: (id: string) => void;
}

function toSvg(x: number, y: number): { cx: number; cy: number } {
  return { cx: CENTER + ((x - 50) / 50) * RADIUS, cy: CENTER + ((y - 50) / 50) * RADIUS };
}

export function FieldCanvas(props: Props) {
  const { round, annotations, readOnly, selectedId, draft, onPlace, onSelect } = props;

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (readOnly) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * SIZE;
    const py = ((e.clientY - rect.top) / rect.height) * SIZE;
    const fx = ((px - CENTER) / RADIUS) * 50 + 50;
    const fy = ((py - CENTER) / RADIUS) * 50 + 50;
    if (fx < 0 || fx > 100 || fy < 0 || fy > 100) return; // 视野外
    onPlace(Math.round(fx * 10) / 10, Math.round(fy * 10) / 10);
  };

  return (
    <div className={`field-canvas${readOnly ? " readonly" : ""}`}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} onClick={handleClick} role="img">
        <circle cx={CENTER} cy={CENTER} r={RADIUS} className="field-bg" />
        <circle cx={CENTER} cy={CENTER} r={RADIUS * 0.66} className="field-ring" />
        <circle cx={CENTER} cy={CENTER} r={RADIUS * 0.33} className="field-ring" />
        <line x1={CENTER - RADIUS} y1={CENTER} x2={CENTER + RADIUS} y2={CENTER} className="field-axis" />
        <line x1={CENTER} y1={CENTER - RADIUS} x2={CENTER} y2={CENTER + RADIUS} className="field-axis" />
        <text x={CENTER + 6} y={CENTER - RADIUS + 16} className="field-tick">
          (50,50)
        </text>

        {annotations.map((a, i) => {
          const { cx, cy } = toSvg(a.x, a.y);
          const selected = a.id === selectedId;
          return (
            <g
              key={a.id}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(a.id);
              }}
              className="field-dot"
            >
              <title>
                {a.label} · ({a.x},{a.y}) · {fmtUm(a.length, round.magnification)}
              </title>
              {selected && <circle cx={cx} cy={cy} r={11} className="field-selected" />}
              <circle
                cx={cx}
                cy={cy}
                r={6}
                fill={statusColor[a.status]}
                strokeDasharray={a.status === "invalid" ? "3 2" : undefined}
                stroke={a.status === "invalid" ? "#64748b" : "#ffffff"}
                strokeWidth={a.status === "invalid" ? 1.5 : 2}
              />
              <text x={cx + 9} y={cy - 7} className="field-label">
                {i + 1}
              </text>
            </g>
          );
        })}

        {draft && (
          <circle
            cx={toSvg(draft.x, draft.y).cx}
            cy={toSvg(draft.x, draft.y).cy}
            r={8}
            className="field-draft"
          />
        )}
      </svg>
      <div className="field-legend">
        <span>
          <i style={{ background: statusColor.pending }} /> 待确认
        </span>
        <span>
          <i style={{ background: statusColor.confirmed }} /> 已确认
        </span>
        <span>
          <i style={{ background: statusColor.invalid }} /> 已失效
        </span>
        <span className="field-mode">{readOnly ? "只读（老师已确认）" : "点击视野落点标注"}</span>
      </div>
    </div>
  );
}

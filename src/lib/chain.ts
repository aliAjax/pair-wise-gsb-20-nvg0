// 记录链的本地操作：开回合（固定样本/倍率/焦点）、标注、确认、失效重算
// 全部为纯函数：输入旧库，返回新库，改动回合并标记为待同步

import {
  Annotation,
  DeviceStore,
  Round,
  round1,
  roundLabel,
  uid,
  withLog,
} from "./types";

export function getRound(device: DeviceStore, roundId: string): Round | undefined {
  return device.rounds.find((r) => r.id === roundId);
}

export function annotationsOf(device: DeviceStore, roundId: string): Annotation[] {
  return device.annotations.filter((a) => a.roundId === roundId);
}

export function latestRoundOfSample(device: DeviceStore, sampleId: string): Round | undefined {
  const list = device.rounds.filter((r) => r.sampleId === sampleId);
  return list.length ? list[list.length - 1] : undefined;
}

export function openRound(
  device: DeviceStore,
  input: { sampleId: string; magnification: number; focus: number; author: string },
  now: number
): { store: DeviceStore; round: Round; invalidated: number } {
  const sample = device.samples.find((s) => s.id === input.sampleId);
  if (!sample) throw new Error("样本不存在");
  const seq = device.rounds.filter((r) => r.sampleId === input.sampleId).length + 1;
  const round: Round = {
    id: `${input.sampleId}-r${seq}`,
    sessionId: sample.sessionId,
    sampleId: input.sampleId,
    seq,
    magnification: input.magnification,
    focus: input.focus,
    status: "open",
    createdBy: input.author,
    createdAt: now,
  };

  // 倍率变化 → 该样本此前回合里未确认的标注失效，需在新回合重算
  const prev = latestRoundOfSample(device, input.sampleId);
  const sync = { ...device.sync };
  let invalidated = 0;
  let annotations = device.annotations;
  if (prev && prev.magnification !== input.magnification) {
    const sampleRoundIds = new Set(
      device.rounds.filter((r) => r.sampleId === input.sampleId).map((r) => r.id)
    );
    annotations = annotations.map((a) => {
      if (a.status === "pending" && sampleRoundIds.has(a.roundId)) {
        invalidated += 1;
        sync[a.roundId] = "pending"; // 失效也是改动，需要同步
        return {
          ...a,
          status: "invalid" as const,
          note: `倍率 ${prev.magnification}x → ${input.magnification}x，需在新回合重测`,
          updatedAt: now,
        };
      }
      return a;
    });
  }
  sync[round.id] = "pending";

  const messages = [
    `新开${roundLabel(round)}：${sample.name} · ${input.magnification}x · 焦点 ${input.focus}`,
  ];
  if (invalidated > 0) {
    messages.push(`倍率变化，${invalidated} 条未确认标注已失效，需重算`);
  }
  return {
    store: withLog(
      { ...device, rounds: [...device.rounds, round], annotations, sync },
      messages
    ),
    round,
    invalidated,
  };
}

export function addAnnotation(
  device: DeviceStore,
  input: {
    roundId: string;
    author: string;
    x: number;
    y: number;
    label: string;
    length: number;
  },
  now: number
): { store: DeviceStore; annotation: Annotation } {
  const round = getRound(device, input.roundId);
  if (!round) throw new Error("回合不存在");
  if (round.status === "confirmed") throw new Error("回合已确认，只读");
  const annotation: Annotation = {
    id: uid("ann"),
    roundId: input.roundId,
    author: input.author,
    x: round1(input.x),
    y: round1(input.y),
    label: input.label.trim() || "未命名结构",
    length: input.length,
    status: "pending",
    updatedAt: now,
  };
  return {
    store: {
      ...device,
      annotations: [...device.annotations, annotation],
      sync: { ...device.sync, [round.id]: "pending" },
    },
    annotation,
  };
}

/** 老师确认：回合只读，回合内待确认标注一并确认 */
export function confirmRound(
  device: DeviceStore,
  roundId: string,
  teacher: string,
  now: number
): DeviceStore {
  const round = getRound(device, roundId);
  if (!round) throw new Error("回合不存在");
  if (round.status === "confirmed") return device;
  const rounds = device.rounds.map((r) =>
    r.id === roundId
      ? { ...r, status: "confirmed" as const, confirmedBy: teacher, confirmedAt: now }
      : r
  );
  const annotations = device.annotations.map((a) =>
    a.roundId === roundId && a.status === "pending"
      ? { ...a, status: "confirmed" as const, updatedAt: now }
      : a
  );
  return withLog(
    { ...device, rounds, annotations, sync: { ...device.sync, [roundId]: "pending" } },
    [`老师已确认${roundLabel(round)}，回合只读`]
  );
}

/** 失效重算：把失效标注按倍率比换算后落入指定开放回合，重新待确认 */
export function recalcAnnotation(
  device: DeviceStore,
  annotationId: string,
  targetRoundId: string,
  author: string,
  now: number
): { store: DeviceStore; annotation: Annotation } {
  const src = device.annotations.find((a) => a.id === annotationId);
  if (!src) throw new Error("标注不存在");
  if (src.status !== "invalid") throw new Error("仅失效标注需要重算");
  const srcRound = getRound(device, src.roundId);
  const target = getRound(device, targetRoundId);
  if (!srcRound || !target) throw new Error("回合不存在");
  if (target.status !== "open") throw new Error("目标回合只读");
  if (target.sampleId !== srcRound.sampleId) throw new Error("只能在同样本的回合重算");
  const annotation: Annotation = {
    id: uid("ann"),
    roundId: target.id,
    author,
    x: src.x,
    y: src.y,
    label: src.label,
    length: round1((src.length * target.magnification) / srcRound.magnification),
    status: "pending",
    note: `由${roundLabel(srcRound)}重算`,
    updatedAt: now,
  };
  return {
    store: {
      ...device,
      annotations: [...device.annotations, annotation],
      sync: { ...device.sync, [target.id]: "pending" },
    },
    annotation,
  };
}

export function removeAnnotation(device: DeviceStore, annotationId: string): DeviceStore {
  const target = device.annotations.find((a) => a.id === annotationId);
  if (!target) return device;
  if (target.status !== "pending") throw new Error("仅待确认标注可删除");
  return {
    ...device,
    annotations: device.annotations.filter((a) => a.id !== annotationId),
    sync: { ...device.sync, [target.roundId]: "pending" },
  };
}

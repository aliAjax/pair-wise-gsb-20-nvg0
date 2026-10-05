// 同步引擎：按回合逐坐标合并；重叠位置留双方值；失败保留本地；补传幂等

import {
  Annotation,
  DeviceStore,
  OVERLAP_RADIUS,
  Round,
  ServerStore,
  dist,
  roundLabel,
  sameContent,
  sameShape,
  uid,
} from "./types";

export interface PushResult {
  ok: boolean;
  reason?: string;
  inserted: number;
  updated: number;
  skipped: number; // 已存在/被拒绝/同位置同内容 → 幂等跳过
  conflicts: number;
  relocked?: boolean; // 补录窗口用完后重新锁定
}

/**
 * 把一个本地回合（含标注）合并进服务端。
 * 幂等：回合与标注都以稳定ID upsert，同一回合重复补传不产生副本。
 */
export function pushRoundToServer(
  server: ServerStore,
  round: Round,
  anns: Annotation[]
): { server: ServerStore; result: PushResult } {
  const rejected = server.rejected[round.id] ?? [];
  const payload = anns
    .filter((a) => !rejected.includes(a.id))
    .slice()
    .sort((a, b) => a.updatedAt - b.updatedAt);

  const serverRound = server.rounds.find((r) => r.id === round.id);

  // 服务端还没有该回合 → 整回合采纳
  if (!serverRound) {
    return {
      server: {
        ...server,
        rounds: [...server.rounds, { ...round }],
        annotations: [...server.annotations, ...payload.map((a) => ({ ...a }))],
      },
      result: { ok: true, inserted: payload.length, updated: 0, skipped: 0, conflicts: 0 },
    };
  }

  // 回合已被确认且未开补录窗口 → 只接受"无新工作"的幂等重传，否则整回合拒绝
  const locked = serverRound.status === "confirmed" && !serverRound.allowLateMerge;
  const byId = new Map(server.annotations.map((a) => [a.id, a]));
  const hasNewWork = payload.some((a) => {
    const srv = byId.get(a.id);
    return !srv || !sameShape(srv, a);
  });
  if (locked && hasNewWork) {
    return {
      server,
      result: {
        ok: false,
        reason: "回合已被老师确认为只读",
        inserted: 0,
        updated: 0,
        skipped: 0,
        conflicts: 0,
      },
    };
  }

  let annotations = [...server.annotations];
  let conflicts = [...server.conflicts];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let conflictCount = 0;

  for (const a of payload) {
    const srv = annotations.find((x) => x.id === a.id);
    if (srv) {
      // 已确认标注不可覆盖；内容一致或本地更旧 → 幂等跳过
      if (srv.status === "confirmed" || sameShape(srv, a) || srv.updatedAt >= a.updatedAt) {
        skipped += 1;
      } else {
        annotations = annotations.map((x) => (x.id === a.id ? { ...a } : x));
        updated += 1;
      }
      continue;
    }
    // 逐坐标检查重叠位置
    const occupant = annotations.find(
      (x) => x.roundId === round.id && x.status !== "invalid" && dist(x, a) <= OVERLAP_RADIUS
    );
    if (occupant && !sameContent(occupant, a)) {
      // 重叠位置：双方值都保留为冲突，交给老师处理
      conflicts = [
        ...conflicts,
        {
          id: uid("cf"),
          roundId: round.id,
          local: { ...a },
          remote: { ...occupant },
          createdAt: Date.now(),
        },
      ];
      conflictCount += 1;
      continue;
    }
    if (occupant) {
      skipped += 1; // 同位置同内容 → 去重
      continue;
    }
    annotations = [...annotations, { ...a }];
    inserted += 1;
  }

  // 回合元数据：服务端已确认则保持权威；否则采纳本地确认结果；补录窗口用后关闭
  let rounds = server.rounds;
  let relocked = false;
  if (serverRound.allowLateMerge) {
    rounds = rounds.map((r) => (r.id === round.id ? { ...r, allowLateMerge: false } : r));
    relocked = true;
  }
  if (serverRound.status !== "confirmed" && round.status === "confirmed") {
    rounds = rounds.map((r) =>
      r.id === round.id
        ? {
            ...r,
            status: "confirmed" as const,
            confirmedBy: round.confirmedBy,
            confirmedAt: round.confirmedAt,
            allowLateMerge: false,
          }
        : r
    );
    relocked = false;
  }

  return {
    server: { ...server, rounds, annotations, conflicts },
    result: { ok: true, inserted, updated, skipped, conflicts: conflictCount, relocked },
  };
}

/** 拉取：服务端回合状态与标注回灌本地；仲裁落败的标注从本地移除 */
export function pullDevice(device: DeviceStore, server: ServerStore): DeviceStore {
  let rounds = device.rounds.map((r) => {
    const sr = server.rounds.find((x) => x.id === r.id);
    return sr
      ? {
          ...r,
          status: sr.status,
          confirmedBy: sr.confirmedBy,
          confirmedAt: sr.confirmedAt,
          allowLateMerge: sr.allowLateMerge,
        }
      : r;
  });
  for (const sr of server.rounds) {
    if (!rounds.some((r) => r.id === sr.id)) rounds = [...rounds, { ...sr }];
  }

  let annotations = device.annotations.map((a) => {
    const sa = server.annotations.find((x) => x.id === a.id);
    return sa ? { ...sa } : a;
  });
  for (const sa of server.annotations) {
    if (!annotations.some((a) => a.id === sa.id)) annotations = [...annotations, { ...sa }];
  }
  const rejectedSet = new Set(Object.values(server.rejected).flat());
  annotations = annotations.filter((a) => !rejectedSet.has(a.id));

  return { ...device, rounds, annotations };
}

/** 推送所有待同步回合并拉取服务端状态；离线时只保留本地 */
export function syncDevice(
  device: DeviceStore,
  server: ServerStore,
  online: boolean
): { device: DeviceStore; server: ServerStore; messages: string[] } {
  if (!online) {
    return { device, server, messages: ["离线中：改动已保留在本地，回连后按回合合并"] };
  }
  const messages: string[] = [];
  let srv = server;
  const syncMap = { ...device.sync };
  const dirtyIds = Object.keys(syncMap).filter((id) => syncMap[id] !== "synced");

  for (const roundId of dirtyIds) {
    const round = device.rounds.find((r) => r.id === roundId);
    if (!round) {
      syncMap[roundId] = "synced";
      continue;
    }
    const anns = device.annotations.filter((a) => a.roundId === roundId);
    const pushed = pushRoundToServer(srv, round, anns);
    srv = pushed.server;
    const { result } = pushed;
    if (result.ok) {
      syncMap[roundId] = "synced";
      if (result.inserted + result.updated + result.conflicts === 0) {
        messages.push(`${roundLabel(round)}已是最新，未生成副本`);
      } else {
        const detail = [
          `新增 ${result.inserted}`,
          `更新 ${result.updated}`,
          `跳过 ${result.skipped}`,
        ];
        if (result.conflicts > 0) detail.push(`重叠冲突 ${result.conflicts} 处待老师处理`);
        if (result.relocked) detail.push("补录完成，回合重新锁定");
        messages.push(`${roundLabel(round)}已同步：${detail.join("，")}`);
      }
    } else {
      syncMap[roundId] = "failed";
      messages.push(`${roundLabel(round)}合并失败：${result.reason}，本地回合已保留`);
    }
  }

  return { device: pullDevice({ ...device, sync: syncMap }, srv), server: srv, messages };
}

// ---------- 服务端侧操作（模拟他端 / 老师仲裁） ----------

/** 他端确认：模拟老师在另一台设备上确认回合 */
export function serverConfirmRound(
  server: ServerStore,
  roundId: string,
  teacher: string,
  now: number
): ServerStore {
  return {
    ...server,
    rounds: server.rounds.map((r) =>
      r.id === roundId
        ? { ...r, status: "confirmed" as const, confirmedBy: teacher, confirmedAt: now }
        : r
    ),
    annotations: server.annotations.map((a) =>
      a.roundId === roundId && a.status === "pending"
        ? { ...a, status: "confirmed" as const, updatedAt: now }
        : a
    ),
  };
}

/** 他端注入：模拟另一台设备已同步到服务端的标注 */
export function serverInjectAnnotation(
  server: ServerStore,
  input: { roundId: string; author: string; x: number; y: number; label: string; length: number },
  now: number
): { server: ServerStore; annotation: Annotation } {
  const round = server.rounds.find((r) => r.id === input.roundId);
  if (!round) throw new Error("服务端没有该回合");
  if (round.status === "confirmed") throw new Error("服务端回合已确认");
  const annotation: Annotation = {
    id: uid("srv-ann"),
    roundId: input.roundId,
    author: input.author,
    x: input.x,
    y: input.y,
    label: input.label,
    length: input.length,
    status: "pending",
    updatedAt: now,
  };
  return { server: { ...server, annotations: [...server.annotations, annotation] }, annotation };
}

/** 老师解锁补录窗口：允许合并失败方补传缺失坐标 */
export function serverUnlockLateMerge(server: ServerStore, roundId: string): ServerStore {
  return {
    ...server,
    rounds: server.rounds.map((r) =>
      r.id === roundId ? { ...r, allowLateMerge: true } : r
    ),
  };
}

/** 老师处理重叠冲突：采用本地 / 采用远端 / 双方保留 */
export function resolveConflict(
  server: ServerStore,
  conflictId: string,
  choice: "local" | "remote" | "both"
): ServerStore {
  const conflict = server.conflicts.find((c) => c.id === conflictId);
  if (!conflict) return server;
  let annotations = server.annotations;
  const rejected = { ...server.rejected };
  const rej = rejected[conflict.roundId] ?? [];

  if (choice === "local") {
    annotations = annotations.filter((a) => a.id !== conflict.remote.id);
    if (!annotations.some((a) => a.id === conflict.local.id)) {
      annotations = [...annotations, { ...conflict.local }];
    }
    rejected[conflict.roundId] = [...rej, conflict.remote.id];
  } else if (choice === "remote") {
    rejected[conflict.roundId] = [...rej, conflict.local.id];
  } else {
    if (!annotations.some((a) => a.id === conflict.local.id)) {
      annotations = [...annotations, { ...conflict.local }];
    }
  }
  return {
    ...server,
    annotations,
    rejected,
    conflicts: server.conflicts.filter((c) => c.id !== conflictId),
  };
}

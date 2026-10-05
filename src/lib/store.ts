// 持久化与示例数据：设备库 / 模拟服务端分别存 localStorage，刷新后可续作

import {
  Annotation,
  ClassSession,
  DeviceStore,
  Round,
  Sample,
  ServerStore,
  logLine,
} from "./types";

export const DEVICE_KEY = "hxwl06.device.v1";
export const SERVER_KEY = "hxwl06.server.v1";

export function seedStores(): { device: DeviceStore; server: ServerStore } {
  const now = Date.now();
  const session: ClassSession = {
    id: "s1",
    name: "显微观察课堂 · 高一(3)班",
    date: "2026-10-05",
  };
  const samples: Sample[] = [
    { id: "sp-onion", sessionId: "s1", name: "洋葱表皮", kind: "植物组织", stain: "碘液" },
    { id: "sp-blood", sessionId: "s1", name: "人血涂片", kind: "血液涂片", stain: "瑞氏染色" },
    { id: "sp-para", sessionId: "s1", name: "草履虫", kind: "微生物", stain: "活体观察" },
  ];
  const rounds: Round[] = [
    {
      id: "sp-onion-r1",
      sessionId: "s1",
      sampleId: "sp-onion",
      seq: 1,
      magnification: 100,
      focus: 12,
      status: "confirmed",
      createdBy: "王老师",
      createdAt: now - 3600_000,
      confirmedBy: "王老师",
      confirmedAt: now - 3500_000,
    },
    {
      id: "sp-onion-r2",
      sessionId: "s1",
      sampleId: "sp-onion",
      seq: 2,
      magnification: 400,
      focus: 18.5,
      status: "open",
      createdBy: "王老师",
      createdAt: now - 1800_000,
    },
  ];
  const annotations: Annotation[] = [
    {
      id: "ann-seed-1",
      roundId: "sp-onion-r1",
      author: "小林",
      x: 30,
      y: 35,
      label: "细胞壁",
      length: 18,
      status: "confirmed",
      updatedAt: now - 3550_000,
    },
    {
      id: "ann-seed-2",
      roundId: "sp-onion-r1",
      author: "小林",
      x: 58,
      y: 46,
      label: "细胞核",
      length: 6,
      status: "confirmed",
      updatedAt: now - 3540_000,
    },
    {
      id: "ann-seed-3",
      roundId: "sp-onion-r2",
      author: "小林",
      x: 44,
      y: 62,
      label: "液泡",
      length: 30,
      status: "pending",
      updatedAt: now - 1700_000,
    },
  ];
  const device: DeviceStore = {
    sessions: [session],
    samples,
    rounds,
    annotations,
    sync: { "sp-onion-r1": "synced", "sp-onion-r2": "synced" },
    log: [logLine("已载入示例数据：洋葱表皮 2 个回合")],
  };
  const server: ServerStore = {
    sessions: [{ ...session }],
    samples: samples.map((s) => ({ ...s })),
    rounds: rounds.map((r) => ({ ...r })),
    annotations: annotations.map((a) => ({ ...a })),
    conflicts: [],
    rejected: {},
  };
  return { device, server };
}

/** 自检用：空课堂 + 一个样本，无回合 */
export function emptyStores(): { device: DeviceStore; server: ServerStore } {
  const session: ClassSession = { id: "s1", name: "自检课堂", date: "2026-10-05" };
  const sample: Sample = {
    id: "sp-a",
    sessionId: "s1",
    name: "洋葱表皮",
    kind: "植物组织",
    stain: "碘液",
  };
  return {
    device: {
      sessions: [session],
      samples: [sample],
      rounds: [],
      annotations: [],
      sync: {},
      log: [],
    },
    server: {
      sessions: [{ ...session }],
      samples: [{ ...sample }],
      rounds: [],
      annotations: [],
      conflicts: [],
      rejected: {},
    },
  };
}

export function loadStore<T>(key: string, fallback: () => T): T {
  try {
    if (typeof localStorage === "undefined") return fallback();
    const raw = localStorage.getItem(key);
    if (!raw) return fallback();
    return JSON.parse(raw) as T;
  } catch {
    return fallback();
  }
}

export function saveStore(key: string, value: unknown): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // 存储不可用时静默降级为内存态
  }
}

export function resetStores(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(DEVICE_KEY);
      localStorage.removeItem(SERVER_KEY);
    }
  } catch {
    // ignore
  }
}

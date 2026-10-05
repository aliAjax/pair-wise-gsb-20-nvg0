// 领域模型：课堂 → 样本 → 观察回合 → 标注 的可续作记录链

export type Role = "teacher" | "student";

/** 回合状态：open 可标注；confirmed 老师确认后只读 */
export type RoundStatus = "open" | "confirmed";

/** 本地回合的同步状态：synced 已合并；pending 待同步；failed 合并失败（本地保留） */
export type SyncState = "synced" | "pending" | "failed";

/** 标注状态：pending 待确认；confirmed 已确认；invalid 倍率变化后失效待重算 */
export type AnnotationStatus = "pending" | "confirmed" | "invalid";

export interface ClassSession {
  id: string;
  name: string;
  date: string;
}

export interface Sample {
  id: string;
  sessionId: string;
  name: string;
  kind: string; // 样本类型
  stain: string; // 染色方式
}

export interface Round {
  id: string; // 稳定ID `${sampleId}-r${seq}`，补传不生成副本
  sessionId: string;
  sampleId: string;
  seq: number; // 样本内回合序号
  magnification: number; // 本回合固定倍率
  focus: number; // 本回合固定焦点刻度
  status: RoundStatus;
  createdBy: string;
  createdAt: number;
  confirmedBy?: string;
  confirmedAt?: number;
  allowLateMerge?: boolean; // 老师解锁的补录窗口（服务端）
}

export interface Annotation {
  id: string; // 客户端生成的稳定ID，合并幂等的键
  roundId: string;
  author: string;
  x: number; // 视野坐标 0-100
  y: number;
  label: string; // 结构名称
  length: number; // 测量长度（视野单位，μm 由回合倍率换算）
  status: AnnotationStatus;
  note?: string; // 失效原因 / 重算来源
  updatedAt: number;
}

/** 重叠位置冲突：双方值都保留，交给老师处理 */
export interface ConflictPair {
  id: string;
  roundId: string;
  local: Annotation; // 学生端补画的值
  remote: Annotation; // 服务端已有的值
  createdAt: number;
}

/** 学生设备本地库 */
export interface DeviceStore {
  sessions: ClassSession[];
  samples: Sample[];
  rounds: Round[];
  annotations: Annotation[];
  sync: Record<string, SyncState>; // roundId → 同步状态
  log: string[];
}

/** 课堂共享服务端（本项目中以独立 localStorage 模拟） */
export interface ServerStore {
  sessions: ClassSession[];
  samples: Sample[];
  rounds: Round[];
  annotations: Annotation[];
  conflicts: ConflictPair[];
  rejected: Record<string, string[]>; // roundId → 仲裁落败的标注ID（防止补传复活）
}

/** 重叠判定半径（视野单位） */
export const OVERLAP_RADIUS = 4;

export const MAGNIFICATIONS = [40, 100, 400, 1000];

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 视野单位长度 → μm：100x 下整个视野(100单位) = 1000μm */
export function toUm(length: number, magnification: number): number {
  return (length * 1000) / magnification;
}

export function fmtUm(length: number, magnification: number): string {
  const v = toUm(length, magnification);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} μm`;
}

/** 结构内容是否一致（同位置同内容 → 幂等去重） */
export function sameContent(a: Annotation, b: Annotation): boolean {
  return a.label === b.label && a.length === b.length;
}

/** 完整内容是否一致（含坐标与状态），用于判断"有没有新工作" */
export function sameShape(a: Annotation, b: Annotation): boolean {
  return (
    sameContent(a, b) &&
    a.x === b.x &&
    a.y === b.y &&
    a.status === b.status
  );
}

export function roundLabel(round: Pick<Round, "seq">): string {
  return `第${round.seq}回合`;
}

export function logLine(msg: string): string {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  return `[${time}] ${msg}`;
}

export function withLog<T extends { log: string[] }>(store: T, messages: string[]): T {
  if (messages.length === 0) return store;
  return { ...store, log: [...messages.map(logLine), ...store.log].slice(0, 60) };
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

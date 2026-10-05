export type Role = "teacher" | "student";
export type RoundStatus = "draft" | "confirmed" | "superseded";
export type AnnotationStatus = "valid" | "invalid" | "pending" | "accepted" | "rejected";
export type ConflictStatus = "open" | "resolved";

export interface User {
  id: string;
  name: string;
  role: Role;
}

export interface Sample {
  id: string;
  name: string;
  type: string;
  stain: string;
}

export interface Classroom {
  id: string;
  name: string;
  teacherId: string;
}

export interface Round {
  id: string;
  classroomId: string;
  sampleId: string;
  magnification: number;
  focus: string;
  status: RoundStatus;
  reason: string;
  startedAt: string;
  confirmedAt?: string;
  previousRoundId?: string;
  prevHash: string;
  hash: string;
  confirmationHash?: string;
}

export interface Annotation {
  clientId: string;
  roundId: string;
  x: number;
  y: number;
  coordinateKey: string;
  label: string;
  value: string;
  authorId: string;
  createdAt: string;
  status: AnnotationStatus;
  sourceClientId?: string;
  recalculatedClientId?: string;
  supersededByRound?: string;
  invalidReason?: string;
  note?: string;
}

export interface Conflict {
  id: string;
  roundId: string;
  coordinateKey: string;
  x: number;
  y: number;
  annotationIds: string[];
  status: ConflictStatus;
  winningClientId?: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface OutboxItem {
  clientId: string;
  roundId: string;
  x: number;
  y: number;
  coordinateKey: string;
  label: string;
  value: string;
  authorId: string;
  createdAt: string;
  attempts: number;
  sourceClientId?: string;
  lastError?: string;
}

export interface AppState {
  currentUserId: string;
  online: boolean;
  classroom: Classroom;
  samples: Sample[];
  users: User[];
  rounds: Round[];
  currentRoundId: string;
  selectedRoundId: string;
  annotations: Annotation[];
  pendingAnnotations: Annotation[];
  conflicts: Conflict[];
  outbox: OutboxItem[];
  serverClientIds: Record<string, string[]>;
  failureAfter: number | null;
  lastMessage: string;
}

export interface Runtime {
  id: () => string;
  now: () => string;
}

export interface RoundInput {
  sampleId: string;
  magnification: number;
  focus: string;
  reason: string;
}

export interface AnnotationInput {
  roundId: string;
  x: number;
  y: number;
  label: string;
  value: string;
}

export interface ActionResult {
  state: AppState;
  message: string;
  ok: boolean;
}

export interface MergeResult {
  state: AppState;
  merged: number;
  duplicate: number;
  failed: number;
  message: string;
}

export const coordinateKey = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;

export function shortHash(value: string): string {
  return djb2(value);
}

function djb2(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return `00000000${(hash >>> 0).toString(16)}`.slice(-8);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function message(state: AppState, text: string): ActionResult {
  return { state: { ...state, lastMessage: text }, message: text, ok: true };
}

function failure(state: AppState, text: string): ActionResult {
  return { state: { ...state, lastMessage: text }, message: text, ok: false };
}

export function getUser(state: AppState, userId = state.currentUserId): User {
  return state.users.find((user) => user.id === userId) ?? state.users[0];
}

export function getSample(state: AppState, sampleId: string): Sample | undefined {
  return state.samples.find((sample) => sample.id === sampleId);
}

export function getRound(state: AppState, roundId: string): Round | undefined {
  return state.rounds.find((round) => round.id === roundId);
}

export function getCurrentRound(state: AppState): Round | undefined {
  return getRound(state, state.currentRoundId);
}

export function roundAnnotations(state: AppState, roundId: string): Annotation[] {
  return state.annotations.filter((annotation) => annotation.roundId === roundId);
}

export function roundPending(state: AppState, roundId: string): Annotation[] {
  return state.pendingAnnotations.filter((annotation) => annotation.roundId === roundId);
}

export function roundConflicts(state: AppState, roundId: string): Conflict[] {
  return state.conflicts.filter((conflict) => conflict.roundId === roundId);
}

export function roundOutbox(state: AppState, roundId: string): OutboxItem[] {
  return state.outbox.filter((item) => item.roundId === roundId);
}

export function roundChain(state: AppState, roundId: string): Round[] {
  const byId = new Map(state.rounds.map((round) => [round.id, round]));
  const chain: Round[] = [];
  let current = byId.get(roundId);
  while (current) {
    chain.unshift(current);
    current = current.previousRoundId ? byId.get(current.previousRoundId) : undefined;
  }
  return chain;
}

export function recalculationTarget(state: AppState, oldRound: Round): Round | undefined {
  const byId = new Map(state.rounds.map((round) => [round.id, round]));
  let terminal = oldRound;
  const seen = new Set<string>();

  while (!seen.has(terminal.id)) {
    seen.add(terminal.id);
    const nextRound = state.rounds.find(
      (round) => round.previousRoundId === terminal.id && round.sampleId === oldRound.sampleId
    );
    if (!nextRound) break;
    terminal = nextRound;
  }

  return byId.get(terminal.id)?.status === "draft" ? terminal : undefined;
}

function hasUnprocessedInvalidAncestor(state: AppState, round: Round): boolean {
  if (!round.previousRoundId) return false;
  const byId = new Map(state.rounds.map((item) => [item.id, item]));
  const seen = new Set<string>();
  let current: Round | undefined = byId.get(round.previousRoundId);

  while (current && !seen.has(current.id)) {
    seen.add(current.id);

    if (current.sampleId === round.sampleId) {
      const unprocessed = state.annotations.some(
        (annotation) =>
          annotation.roundId === current.id &&
          annotation.status === "invalid" &&
          !annotation.recalculatedClientId
      );
      if (unprocessed) return true;
    }

    current = current.previousRoundId ? byId.get(current.previousRoundId) : undefined;
  }
  return false;
}

function contextHash(round: Omit<Round, "hash">): string {
  return djb2(
    [
      round.prevHash,
      round.classroomId,
      round.sampleId,
      round.magnification,
      round.focus,
      round.startedAt
    ].join("|")
  );
}

function confirmationHash(round: Round, annotations: Annotation[]): string {
  const annotationDigest = annotations
    .map((item) => [item.clientId, item.x, item.y, item.label, item.value, item.authorId].join(":"))
    .sort()
    .join("|");
  return djb2([round.id, round.hash, "confirmed", annotationDigest].join("|"));
}

function rememberAnnotation(
  state: AppState,
  annotation: Annotation,
  online: boolean
): AppState {
  const next = clone(state);
  if (online) {
    const activeCollection = annotation.status === "pending" ? next.pendingAnnotations : next.annotations;
    if (!activeCollection.some((item) => item.clientId === annotation.clientId)) {
      activeCollection.push(annotation);
    }
    next.serverClientIds[annotation.roundId] ??= [];
    const known = next.serverClientIds[annotation.roundId];
    if (!known.includes(annotation.clientId)) known.push(annotation.clientId);
  } else if (!next.outbox.some((item) => item.clientId === annotation.clientId)) {
    next.outbox.push({
      clientId: annotation.clientId,
      roundId: annotation.roundId,
      x: annotation.x,
      y: annotation.y,
      coordinateKey: annotation.coordinateKey,
      label: annotation.label,
      value: annotation.value,
      authorId: annotation.authorId,
      createdAt: annotation.createdAt,
      attempts: 0,
      sourceClientId: annotation.sourceClientId
    });
  }

  return reconcileConflicts(next, annotation.roundId);
}

function reconcileConflicts(state: AppState, roundId: string): AppState {
  const next = clone(state);
  const active = [
    ...next.annotations.filter(
      (annotation) => annotation.roundId === roundId && ["valid", "accepted"].includes(annotation.status)
    ),
    ...next.pendingAnnotations.filter(
      (annotation) => annotation.roundId === roundId && annotation.status === "pending"
    )
  ];
  const groups = new Map<string, Annotation[]>();
  active.forEach((annotation) => {
    const list = groups.get(annotation.coordinateKey) ?? [];
    list.push(annotation);
    groups.set(annotation.coordinateKey, list);
  });

  for (const [coordinateKeyName, items] of groups) {
    if (items.length < 2) continue;
    const ids = items.map((item) => item.clientId).sort();
    const existing = next.conflicts.find(
      (conflict) =>
        conflict.roundId === roundId &&
        conflict.coordinateKey === coordinateKeyName &&
        conflict.status === "open"
    );
    if (existing) {
      existing.annotationIds = Array.from(new Set([...existing.annotationIds, ...ids])).sort();
      existing.x = items[0].x;
      existing.y = items[0].y;
    } else {
      next.conflicts.push({
        id: `conflict-${ids.join("-")}`,
        roundId,
        coordinateKey: coordinateKeyName,
        x: items[0].x,
        y: items[0].y,
        annotationIds: ids,
        status: "open"
      });
    }
  }

  return next;
}

export function createDemoState(rt: Runtime): AppState {
  const teacher: User = { id: "u-teacher", name: "李老师", role: "teacher" };
  const student: User = { id: "u-student", name: "王同学", role: "student" };
  const classroom: Classroom = {
    id: "room-01",
    name: "显微课堂 A",
    teacherId: teacher.id
  };
  const samples: Sample[] = [
    { id: "s-onion", name: "洋葱表皮", type: "植物组织", stain: "碘液" },
    { id: "s-blood", name: "人血涂片", type: "血液涂片", stain: "瑞氏染色" }
  ];
  const startedAt = rt.now();
  const baseRound: Round = {
    id: "round-001",
    classroomId: classroom.id,
    sampleId: samples[0].id,
    magnification: 100,
    focus: "F1 表层细胞",
    status: "draft",
    reason: "首次观察细胞壁",
    startedAt,
    prevHash: "00000000",
    hash: ""
  };
  baseRound.hash = contextHash(baseRound);
  const annotation: Annotation = {
    clientId: "seed-ann-001",
    roundId: baseRound.id,
    x: 32,
    y: 18,
    coordinateKey: coordinateKey(32, 18),
    label: "细胞壁交点",
    value: "12 μm",
    authorId: student.id,
    createdAt: startedAt,
    status: "valid"
  };

  return {
    currentUserId: student.id,
    online: true,
    classroom,
    samples,
    users: [teacher, student],
    rounds: [baseRound],
    currentRoundId: baseRound.id,
    selectedRoundId: baseRound.id,
    annotations: [annotation],
    pendingAnnotations: [],
    conflicts: [],
    outbox: [],
    serverClientIds: { [baseRound.id]: [annotation.clientId] },
    failureAfter: null,
    lastMessage: "已载入课堂—样本—观察回合—标注续作链。"
  };
}

export function selectRound(state: AppState, roundId: string): AppState {
  if (!getRound(state, roundId)) return state;
  return { ...state, selectedRoundId: roundId, lastMessage: "正在查看该观察回合，历史确认回合保持只读。" };
}

export function useCurrentRound(state: AppState): AppState {
  return { ...state, selectedRoundId: state.currentRoundId };
}

export function startRound(state: AppState, input: RoundInput, rt: Runtime): ActionResult {
  const actor = getUser(state);
  if (actor.role !== "teacher") return failure(state, "只有老师可以更换样本、倍率或焦点并开启新回合。");
  if (!state.online) return failure(state, "当前离线：回合边界由课堂服务创建，恢复网络后再开启新回合。");
  if (!getSample(state, input.sampleId)) return failure(state, "请选择有效样本。");
  if (!Number.isFinite(input.magnification) || input.magnification <= 0) {
    return failure(state, "倍率必须是大于 0 的数字。");
  }

  const previous = getRound(state, state.currentRoundId);
  if (
    previous &&
    previous.sampleId === input.sampleId &&
    previous.magnification === input.magnification &&
    previous.focus.trim() === input.focus.trim()
  ) {
    return failure(state, "样本、倍率和焦点均未变化，继续使用当前回合即可。");
  }

  const next = clone(state);
  const startedAt = rt.now();
  const draft: Round = {
    id: rt.id(),
    classroomId: state.classroom.id,
    sampleId: input.sampleId,
    magnification: input.magnification,
    focus: input.focus.trim(),
    status: "draft",
    reason: input.reason.trim() || "老师调整观察条件",
    startedAt,
    previousRoundId: previous?.id,
    prevHash: previous?.hash ?? "00000000",
    hash: ""
  };
  draft.hash = contextHash(draft);
  next.rounds.push(draft);

  let changed = false;
  if (previous && previous.status === "draft" && previous.sampleId === input.sampleId && previous.magnification !== input.magnification) {
    const previousDraft = next.rounds.find((item) => item.id === previous.id);
    if (previousDraft) previousDraft.status = "superseded";
    next.annotations.forEach((annotation) => {
      if (annotation.roundId === previous.id && annotation.status === "valid") {
        annotation.status = "invalid";
        annotation.supersededByRound = draft.id;
        changed = true;
      }
    });
  }

  next.currentRoundId = draft.id;
  next.selectedRoundId = draft.id;
  next.serverClientIds[draft.id] ??= [];
  next.lastMessage = changed
    ? "倍率已变化：上一未确认回合的有效标注已失效，可按倍率重算到新回合。"
    : "新观察回合已开启；样本、倍率和焦点在本回合固定，旧标注仍保留在原回合。";
  return { state: next, message: next.lastMessage, ok: true };
}

export function addAnnotation(state: AppState, input: AnnotationInput, rt: Runtime): ActionResult {
  const actor = getUser(state);
  const round = getRound(state, input.roundId);
  if (!round) return failure(state, "目标观察回合不存在。");
  if (state.selectedRoundId !== state.currentRoundId && input.roundId !== state.currentRoundId) {
    return failure(state, "历史回合只用于追溯，不能补画；请切回当前回合。");
  }
  if (round.status === "confirmed") return failure(state, "老师已确认，该回合只读；请等待老师开启续作回合。");
  if (round.status === "superseded") return failure(state, "倍率已变化，该旧回合已失效；请在当前倍率回合重算标注。");
  if (round.id !== state.currentRoundId) return failure(state, "只能在当前未确认回合中标注。");
  const x = Math.round(input.x);
  const y = Math.round(input.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return failure(state, "坐标必须是数字。");
  if (!input.label.trim()) return failure(state, "请填写结构名称。");

  const annotation: Annotation = {
    clientId: rt.id(),
    roundId: round.id,
    x,
    y,
    coordinateKey: coordinateKey(x, y),
    label: input.label.trim(),
    value: input.value.trim() || "待测量",
    authorId: actor.id,
    createdAt: rt.now(),
    status: "valid"
  };
  const next = rememberAnnotation(state, annotation, state.online);
  const duplicatedCoordinate = roundAnnotations(next, round.id).some(
    (item) => item.coordinateKey === annotation.coordinateKey && item.clientId !== annotation.clientId
  );
  next.lastMessage = state.online
    ? duplicatedCoordinate
      ? "坐标已提交；与已有值重叠，双方值均保留，等待老师裁定。"
      : "坐标已实时写入当前回合。"
    : "离线标注已保存到本地待传队列，回连后按同一回合逐坐标合并。";
  return { state: next, message: next.lastMessage, ok: true };
}

export function confirmRound(state: AppState, roundId: string, rt: Runtime): ActionResult {
  const actor = getUser(state);
  if (actor.role !== "teacher") return failure(state, "只有老师可以确认观察回合。");
  const round = getRound(state, roundId);
  if (!round) return failure(state, "观察回合不存在。");
  if (round.status !== "draft") return failure(state, "该回合不是未确认草稿，不能再次确认。");
  if (roundOutbox(state, roundId).length > 0) {
    return failure(state, "仍有学生离线标注尚未合并，不能确认；请先等待回连同步。");
  }
  const invalid = roundAnnotations(state, roundId).filter(
    (item) => item.status === "invalid" && !item.recalculatedClientId && !item.invalidReason
  );
  if (invalid.length > 0) return failure(state, "存在倍率变化后的失效标注，请先重算或弃用后再确认。");
  if (hasUnprocessedInvalidAncestor(state, round)) {
    return failure(state, "倍率链上仍有失效标注未重算，不能把新倍率回合作为测量依据确认。");
  }
  if (roundConflicts(state, roundId).some((conflict) => conflict.status === "open")) {
    return failure(state, "存在重叠坐标冲突，老师裁定后才能确认。");
  }
  const annotations = roundAnnotations(state, roundId);
  if (annotations.length === 0) return failure(state, "空回合无需确认；请先完成至少一个标注。");

  const next = clone(state);
  const target = next.rounds.find((item) => item.id === roundId);
  if (!target) return failure(state, "观察回合不存在。");
  const confirmedAt = rt.now();
  target.status = "confirmed";
  target.confirmedAt = confirmedAt;
  target.confirmationHash = confirmationHash(target, annotations);
  next.lastMessage = "回合已确认并锁定，上下文哈希和确认哈希均已写入记录链。";
  return { state: next, message: next.lastMessage, ok: true };
}

export function recalculateAnnotation(state: AppState, clientId: string, rt: Runtime): ActionResult {
  const actor = getUser(state);
  const old = state.annotations.find((item) => item.clientId === clientId);
  if (!old) return failure(state, "失效标注不存在。");
  if (old.status !== "invalid") return failure(state, "只有失效标注需要重算。");
  const oldRound = getRound(state, old.roundId);
  if (!oldRound) return failure(state, "原观察回合不存在。");
  const successor = recalculationTarget(state, oldRound);
  if (!successor) return failure(state, "未找到同一样本的最新未确认倍率续作回合。");
  const duplicated =
    state.annotations.some(
      (item) => item.roundId === successor.id && item.sourceClientId === old.clientId
    ) || state.outbox.some((item) => item.roundId === successor.id && item.sourceClientId === old.clientId);
  if (duplicated) return failure(state, "该坐标已经重算，重复操作不会生成副本。");

  const ratio = successor.magnification / oldRound.magnification;
  const x = Math.round(old.x * ratio);
  const y = Math.round(old.y * ratio);
  const recalculated: Annotation = {
    clientId: rt.id(),
    roundId: successor.id,
    x,
    y,
    coordinateKey: coordinateKey(x, y),
    label: old.label,
    value: old.value,
    authorId: old.authorId,
    createdAt: rt.now(),
    status: "valid",
    sourceClientId: old.clientId,
    note: `坐标由 ${oldRound.magnification}× 到 ${successor.magnification}× 换算；测量值沿用原物理量。`
  };
  const next = rememberAnnotation(state, recalculated, state.online);
  const original = next.annotations.find((item) => item.clientId === old.clientId);
  if (original) {
    original.recalculatedClientId = recalculated.clientId;
    original.note = state.online ? original.note : "重算结果离线待传，回连后按源标注去重。";
  }
  next.lastMessage = `已重算到 ${successor.id} 的 (${x}, ${y})；同一回合重复补传不会产生副本。`;
  return { state: next, message: next.lastMessage, ok: true };
}

export function resolveConflict(
  state: AppState,
  conflictId: string,
  winningClientId: string,
  rt: Runtime
): ActionResult {
  const actor = getUser(state);
  if (actor.role !== "teacher") return failure(state, "只有老师可以裁定重叠坐标。");
  const conflict = state.conflicts.find((item) => item.id === conflictId && item.status === "open");
  if (!conflict) return failure(state, "没有待裁定的冲突。");
  if (!conflict.annotationIds.includes(winningClientId)) return failure(state, "请选择冲突中的一个标注值。");

  const next = clone(state);
  const targetConflict = next.conflicts.find((item) => item.id === conflictId);
  if (!targetConflict) return failure(state, "冲突不存在。");
  const round = next.rounds.find((item) => item.id === conflict.roundId);
  const related = [
    ...next.annotations.filter((item) => targetConflict.annotationIds.includes(item.clientId)),
    ...next.pendingAnnotations.filter((item) => targetConflict.annotationIds.includes(item.clientId))
  ];

  related.forEach((annotation) => {
    if (annotation.clientId === winningClientId) {
      if (round?.status === "confirmed" && state.pendingAnnotations.some((item) => item.clientId === annotation.clientId)) {
        annotation.status = "accepted";
      } else if (annotation.status === "pending") {
        annotation.status = "valid";
      }
    } else if (round?.status === "confirmed") {
      if (state.pendingAnnotations.some((item) => item.clientId === annotation.clientId)) {
        annotation.status = "rejected";
      }
    } else {
      annotation.status = "invalid";
      annotation.invalidReason = "老师在重叠坐标冲突中选择了另一方值";
    }
  });

  next.pendingAnnotations.forEach((annotation) => {
    if (annotation.status === "accepted" || annotation.status === "rejected") {
      if (!next.annotations.some((item) => item.clientId === annotation.clientId)) {
        next.annotations.push(annotation);
      }
    }
  });
  next.pendingAnnotations = next.pendingAnnotations.filter((annotation) => annotation.status === "pending");

  targetConflict.status = "resolved";
  targetConflict.winningClientId = winningClientId;
  targetConflict.resolvedBy = actor.id;
  targetConflict.resolvedAt = rt.now();
  next.lastMessage = "冲突已裁定；未选值仍保留审计痕迹，确认回合不会被普通学生操作改写。";
  return { state: next, message: next.lastMessage, ok: true };
}

export function reviewPendingAnnotation(
  state: AppState,
  clientId: string,
  decision: "accepted" | "rejected",
  rt: Runtime
): ActionResult {
  const actor = getUser(state);
  if (actor.role !== "teacher") return failure(state, "只有老师可以复审确认回合后的补画。");
  const pending = state.pendingAnnotations.find((item) => item.clientId === clientId && item.status === "pending");
  if (!pending) return failure(state, "没有待复审的补画。");
  const round = getRound(state, pending.roundId);
  if (round?.status !== "confirmed") return failure(state, "只有确认回合后的补画需要复审。");

  const next = clone(state);
  const target = next.pendingAnnotations.find((item) => item.clientId === clientId);
  if (!target) return failure(state, "补画不存在。");
  target.status = decision;
  target.note = decision === "accepted"
    ? `${target.note ?? ""} 老师已于 ${rt.now()} 接受`.trim()
    : `${target.note ?? ""} 老师已于 ${rt.now()} 拒绝`.trim();
  next.annotations.push(target);
  next.pendingAnnotations = next.pendingAnnotations.filter((item) => item.clientId !== clientId);
  next.lastMessage = decision === "accepted"
    ? "补画已作为确认回合的审计补充接受，原确认哈希不变。"
    : "补画已拒绝并保留审计痕迹，不参与测量依据。";
  return { state: next, message: next.lastMessage, ok: true };
}

export function mergeOutbox(state: AppState, rt: Runtime): MergeResult {
  if (!state.online) {
    return { state, merged: 0, duplicate: 0, failed: state.outbox.length, message: "仍处于离线状态，本地回合和待传坐标已保留。" };
  }
  if (state.outbox.length === 0) {
    return { state: { ...state, lastMessage: "待传队列为空。" }, merged: 0, duplicate: 0, failed: 0, message: "待传队列为空。" };
  }

  let next = clone(state);
  const ordered = [...next.outbox].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let merged = 0;
  let duplicate = 0;
  let failureReason = "";

  for (const queued of ordered) {
    queued.attempts += 1;
    const round = next.rounds.find((item) => item.id === queued.roundId);
    if (!round) {
      queued.lastError = "回合缺失，合并已停止并保留本地队列";
      failureReason = queued.lastError;
      break;
    }

    const known = next.serverClientIds[queued.roundId] ?? [];
    const alreadyThere =
      known.includes(queued.clientId) ||
      [...next.annotations, ...next.pendingAnnotations].some(
        (item) => item.roundId === queued.roundId && item.clientId === queued.clientId
      );

    if (alreadyThere) {
      duplicate += 1;
      next.outbox = next.outbox.filter((item) => item.clientId !== queued.clientId);
      continue;
    }

    if (next.failureAfter !== null && merged >= next.failureAfter) {
      queued.lastError = "模拟网络中断：未确认坐标仍保留在本地，恢复后只补缺传坐标。";
      failureReason = queued.lastError;
      break;
    }

    const received: Annotation = {
      clientId: queued.clientId,
      roundId: queued.roundId,
      x: queued.x,
      y: queued.y,
      coordinateKey: queued.coordinateKey,
      label: queued.label,
      value: queued.value,
      authorId: queued.authorId,
      createdAt: queued.createdAt,
      sourceClientId: queued.sourceClientId,
      status: round.status === "confirmed" ? "pending" : "valid",
      note: round.status === "confirmed" ? "确认后的离线补画，先交老师复审" : undefined
    };

    if (received.status === "pending") next.pendingAnnotations.push(received);
    else next.annotations.push(received);
    next.serverClientIds[queued.roundId] ??= [];
    next.serverClientIds[queued.roundId].push(received.clientId);
    next.outbox = next.outbox.filter((item) => item.clientId !== queued.clientId);
    next = reconcileConflicts(next, queued.roundId);
    merged += 1;
  }

  const message = failureReason
    ? `${failureReason} 已合并 ${merged} 条、去重 ${duplicate} 条，剩余 ${next.outbox.length} 条。`
    : `回连合并完成：新增 ${merged} 条，幂等去重 ${duplicate} 条；重叠坐标均保留双方值。`;
  next.lastMessage = message;
  return { state: next, merged, duplicate, failed: next.outbox.length, message };
}

export function setOnline(state: AppState, online: boolean): AppState {
  return {
    ...state,
    online,
    lastMessage: online ? "网络已恢复，可逐坐标合并本地待传标注。" : "已进入离线模式：标注只保存在本地队列。"
  };
}

export function setCurrentUser(state: AppState, userId: string): AppState {
  if (!state.users.some((user) => user.id === userId)) return state;
  const user = getUser({ ...state, currentUserId: userId });
  return { ...state, currentUserId: userId, lastMessage: `当前身份：${user.name}（${user.role === "teacher" ? "老师" : "学生"}）` };
}

export function setFailureAfter(state: AppState, value: number | null): AppState {
  return { ...state, failureAfter: value, lastMessage: value === null ? "已关闭合并失败模拟。" : `将在成功处理 ${value} 条后模拟中断。` };
}

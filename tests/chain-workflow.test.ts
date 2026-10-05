import assert from "node:assert/strict";
import {
  addAnnotation,
  confirmRound,
  coordinateKey,
  createDemoState,
  mergeOutbox,
  recalculateAnnotation,
  reviewPendingAnnotation,
  resolveConflict,
  setCurrentUser,
  setFailureAfter,
  setOnline,
  startRound,
  type Runtime
} from "../src/chain.ts";

let counter = 0;
const rt: Runtime = {
  id: () => `id-${++counter}`,
  now: () => new Date(2026, 9, 5, 9, 0, counter).toISOString()
};

let state = createDemoState(rt);
const teacher = state.users[0].id;
const student = state.users[1].id;
const firstRound = state.currentRoundId;

// 倍率变化：未确认旧标注失效，旧回合锁定为 superseded。
state = setCurrentUser(state, teacher);
state = startRound(
  state,
  { sampleId: state.samples[0].id, magnification: 400, focus: "F1 表层细胞", reason: "换物镜" },
  rt
).state;
const secondRound = state.currentRoundId;
assert.notEqual(secondRound, firstRound);
assert.equal(state.rounds.find((round) => round.id === firstRound)?.status, "superseded");
assert.equal(state.annotations[0].status, "invalid");

// 学生按倍率重算坐标（100x -> 400x，坐标乘 4）。
state = setCurrentUser(state, student);
state = recalculateAnnotation(state, state.annotations[0].clientId, rt).state;
const recalculated = state.annotations.find((item) => item.sourceClientId === state.annotations[0].clientId);
assert.ok(recalculated);
assert.equal(recalculated.x, 128);
assert.equal(recalculated.y, 72);
assert.equal(recalculateAnnotation(state, state.annotations[0].clientId, rt).ok, false);

// 同坐标不同值：双方值保留并形成待老师处理冲突。
state = addAnnotation(state, { roundId: secondRound, x: 20, y: 20, label: "细胞核", value: "7 μm" }, rt).state;
state = setCurrentUser(state, teacher);
state = addAnnotation(state, { roundId: secondRound, x: 20, y: 20, label: "细胞核", value: "8 μm" }, rt).state;
let conflict = state.conflicts.find((item) => item.coordinateKey === coordinateKey(20, 20) && item.status === "open");
assert.ok(conflict);
assert.equal(conflict.annotationIds.length, 2);
assert.equal(confirmRound(state, secondRound, rt).ok, false);
state = resolveConflict(state, conflict.id, conflict.annotationIds[0], rt).state;
assert.equal(state.conflicts.find((item) => item.id === conflict.id)?.status, "resolved");

// 合并失败：本地回合和未传坐标保留，恢复后只补缺，不产生副本。
state = setCurrentUser(state, student);
state = setOnline(state, false);
state = addAnnotation(state, { roundId: secondRound, x: 35, y: 45, label: "待传结构", value: "2 μm" }, rt).state;
const offlineId = state.outbox[0].clientId;
state = setOnline(state, true);
state = setFailureAfter(state, 0);
state = mergeOutbox(state, rt).state;
assert.equal(state.outbox.length, 1);
assert.equal(state.annotations.some((item) => item.clientId === offlineId), false);
state = setFailureAfter(state, null);
state = mergeOutbox(state, rt).state;
assert.equal(state.outbox.length, 0);
assert.equal(state.annotations.filter((item) => item.clientId === offlineId).length, 1);

// 老师确认成功；确认后学生不能再直接写入。
state = setCurrentUser(state, teacher);
state = confirmRound(state, secondRound, rt).state;
assert.equal(state.rounds.find((round) => round.id === secondRound)?.status, "confirmed");
assert.ok(state.rounds.find((round) => round.id === secondRound)?.confirmationHash);
state = setCurrentUser(state, student);
assert.equal(addAnnotation(state, { roundId: secondRound, x: 99, y: 99, label: "x", value: "1" }, rt).ok, false);

// 另一台学生设备在确认前已离线产生补画，回连后进入补充复审，不覆盖只读回合。
const queuedId = "late-device-annotation";
state = {
  ...state,
  online: true,
  outbox: [
    {
      clientId: queuedId,
      roundId: secondRound,
      x: 30,
      y: 40,
      coordinateKey: coordinateKey(30, 40),
      label: "补充结构",
      value: "3 μm",
      authorId: student,
      createdAt: new Date().toISOString(),
      attempts: 1
    }
  ]
};
state = mergeOutbox(state, rt).state;
assert.equal(state.outbox.length, 0);
assert.equal(state.pendingAnnotations.filter((item) => item.roundId === secondRound).length, 1);
assert.equal(mergeOutbox(state, rt).merged, 0);

// 老师接受确认后的补画；补画作为审计补充，不改变原确认哈希。
state = setCurrentUser(state, teacher);
state = reviewPendingAnnotation(state, queuedId, "accepted", rt).state;
assert.equal(state.annotations.some((item) => item.clientId === queuedId && item.status === "accepted"), true);
assert.equal(state.pendingAnnotations.length, 0);

console.log("chain workflow assertions passed");

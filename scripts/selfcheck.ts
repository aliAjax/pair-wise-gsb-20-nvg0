// 记录链逻辑自检：npm run selfcheck
// 覆盖：失效重算、确认只读、离线合并、重叠冲突双方留值、合并失败保留本地、补缺幂等

import { emptyStores, seedStores } from "../src/lib/store";
import * as chain from "../src/lib/chain";
import * as sync from "../src/lib/sync";
import { DeviceStore, ServerStore } from "../src/lib/types";

declare const process: { exit(code: number): void };

let T = 1_000_000;
const t = () => (T += 1000);

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) {
    passed += 1;
    console.log("  ✓ " + name);
  } else {
    failures.push(name);
    console.error("  ✗ " + name);
  }
}

function uniqueIds(store: ServerStore | DeviceStore): boolean {
  const ids = store.annotations.map((a) => a.id);
  return new Set(ids).size === ids.length;
}

// S0 种子数据一致性
console.log("S0 种子数据");
{
  const { device, server } = seedStores();
  const roundIds = new Set(device.rounds.map((r) => r.id));
  check("设备端标注都挂在存在的回合上", device.annotations.every((a) => roundIds.has(a.roundId)));
  check("服务端与设备端回合数一致", server.rounds.length === device.rounds.length);
  check("种子回合均已同步", Object.values(device.sync).every((s) => s === "synced"));
}

// S1 记录链：倍率变化 → 未确认标注失效 → 重算
console.log("S1 倍率变化失效与重算");
{
  let { device } = emptyStores();
  const r1 = chain.openRound(device, { sampleId: "sp-a", magnification: 100, focus: 12, author: "王老师" }, t());
  device = r1.store;
  const a1 = chain.addAnnotation(device, { roundId: r1.round.id, author: "小林", x: 30, y: 30, label: "细胞壁", length: 20 }, t());
  device = chain.confirmRound(a1.store, r1.round.id, "王老师", t());
  check("老师确认后回合只读", device.rounds[0].status === "confirmed");
  check("确认后标注为已确认", device.annotations[0].status === "confirmed");

  let threw = false;
  try {
    chain.addAnnotation(device, { roundId: r1.round.id, author: "小林", x: 1, y: 1, label: "x", length: 1 }, t());
  } catch {
    threw = true;
  }
  check("只读回合拒绝新标注", threw);

  const r2 = chain.openRound(device, { sampleId: "sp-a", magnification: 400, focus: 18, author: "王老师" }, t());
  device = r2.store;
  check("已确认标注不受倍率变化影响", r2.invalidated === 0);
  const a2 = chain.addAnnotation(device, { roundId: r2.round.id, author: "小林", x: 40, y: 40, label: "液泡", length: 10 }, t());
  device = a2.store;

  const r3 = chain.openRound(device, { sampleId: "sp-a", magnification: 1000, focus: 22, author: "王老师" }, t());
  device = r3.store;
  check("倍率变化使未确认标注失效", r3.invalidated === 1);
  const invalid = device.annotations.find((a) => a.id === a2.annotation.id);
  check("失效标注注明倍率变化原因", !!invalid && invalid.status === "invalid" && (invalid.note ?? "").includes("400x → 1000x"));

  const recalc = chain.recalcAnnotation(device, a2.annotation.id, r3.round.id, "小林", t());
  device = recalc.store;
  check("重算标注落入新回合", recalc.annotation.roundId === r3.round.id);
  check("重算长度按倍率比换算", recalc.annotation.length === 25); // 10 * 1000/400
  check("重算后重新待确认", recalc.annotation.status === "pending");
}

// S2 幂等补传：同一回合重复推送不生成副本
console.log("S2 幂等补传");
{
  let { device, server } = emptyStores();
  const r1 = chain.openRound(device, { sampleId: "sp-a", magnification: 100, focus: 12, author: "王老师" }, t());
  device = chain.addAnnotation(r1.store, { roundId: r1.round.id, author: "小林", x: 10, y: 10, label: "细胞核", length: 5 }, t()).store;
  let res = sync.syncDevice(device, server, true);
  device = res.device; server = res.server;
  const countAfterFirst = server.annotations.length;
  check("首次同步落库", countAfterFirst === 1);

  res = sync.syncDevice(device, server, true);
  device = res.device; server = res.server;
  check("重复同步不生成副本", server.annotations.length === countAfterFirst && uniqueIds(server));
  check("服务端回合不重复", server.rounds.filter((r) => r.id === r1.round.id).length === 1);
}

// S3 离线补画 + 他端同坐标 → 回连合并 → 重叠位置留双方值 → 老师仲裁
console.log("S3 重叠冲突双方留值");
{
  let { device, server } = emptyStores();
  const r1 = chain.openRound(device, { sampleId: "sp-a", magnification: 400, focus: 15, author: "王老师" }, t());
  device = r1.store;
  let res = sync.syncDevice(device, server, true); // 回合先上服务端
  device = res.device; server = res.server;

  // 断网补画
  device = chain.addAnnotation(device, { roundId: r1.round.id, author: "小林", x: 50, y: 50, label: "线粒体", length: 10 }, t()).store;
  // 他端在相近坐标落了不同值并已同步
  server = sync.serverInjectAnnotation(server, { roundId: r1.round.id, author: "邻桌设备", x: 51, y: 50, label: "叶绿体", length: 8 }, t()).server;

  res = sync.syncDevice(device, server, true); // 回连合并
  device = res.device; server = res.server;
  check("重叠位置产生冲突", server.conflicts.length === 1);
  const c = server.conflicts[0];
  check("冲突保留双方值", c.local.label === "线粒体" && c.remote.label === "叶绿体");
  check("冲突未决前本地值不直接落库", server.annotations.every((a) => a.label !== "线粒体"));

  server = sync.resolveConflict(server, c.id, "local");
  device = sync.pullDevice(device, server);
  check("老师采用本地后本地值落库", server.annotations.some((a) => a.label === "线粒体"));
  check("落败远端值被移除", server.annotations.every((a) => a.label !== "叶绿体"));
  check("冲突已清零", server.conflicts.length === 0);

  // 落败方补传不复活
  const ghost = { ...c.remote, updatedAt: t() };
  const pushed = sync.pushRoundToServer(server, device.rounds[0], [...device.annotations, ghost]);
  check("落败值补传被幂等拒绝", pushed.server.annotations.every((a) => a.label !== "叶绿体"));
}

// S4 合并失败保留本地 → 解锁补录 → 补缺坐标 → 不生成副本
console.log("S4 合并失败与恢复补缺");
{
  let { device, server } = emptyStores();
  const r1 = chain.openRound(device, { sampleId: "sp-a", magnification: 100, focus: 12, author: "王老师" }, t());
  device = r1.store;
  let res = sync.syncDevice(device, server, true);
  device = res.device; server = res.server;

  // 学生离线补画期间，老师在他端确认了回合
  const a4 = chain.addAnnotation(device, { roundId: r1.round.id, author: "小林", x: 60, y: 60, label: "细胞壁", length: 12 }, t());
  device = a4.store;
  server = sync.serverConfirmRound(server, r1.round.id, "王老师", t());

  res = sync.syncDevice(device, server, true);
  device = res.device; server = res.server;
  check("只读回合合并失败", device.sync[r1.round.id] === "failed");
  check("本地回合与标注保留", device.annotations.some((a) => a.id === a4.annotation.id));
  check("服务端未接收失败标注", server.annotations.every((a) => a.id !== a4.annotation.id));

  server = sync.serverUnlockLateMerge(server, r1.round.id);
  res = sync.syncDevice(device, server, true);
  device = res.device; server = res.server;
  check("解锁后补缺坐标成功", server.annotations.some((a) => a.id === a4.annotation.id));
  check("补录窗口用后重新锁定", !server.rounds.find((r) => r.id === r1.round.id)?.allowLateMerge);
  check("回合同步状态恢复", device.sync[r1.round.id] === "synced");

  const count = server.annotations.length;
  res = sync.syncDevice(device, server, true);
  server = res.server;
  check("恢复后补传不生成副本", server.annotations.length === count && uniqueIds(server));
}

// S5 逐坐标补缺：服务端已有 A，本地补 B，合并后各一份
console.log("S5 逐坐标补缺");
{
  let { device, server } = emptyStores();
  const r1 = chain.openRound(device, { sampleId: "sp-a", magnification: 100, focus: 12, author: "王老师" }, t());
  device = chain.addAnnotation(r1.store, { roundId: r1.round.id, author: "小林", x: 20, y: 20, label: "A", length: 5 }, t()).store;
  let res = sync.syncDevice(device, server, true);
  device = res.device; server = res.server;
  device = chain.addAnnotation(device, { roundId: r1.round.id, author: "小林", x: 80, y: 80, label: "B", length: 6 }, t()).store;
  res = sync.syncDevice(device, server, true);
  server = res.server;
  const labels = server.annotations.map((a) => a.label).sort();
  check("补缺后 A、B 各一份", labels.join(",") === "A,B" && uniqueIds(server));
}

console.log(`\n${passed} 项通过，${failures.length} 项失败`);
if (failures.length > 0) {
  console.error("失败项：\n - " + failures.join("\n - "));
  process.exit(1);
}

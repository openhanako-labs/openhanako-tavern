// regression-env-line.mjs — 环境行：从状态栏里认出时间 / 地点 / 天候
//
// 这条守住的是「宁可没有，也不写假的」：认不出来就返回空，
// 调用方据此不渲染那一行。
import { envFromStatus, envText } from "../ui/assets/modules/env-line.js";

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  if (got === want) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}\n      得到: ${JSON.stringify(got)}\n      期望: ${JSON.stringify(want)}`);
  }
}

console.log("=== 环境行 ===");

// 1. 典型三字段
eq(
  "三字段都能认出",
  envText(envFromStatus("张力: 5\n物理位置: 哨塔顶层\n当前时间: 深夜\n天候: 风雪")),
  "哨塔顶层 · 深夜 · 风雪"
);

// 2. 显示顺序固定，不跟书写顺序走
eq(
  "顺序固定为 地点·时间·天候",
  envText(envFromStatus("天候: 风雪\n当前时间: 深夜\n地点: 哨塔顶层")),
  "哨塔顶层 · 深夜 · 风雪"
);

// 3. 值和箭头：环境行要的是「现在」
eq(
  "取箭头右边的当前值",
  envText(envFromStatus("地点: 门厅 → 哨塔顶层")),
  "哨塔顶层"
);

// 4. 只有一项时不拖分隔符
eq("单项不带分隔符", envText(envFromStatus("地点: 哨塔顶层")), "哨塔顶层");

// 5. 认不出来就是空——不猜
eq("没有环境字段 → 空", envText(envFromStatus("张力: 5\n戒备: true\n灯油: 4 小时")), "");
eq("空输入 → 空", envText(envFromStatus("")), "");
eq("null → 空", envText(envFromStatus(null)), "");

// 6. 没有冒号的行不进（状态栏的判据本身就是键: 值）
eq(
  "无冒号的行被忽略",
  envText(envFromStatus("他站在哨塔顶层\n地点: 哨塔顶层")),
  "哨塔顶层"
);

// 7. 全角冒号
eq("全角冒号", envText(envFromStatus("地点：哨塔顶层")), "哨塔顶层");

// 8. 星号包裹的键（**任务面板:** {} 这种写法）
eq(
  "星号被剥掉",
  envText(envFromStatus("**地点:** 哨塔顶层")),
  "哨塔顶层"
);
eq(
  "空值不产生环境项",
  envText(envFromStatus("**任务面板:** {}")),
  ""
);

// 9. 同一字段出现多个键，只取第一个
eq(
  "同字段只取首次出现",
  envText(envFromStatus("地点: 门厅\n物理位置: 哨塔顶层")),
  "门厅"
);

// 10. 键名有一堆变体都该认
eq("认「当前位置」", envText(envFromStatus("当前位置: 走廊")), "走廊");
eq("认「场所」", envText(envFromStatus("场所: 地窖")), "地窖");
eq("认「时刻」", envText(envFromStatus("时刻: 黄昏")), "黄昏");
eq("认「天气」", envText(envFromStatus("天气: 小雨")), "小雨");

// 11. kind 字段对得上（调用方可能按 kind 上样式）
{
  const env = envFromStatus("时间: 深夜\n地点: 哨塔顶层");
  const kinds = env.map((e) => e.kind).join(",");
  eq("kind 顺序正确", kinds, "place,time");
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

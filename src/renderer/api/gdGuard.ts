/**
 * GD 音乐台上游（music-api.gdstudio.xyz）全局节流守护。
 *
 * 背景：该上游在 Cloudflare 后，按 IP + 请求速率激进限流 —— 实测 10 连发
 * search 请求约 70% 返回 503，随后进入一段难恢复的封禁窗口；url 端点相对
 * 宽松但也会零星 503，且能立即恢复。解析器在歌单批量播放时是突发请求，
 * 原本无任何节流/退避，正是"有歌一直放不出来"的根因之一。
 *
 * 本模块让所有走该上游的源（gdmusic、pyncmd）共享一把全局闸：
 *  - 限制并发数 + 最小请求间隔（打散突发）；
 *  - 观测到 503 后进入短暂全局冷却（对相同 IP 的后续请求继续触发 503，
 *    冷却比继续打更划算）；
 *  - 单次 503 返回 null，由调用方视为"该源本轮失败、降级下一个源"。
 *
 * Web PWA 没有主进程桥，浏览器直接 fetch 该上游（其下发 access-control-allow-origin:*，
 * 无 CORS 限制）；这里刻意不携带浏览器 UA，降低 Cloudflare 误判为爬虫的概率。
 */
import axios from 'axios';

const MIN_INTERVAL_MS = 350; // 同上游相邻请求最小间隔
const MAX_CONCURRENCY = 2; // 同上游最大并发
const COOLDOWN_MS = 1800; // 观测到 503 后的全局冷却时长
const MAX_FAILED_STREAK = 2; // 连续失败次数，超过则本地暂停更长

let inFlight = 0;
let lastStartedAt = 0;
let cooldownUntil = 0;
let failedStreak = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等上游可用（并发闸 + 间隔闸 + 503 冷却） */
const acquire = async (): Promise<void> => {
  for (;;) {
    const now = Date.now();
    if (cooldownUntil > now) {
      await sleep(Math.min(cooldownUntil - now, 500));
      continue;
    }
    const nextSlot = Math.max(lastStartedAt + MIN_INTERVAL_MS, now);
    if (inFlight < MAX_CONCURRENCY && nextSlot <= now) return;
    await sleep(Math.max(nextSlot - now, 60));
  }
};

export interface GdGuardResult {
  ok: boolean;
  /** 直链 URL（未命中时为空串/undefined） */
  url?: string;
  /** 码率（bps；0/undefined 表示无有效源） */
  br?: number;
  size?: number;
}

const empty = (): GdGuardResult => ({ ok: false });

/**
 * 经由全局闸请求 GD 上游。返回统一形状；503/网络错误/空结果均收敛为
 * { ok:false }，调用方不应再区分具体失败原因。
 */
export const gdGuardGetRaw = async (url: string, timeout = 8000): Promise<unknown | null> => {
  await acquire();
  inFlight += 1;
  const startedAt = Date.now();
  lastStartedAt = startedAt;
  try {
    let resp: any;
    try {
      resp = await axios.get(url, { timeout, headers: {} });
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 503 || (err instanceof Error && /503/i.test(err.message))) {
        cooldownUntil = Math.max(cooldownUntil, startedAt + COOLDOWN_MS);
        failedStreak += 1;
      } else {
        failedStreak += 1;
      }
      if (failedStreak >= MAX_FAILED_STREAK) {
        cooldownUntil = Math.max(cooldownUntil, startedAt + COOLDOWN_MS * 3);
      }
      return null;
    }
    failedStreak = 0;
    return resp?.data ?? null;
  } finally {
    inFlight -= 1;
    if (inFlight < 0) inFlight = 0;
  }
};

export const gdGuardGet = async (url: string, timeout = 8000): Promise<GdGuardResult> => {
  await acquire();
  inFlight += 1;
  const startedAt = Date.now();
  lastStartedAt = startedAt;
  try {
    let resp: any;
    try {
      resp = await axios.get(url, { timeout, headers: {} });
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 503 || (err instanceof Error && /503/i.test(err.message))) {
        cooldownUntil = Math.max(cooldownUntil, startedAt + COOLDOWN_MS);
        failedStreak += 1;
      } else {
        failedStreak += 1;
      }
      if (failedStreak >= MAX_FAILED_STREAK) {
        // 连续失败再延一段冷却，避免在封禁窗口内空转
        cooldownUntil = Math.max(cooldownUntil, startedAt + COOLDOWN_MS * 3);
      }
      return empty();
    }
    failedStreak = 0;
    const data = resp?.data;
    if (!data || typeof data !== 'object') return empty();
    const urlValue: unknown = (data as Record<string, any>).url;
    const brValue: unknown = (data as Record<string, any>).br;
    // 未命中形态：{ url:"", br:0, size:0, from:"music.gdstudio.xyz" }
    if (typeof urlValue !== 'string' || urlValue.length === 0) return empty();
    const br =
      typeof brValue === 'number' && brValue > 0 ? brValue : (data as Record<string, any>).br || 0;
    return {
      ok: true,
      url: urlValue,
      br: typeof br === 'number' ? br : 0,
      size: (data as Record<string, any>).size
    };
  } finally {
    inFlight -= 1;
    if (inFlight < 0) inFlight = 0;
  }
};

/** 重置闸（主要用于测试） */
export const gdGuardReset = (): void => {
  inFlight = 0;
  lastStartedAt = 0;
  cooldownUntil = 0;
  failedStreak = 0;
};

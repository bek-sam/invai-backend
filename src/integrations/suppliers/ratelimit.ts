import { redis } from "../../lib/queues";

/*
 * Redis token bucket shared by every API and worker process. `take()` waits until a token is
 * available (S&S allows 60 requests per minute per account).
 */

const SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + (now - ts) * refill_per_ms)
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
else
  wait = math.ceil((1 - tokens) / refill_per_ms)
end
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refill_per_ms) + 1000)
return wait
`;

export async function takeToken(
  key: string,
  opts: { capacity: number; perMs: number },
  maxWaitMs = 30_000,
): Promise<void> {
  const refill = opts.capacity / opts.perMs;
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const wait = Number(
      await redis.eval(SCRIPT, 1, `ratelimit:${key}`, opts.capacity, refill, Date.now()),
    );
    if (wait <= 0) return;
    if (Date.now() + wait > deadline) throw new Error(`rate limit wait exceeded for ${key}`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * In-process imaging stub for the QA fairness tests (T-43-3): one global QA slot, a configurable
 * delay, 429 + Retry-After when the slot is busy, exactly like imaging with IMAGING_MAX_QA_JOBS=1.
 * Listens on 127.0.0.1:0 only; nothing here reaches the real imaging service.
 */
export type QaStub = {
  url: string;
  /** Slot busy right now. */
  busy: boolean;
  delayMs: number;
  retryAfterSec: number;
  /** Requests that got a QA answer / got 429, per path. */
  served: number;
  refused: number;
  calls: Record<string, number>;
  /** Issues returned for a file key containing the given text. */
  issues: { when: string; list: unknown[] }[];
  /** One entry per upcoming /qa/check: true = answer 429, false = serve (then it runs dry). */
  script: boolean[];
  /** The next n /qa/check answers are 500 (after the script is used up). */
  failNext: number;
  /** Hold the slot for ms without a request (a foreign shop's long check). */
  hold(ms: number): void;
  close(): Promise<void>;
};

export async function startQaStub(): Promise<QaStub> {
  const st: QaStub = {
    url: "",
    busy: false,
    delayMs: 300,
    retryAfterSec: 1,
    served: 0,
    refused: 0,
    calls: {},
    issues: [],
    script: [],
    failNext: 0,
    hold(ms) {
      st.busy = true;
      setTimeout(() => {
        st.busy = false;
      }, ms).unref();
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const json = (res: import("node:http").ServerResponse, code: number, body: unknown, h = {}) => {
    res.writeHead(code, { "content-type": "application/json", ...h });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    const path = req.url ?? "";
    st.calls[path] = (st.calls[path] ?? 0) + 1;
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      if (path === "/health") return json(res, 200, { ok: true });
      if (
        path === "/qa/clean-alpha" ||
        (path === "/qa/check" && (st.busy || st.script.shift() === true))
      ) {
        st.refused++;
        return json(res, 429, { detail: "busy" }, { "retry-after": String(st.retryAfterSec) });
      }
      if (path !== "/qa/check") return json(res, 404, { detail: "no" });
      if (st.failNext > 0) {
        st.failNext--;
        return json(res, 500, { detail: "boom" });
      }
      const key = (JSON.parse(body) as { file_key: string }).file_key;
      st.busy = true;
      st.served++;
      setTimeout(() => {
        st.busy = false;
        json(res, 200, {
          width_px: 3000,
          height_px: 3000,
          has_alpha: true,
          soft_alpha_ratio: 0,
          effective_dpi: 300,
          issues: st.issues.find((i) => key.includes(i.when))?.list ?? [],
        });
      }, st.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  st.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return st;
}

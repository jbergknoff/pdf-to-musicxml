/**
 * Aggregating WebGPU profiler for ORT Web.
 *
 * ORT's built-in profiling (`ort.env.webgpu.profiling.mode = "default"`) logs
 * one line per GPU kernel. Over a full page (~170 tiles × dozens of kernels)
 * that's thousands of unreadable lines. Instead we register an `ondata`
 * callback that sums the GPU time per kernel type, so {@link flushWebGpuProfile}
 * can print a short, ranked table — the answer to "which ops dominate the
 * segmentation time, and how many dispatches each took".
 *
 * The kernel timestamps come from the GPU timestamp-query and are in
 * nanoseconds; some builds hand them back as `bigint`, so we normalize.
 */

/** The slice of ORT's per-kernel profiling record we use. */
interface WebGpuKernelTiming {
  kernelType: string;
  kernelName: string;
  startTime: number | bigint;
  endTime: number | bigint;
}

interface OpTotals {
  count: number;
  totalMs: number;
}

const totalsByOp = new Map<string, OpTotals>();

function toMilliseconds(start: number | bigint, end: number | bigint): number {
  return (Number(end) - Number(start)) / 1e6;
}

/** Accumulate one kernel's GPU time, keyed by op type (e.g. "Conv", "Resize"). */
export function recordWebGpuKernel(timing: WebGpuKernelTiming): void {
  const key = timing.kernelType || timing.kernelName || "unknown";
  const milliseconds = toMilliseconds(timing.startTime, timing.endTime);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return;
  }
  const entry = totalsByOp.get(key) ?? { count: 0, totalMs: 0 };
  entry.count += 1;
  entry.totalMs += milliseconds;
  totalsByOp.set(key, entry);
}

/**
 * Log the accumulated per-op GPU times (sorted, slowest first) and reset, so
 * each run's table stands alone. No-op when nothing was recorded (e.g. the wasm
 * backend, where no WebGPU kernels fire).
 */
export function flushWebGpuProfile(label: string): void {
  if (totalsByOp.size === 0) {
    return;
  }
  const rows = [...totalsByOp.entries()]
    .map(([op, totals]) => ({ op, ...totals }))
    .sort((first, second) => second.totalMs - first.totalMs);
  const grandTotal = rows.reduce((sum, row) => sum + row.totalMs, 0);
  console.info(
    `[omr] ${label}: WebGPU kernel time by op (${Math.round(grandTotal)}ms on GPU across ${rows.length} op types):`,
  );
  for (const row of rows) {
    const share = grandTotal > 0 ? (100 * row.totalMs) / grandTotal : 0;
    console.info(
      `  ${row.op}: ${row.totalMs.toFixed(1)}ms (${share.toFixed(1)}%) over ${row.count} dispatches`,
    );
  }
  totalsByOp.clear();
}

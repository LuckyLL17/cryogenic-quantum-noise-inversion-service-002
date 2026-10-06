import { invariant } from '../errors.ts';
import type { SynchronizedSample, WindowedSeries } from '../types.ts';

function hann(index: number, length: number): number {
  return length <= 1 ? 1 : 0.5 * (1 - Math.cos((2 * Math.PI * index) / (length - 1)));
}

export function buildSeries(samples: SynchronizedSample[], selector: (sample: SynchronizedSample) => number, startNs?: number, endNs?: number): WindowedSeries {
  const selected = samples.filter((sample) => (startNs === undefined || sample.timestampNs >= startNs) && (endNs === undefined || sample.timestampNs < endNs)).sort((a, b) => a.timestampNs - b.timestampNs || a.syncIndex - b.syncIndex);
  invariant(selected.length >= 2, 'INSUFFICIENT_SERIES', 'At least two samples are required for a series');
  const rate = selected.reduce((sum, sample) => sum + sample.sampleRateHz, 0) / selected.length;
  invariant(rate > 0 && Number.isFinite(rate), 'INVALID_SERIES_RATE', 'Series sample rate must be positive');
  const values = selected.map(selector);
  const weights = selected.map((sample) => sample.quality === 'suspect' ? 0.5 : 1 / Math.max(sample.uncertainty, 1e-9));
  const mean = values.reduce((sum, value, index) => sum + value * weights[index], 0) / weights.reduce((a, b) => a + b, 0);
  return { startNs: selected[0].timestampNs, endNs: selected.at(-1)!.timestampNs, sampleRateHz: rate, values: values.map((value) => value - mean), weights };
}

export function splitWindows(series: WindowedSeries, size: number, overlap = 0.5): WindowedSeries[] {
  invariant(Number.isInteger(size) && size >= 8, 'INVALID_WINDOW_SIZE', 'Window size must be an integer of at least 8');
  invariant(overlap >= 0 && overlap < 1, 'INVALID_OVERLAP', 'Window overlap must be in [0, 1)');
  const step = Math.max(1, Math.floor(size * (1 - overlap)));
  const result: WindowedSeries[] = [];
  for (let start = 0; start + size <= series.values.length; start += step) {
    const values = series.values.slice(start, start + size).map((value, index) => value * hann(index, size));
    result.push({ startNs: series.startNs + (start * 1e9) / series.sampleRateHz, endNs: series.startNs + ((start + size) * 1e9) / series.sampleRateHz, sampleRateHz: series.sampleRateHz, values, weights: series.weights.slice(start, start + size) });
  }
  invariant(result.length > 0, 'WINDOW_NOT_FIT', 'Series does not contain a complete analysis window');
  return result;
}

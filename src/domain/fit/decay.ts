import { invariant } from '../errors.ts';
import type { DecayFit, SynchronizedSample } from '../types.ts';

function regression(points: Array<{ x: number; y: number }>): { slope: number; intercept: number; rSquared: number } {
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  const slope = denominator ? points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator : 0;
  const intercept = meanY - slope * meanX;
  const total = points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
  const residual = points.reduce((sum, point) => sum + (point.y - (intercept + slope * point.x)) ** 2, 0);
  return { slope, intercept, rSquared: total ? Math.max(0, 1 - residual / total) : 1 };
}

export function fitExponential(samples: SynchronizedSample[], startNs?: number, endNs?: number): DecayFit {
  const selected = samples.filter((sample) => (startNs === undefined || sample.timestampNs >= startNs) && (endNs === undefined || sample.timestampNs < endNs)).sort((a, b) => a.timestampNs - b.timestampNs);
  const baseline = selected.length ? Math.min(...selected.map((sample) => sample.amplitude)) : 0;
  const points = selected.map((sample) => ({ x: sample.timestampNs, y: sample.amplitude - baseline })).filter((point) => point.y > 1e-12);
  const rejectedPoints = selected.length - points.length;
  if (points.length < 3) return { model: 'exponential', amplitude0: null, timeConstantNs: null, offset: baseline, rSquared: null, usedPoints: points.length, rejectedPoints, confidence: { lowerNs: null, upperNs: null } };
  const fit = regression(points.map((point) => ({ x: point.x, y: Math.log(point.y) })));
  if (!(fit.slope < 0) || !Number.isFinite(fit.slope)) return { model: 'exponential', amplitude0: Math.exp(fit.intercept), timeConstantNs: null, offset: baseline, rSquared: fit.rSquared, usedPoints: points.length, rejectedPoints, confidence: { lowerNs: null, upperNs: null } };
  const timeConstantNs = -1 / fit.slope;
  const relativeError = Math.max(0.05, (1 - fit.rSquared) * 2);
  return { model: 'exponential', amplitude0: Math.exp(fit.intercept), timeConstantNs, offset: baseline, rSquared: fit.rSquared, usedPoints: points.length, rejectedPoints, confidence: { lowerNs: timeConstantNs * (1 - relativeError), upperNs: timeConstantNs * (1 + relativeError) } };
}

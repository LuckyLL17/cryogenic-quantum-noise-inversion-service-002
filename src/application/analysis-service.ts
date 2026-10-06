import { createHash, randomUUID } from 'node:crypto';
import { invariant } from '../domain/errors.ts';
import { applyCalibration } from '../domain/calibration/apply.ts';
import { synchronizeSamples } from '../domain/clock/synchronize.ts';
import { fitExponential } from '../domain/fit/decay.ts';
import { summarizeNoise } from '../domain/noise/classify.ts';
import { buildSeries, splitWindows } from '../domain/signal/window.ts';
import { crossSpectrum, periodogram } from '../domain/signal/spectrum.ts';
import type { AnalysisRequest, AnalysisResult, NoiseSummary, SynchronizedSample } from '../domain/types.ts';

function digest(input: AnalysisRequest): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function mean(values: number[]): number { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function stddev(values: number[], average: number): number { return values.length ? Math.sqrt(mean(values.map((value) => (value - average) ** 2))) : 0; }

function chooseChannel(samples: SynchronizedSample[], channelId?: string): SynchronizedSample[] {
  const channels = [...new Set(samples.map((sample) => sample.channelId))];
  invariant(channels.length > 0, 'NO_CALIBRATED_CHANNELS', 'No calibrated channels are available');
  const selected = channelId ?? channels[0];
  const result = samples.filter((sample) => sample.channelId === selected);
  invariant(result.length >= 2, 'PRIMARY_CHANNEL_TOO_SHORT', 'Primary channel needs at least two calibrated samples', { channelId: selected });
  return result;
}

function pairReference(primary: SynchronizedSample[], samples: SynchronizedSample[], referenceChannelId?: string): SynchronizedSample[] {
  if (!referenceChannelId) return [];
  const references = samples.filter((sample) => sample.channelId === referenceChannelId).sort((a, b) => a.timestampNs - b.timestampNs);
  return primary.map((anchor) => references.reduce<SynchronizedSample | null>((best, candidate) => {
    const distance = Math.abs(candidate.timestampNs - anchor.timestampNs);
    if (distance > 2_000) return best;
    return !best || distance < Math.abs(best.timestampNs - anchor.timestampNs) ? candidate : best;
  }, null)).filter((sample): sample is SynchronizedSample => sample !== null);
}

function analyzeWindow(samples: SynchronizedSample[], request: AnalysisRequest, startNs?: number, endNs?: number): { noise: NoiseSummary; decay: ReturnType<typeof fitExponential> } {
  const series = buildSeries(samples, (sample) => sample.amplitude, startNs, endNs);
  const windows = splitWindows(series, request.analysis?.windowSize ?? Math.min(128, series.values.length), request.analysis?.overlap ?? 0.5);
  const spectrum = periodogram(windows, request.analysis?.maxFrequencyHz ?? Number.POSITIVE_INFINITY);
  return { noise: summarizeNoise(spectrum, null), decay: fitExponential(samples, startNs, endNs) };
}

export function analyzeExperiment(request: AnalysisRequest): AnalysisResult {
  invariant(request.experimentId.length > 0, 'INVALID_EXPERIMENT_ID', 'Experiment id is required');
  const sync = synchronizeSamples(request.samples, request.analysis?.syncToleranceNs ?? 2_000);
  const calibrated = applyCalibration(sync.samples, request.calibrations);
  const primary = chooseChannel(calibrated, request.referenceChannelId);
  const reference = pairReference(primary, calibrated, request.referenceChannelId);
  const windowSize = request.analysis?.windowSize ?? Math.min(128, primary.length);
  const primarySeries = buildSeries(primary, (sample) => sample.amplitude);
  const primaryWindows = splitWindows(primarySeries, windowSize, request.analysis?.overlap ?? 0.5);
  const primarySpectrum = periodogram(primaryWindows, request.analysis?.maxFrequencyHz ?? Number.POSITIVE_INFINITY);
  const referenceSpectrum = reference.length >= windowSize ? periodogram(splitWindows(buildSeries(reference, (sample) => sample.amplitude), windowSize, request.analysis?.overlap ?? 0.5), request.analysis?.maxFrequencyHz ?? Number.POSITIVE_INFINITY) : [];
  const cross = reference.length >= windowSize ? crossSpectrum(primaryWindows, splitWindows(buildSeries(reference, (sample) => sample.amplitude), windowSize, request.analysis?.overlap ?? 0.5), request.analysis?.maxFrequencyHz ?? Number.POSITIVE_INFINITY) : [];
  const coherent = cross.length ? mean(cross.map((bin) => bin.coherence)) : null;
  const noise = summarizeNoise(primarySpectrum, coherent);
  const decay = request.kind === 'noise-only' ? null : fitExponential(primary, request.analysis?.fitStartNs, request.analysis?.fitEndNs);
  const amplitudes = primary.map((sample) => sample.amplitude);
  const phases = primary.map((sample) => sample.phaseRad);
  const scanResults = (request.analysis?.scan ?? []).map((scan) => analyzeWindow(primary.filter((sample) => !scan.channelId || sample.channelId === scan.channelId), request, scan.startNs, scan.endNs)).map((item, index) => ({ label: request.analysis!.scan![index].label, noise: item.noise, decay: item.decay }));
  const calibrationVersions = [...new Set(calibrated.map((sample) => sample.calibrationProfileId))].sort();
  return {
    analysisId: randomUUID(), experimentId: request.experimentId, kind: request.kind, inputDigest: digest(request), calibrationVersions,
    metrics: { sampleCount: calibrated.length, channelCount: new Set(calibrated.map((sample) => sample.channelId)).size, durationNs: sync.samples.at(-1)!.timestampNs - sync.samples[0].timestampNs, triggerCount: sync.triggerCount, droppedSamples: sync.droppedSamples, medianSkewNs: sync.medianSkewNs, amplitudeMean: mean(amplitudes), amplitudeStdDev: stddev(amplitudes, mean(amplitudes)), phaseDriftRad: phases.at(-1)! - phases[0], decay },
    primarySpectrum, crossSpectrum: cross, noise, scanResults, warnings: reference.length && reference.length !== primary.length ? ['Reference channel could not be paired for every primary sample'] : [],
  };
}

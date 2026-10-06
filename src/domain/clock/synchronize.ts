import { DomainError, invariant } from '../errors.ts';
import type { RawSample, SynchronizedSample } from '../types.ts';

export type SyncBatch = { samples: RawSample[]; droppedSamples: number; medianSkewNs: number; triggerCount: number };

function validateSample(sample: RawSample, index: number): void {
  invariant(sample.captureId && sample.experimentId && sample.channelId && sample.triggerId, 'INVALID_SAMPLE_ID', 'Sample identity fields are required', { index });
  invariant(Number.isFinite(sample.timestampNs) && sample.timestampNs >= 0, 'INVALID_SAMPLE_TIME', 'Sample timestamp must be finite and non-negative', { index });
  invariant(Number.isFinite(sample.receivedAtNs) && sample.receivedAtNs >= 0, 'INVALID_RECEIVE_TIME', 'Receive timestamp must be finite and non-negative', { index });
  invariant(Number.isInteger(sample.sequence) && sample.sequence >= 0, 'INVALID_SEQUENCE', 'Sample sequence must be a non-negative integer', { index });
  invariant(Number.isFinite(sample.sampleRateHz) && sample.sampleRateHz > 0, 'INVALID_SAMPLE_RATE', 'Sample rate must be positive', { index });
  invariant(Number.isFinite(sample.i) && Number.isFinite(sample.q), 'INVALID_IQ', 'I/Q values must be finite', { index });
  invariant(sample.quality !== 'invalid', 'INVALID_SAMPLE_QUALITY', 'Invalid samples must be removed before synchronization', { index });
}

export function synchronizeSamples(input: RawSample[], toleranceNs = 2_000): SyncBatch {
  invariant(Array.isArray(input) && input.length > 0, 'EMPTY_SAMPLES', 'At least one sample is required');
  input.forEach(validateSample);
  const byCapture = new Map<string, RawSample>();
  let droppedSamples = 0;
  for (const sample of [...input].sort((a, b) => a.timestampNs - b.timestampNs || a.sequence - b.sequence || a.captureId.localeCompare(b.captureId))) {
    const previous = byCapture.get(sample.captureId);
    if (!previous) {
      byCapture.set(sample.captureId, sample);
      continue;
    }
    const samePayload = previous.channelId === sample.channelId && previous.timestampNs === sample.timestampNs && previous.i === sample.i && previous.q === sample.q;
    if (!samePayload) throw new DomainError('CAPTURE_CONFLICT', 'Capture id contains conflicting payloads', 409, { captureId: sample.captureId });
    droppedSamples += 1;
  }
  const samples = [...byCapture.values()].sort((a, b) => a.timestampNs - b.timestampNs || a.sequence - b.sequence || a.channelId.localeCompare(b.channelId));
  const triggerTimes = new Map<string, number>();
  for (const sample of samples) triggerTimes.set(sample.triggerId, Math.min(triggerTimes.get(sample.triggerId) ?? sample.timestampNs, sample.timestampNs));
  const skews = samples.map((sample) => Math.abs(sample.timestampNs - (triggerTimes.get(sample.triggerId) ?? sample.timestampNs))).filter((value) => value <= toleranceNs).sort((a, b) => a - b);
  const medianSkewNs = skews.length ? skews[Math.floor(skews.length / 2)] : 0;
  return { samples, droppedSamples, medianSkewNs, triggerCount: triggerTimes.size };
}

export function alignChannels(samples: SynchronizedSample[], toleranceNs = 2_000): Map<string, SynchronizedSample[]> {
  const byChannel = new Map<string, SynchronizedSample[]>();
  for (const sample of samples) byChannel.set(sample.channelId, [...(byChannel.get(sample.channelId) ?? []), sample]);
  for (const channel of byChannel.values()) channel.sort((a, b) => a.timestampNs - b.timestampNs || a.syncIndex - b.syncIndex);
  const anchors = [...samples].sort((a, b) => a.timestampNs - b.timestampNs || a.syncIndex - b.syncIndex);
  const aligned = new Map<string, SynchronizedSample[]>();
  for (const anchor of anchors) {
    const candidateChannels = [...byChannel.entries()];
    for (const [channelId, channelSamples] of candidateChannels) {
      const nearest = channelSamples.reduce<SynchronizedSample | null>((best, item) => {
        const distance = Math.abs(item.timestampNs - anchor.timestampNs);
        if (distance > toleranceNs || item.syncIndex === anchor.syncIndex) return best;
        return !best || distance < Math.abs(best.timestampNs - anchor.timestampNs) ? item : best;
      }, null);
      if (nearest) aligned.set(`${anchor.syncIndex}:${channelId}`, [anchor, nearest]);
    }
  }
  return aligned;
}

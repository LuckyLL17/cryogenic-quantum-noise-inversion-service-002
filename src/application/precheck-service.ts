import { invariant } from '../domain/errors.ts';
import type { AnalysisRequest, CalibrationProfile, PrecheckCategory, PrecheckChannelSummary, PrecheckIssue, PrecheckReport, PrecheckVerdict, RawSample } from '../domain/types.ts';

const UNKNOWN_CHANNEL = '(unknown)';
const CATEGORY_ORDER: PrecheckCategory[] = ['calibration-missing', 'role-mismatch', 'validity-overlap', 'temperature-correction-invalid', 'invalid-sample'];

type CoverageProblem = { category: PrecheckCategory; detail: string; profileIds?: string[] };
type Coverage = { usable: boolean; problems: CoverageProblem[] };
type IssueBucket = { category: PrecheckCategory; channelId: string; count: number; startNs: number | null; endNs: number | null; details: Set<string>; profileIds: Set<string> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateSample(sample: unknown): string[] {
  if (!isRecord(sample)) return ['sample must be an object'];
  const candidate = sample as RawSample;
  const problems: string[] = [];
  if (!candidate.captureId || !candidate.experimentId || !candidate.channelId || !candidate.triggerId) problems.push('identity fields captureId, experimentId, channelId and triggerId are required');
  if (!Number.isFinite(candidate.timestampNs) || candidate.timestampNs < 0) problems.push('timestampNs must be finite and non-negative');
  if (!Number.isFinite(candidate.receivedAtNs) || candidate.receivedAtNs < 0) problems.push('receivedAtNs must be finite and non-negative');
  if (!Number.isInteger(candidate.sequence) || candidate.sequence < 0) problems.push('sequence must be a non-negative integer');
  if (!Number.isFinite(candidate.sampleRateHz) || candidate.sampleRateHz <= 0) problems.push('sampleRateHz must be positive');
  if (!Number.isFinite(candidate.i) || !Number.isFinite(candidate.q)) problems.push('i and q must be finite');
  if (candidate.quality === 'invalid') problems.push('quality is marked invalid');
  return problems;
}

function coversTime(profile: CalibrationProfile, timestampNs: number): boolean {
  return timestampNs >= profile.validFromNs && (profile.validToNs === undefined || timestampNs < profile.validToNs);
}

function evaluateCoverage(sample: RawSample, profiles: CalibrationProfile[]): Coverage {
  const timed = profiles.filter((profile) => profile.channelId === sample.channelId && coversTime(profile, sample.timestampNs));
  if (!timed.length) return { usable: false, problems: [{ category: 'calibration-missing', detail: 'no calibration profile covers this channel and timestamp' }] };
  const roleMatched = timed.filter((profile) => !profile.role || profile.role === sample.role);
  if (!roleMatched.length) {
    const roles = [...new Set(timed.map((profile) => profile.role ?? '(any)'))].sort();
    return { usable: false, problems: [{ category: 'role-mismatch', detail: `sample role ${sample.role} does not match calibration roles ${roles.join(', ')}`, profileIds: timed.map((profile) => profile.profileId).sort() }] };
  }
  const specific = roleMatched.filter((profile) => profile.role);
  const best = specific.length ? specific : roleMatched;
  const bestIds = [...new Set(best.map((profile) => profile.profileId))].sort();
  const problems: CoverageProblem[] = [];
  if (bestIds.length > 1) problems.push({ category: 'validity-overlap', detail: `calibration profiles ${bestIds.join(', ')} have overlapping validity ranges`, profileIds: bestIds });
  const chosen = [...best].sort((a, b) => b.validFromNs - a.validFromNs || b.profileId.localeCompare(a.profileId))[0];
  const temperature = sample.temperatureK ?? chosen.referenceTemperatureK;
  const thermalScale = 1 + chosen.temperatureCoefficientPerK * (temperature - chosen.referenceTemperatureK);
  if (!(chosen.referenceTemperatureK > 0) || !Number.isFinite(temperature) || !Number.isFinite(thermalScale) || thermalScale <= 0) {
    problems.push({ category: 'temperature-correction-invalid', detail: `temperature correction from profile ${chosen.profileId} is not positive and finite`, profileIds: [chosen.profileId] });
    return { usable: false, problems };
  }
  return { usable: true, problems };
}

export function precheckExperiment(request: AnalysisRequest): PrecheckReport {
  invariant(isRecord(request), 'INVALID_REQUEST', 'Precheck request must be an object');
  invariant(typeof request.experimentId === 'string' && request.experimentId.length > 0, 'INVALID_EXPERIMENT_ID', 'Experiment id is required');
  invariant(Array.isArray(request.samples), 'INVALID_SAMPLES', 'Samples must be an array');
  invariant(Array.isArray(request.calibrations), 'INVALID_CALIBRATIONS', 'Calibration profiles must be an array');

  const issueBuckets = new Map<string, IssueBucket>();
  const channelBuckets = new Map<string, PrecheckChannelSummary>();
  let validSamples = 0;
  let invalidSamples = 0;
  let usableSamples = 0;

  const recordIssue = (category: PrecheckCategory, channelId: string, timestampNs: number | null, detail: string, profileIds?: string[]): void => {
    const key = `${category} ${channelId}`;
    const bucket = issueBuckets.get(key) ?? { category, channelId, count: 0, startNs: null, endNs: null, details: new Set<string>(), profileIds: new Set<string>() };
    issueBuckets.set(key, bucket);
    bucket.count += 1;
    if (timestampNs !== null) {
      bucket.startNs = bucket.startNs === null ? timestampNs : Math.min(bucket.startNs, timestampNs);
      bucket.endNs = bucket.endNs === null ? timestampNs : Math.max(bucket.endNs, timestampNs);
    }
    bucket.details.add(detail);
    profileIds?.forEach((id) => bucket.profileIds.add(id));
  };

  for (const sample of request.samples) {
    const candidate = isRecord(sample) ? (sample as RawSample) : null;
    const channelId = candidate && typeof candidate.channelId === 'string' && candidate.channelId ? candidate.channelId : UNKNOWN_CHANNEL;
    const timestampNs = candidate && Number.isFinite(candidate.timestampNs) ? candidate.timestampNs : null;
    const channel = channelBuckets.get(channelId) ?? { channelId, totalSamples: 0, invalidSamples: 0, usableSamples: 0, firstTimestampNs: null, lastTimestampNs: null };
    channelBuckets.set(channelId, channel);
    channel.totalSamples += 1;
    if (timestampNs !== null) {
      channel.firstTimestampNs = channel.firstTimestampNs === null ? timestampNs : Math.min(channel.firstTimestampNs, timestampNs);
      channel.lastTimestampNs = channel.lastTimestampNs === null ? timestampNs : Math.max(channel.lastTimestampNs, timestampNs);
    }
    const problems = validateSample(sample);
    if (problems.length) {
      invalidSamples += 1;
      channel.invalidSamples += 1;
      recordIssue('invalid-sample', channelId, timestampNs, problems.join('; '));
      continue;
    }
    validSamples += 1;
    const coverage = evaluateCoverage(candidate!, request.calibrations);
    for (const problem of coverage.problems) recordIssue(problem.category, channelId, timestampNs, problem.detail, problem.profileIds);
    if (coverage.usable) {
      usableSamples += 1;
      channel.usableSamples += 1;
    }
  }

  const issues: PrecheckIssue[] = [...issueBuckets.values()]
    .map((bucket) => ({ category: bucket.category, channelId: bucket.channelId, startNs: bucket.startNs, endNs: bucket.endNs, sampleCount: bucket.count, detail: [...bucket.details].join('; '), ...(bucket.profileIds.size ? { profileIds: [...bucket.profileIds].sort() } : {}) }))
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.channelId.localeCompare(b.channelId) || (a.startNs ?? 0) - (b.startNs ?? 0));
  const channels = [...channelBuckets.values()].sort((a, b) => a.channelId.localeCompare(b.channelId));
  const maxUsableInChannel = channels.reduce((best, channel) => Math.max(best, channel.usableSamples), 0);
  const verdict: PrecheckVerdict = issues.length === 0 && maxUsableInChannel >= 2 ? 'ready' : maxUsableInChannel >= 2 ? 'fixable' : 'abort';
  const reasons: string[] = [];
  if (verdict === 'ready') reasons.push('every sample is valid and covered by an unambiguous calibration with a valid temperature correction');
  if (verdict === 'fixable') reasons.push(`${usableSamples} of ${request.samples.length} samples remain usable; fix the reported issues before submitting`);
  if (verdict === 'abort') reasons.push('no channel keeps at least two usable samples, so an analysis cannot start');

  return { experimentId: request.experimentId, verdict, issues, channels, totals: { samples: request.samples.length, validSamples, invalidSamples, usableSamples }, reasons };
}
